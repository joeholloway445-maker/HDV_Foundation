/**
 * companion/handlers.ts — request handler for companion chat (companion/).
 *
 * Mirrors market/handlers.ts: a pure-ish function that takes parsed input and returns
 * `{ status, body }`, unit-testable without binding a port, wired into the gateway's route
 * table with a single line. Owns no transport.
 *
 * Provider use here is the SAME pattern as hope/enricher.ts: a pure text transducer
 * (`complete(prompt) -> { text }`), dependency-injected, optional, and never used to route,
 * execute, or create. The only difference from the enricher is the prompt shape (in-character
 * companion reply vs. one-line intent paraphrase) and the deterministic fallback pool.
 *
 * Persistent memory (companion/memory.ts) is layered on ENTIRELY OPT-IN, gated on the client
 * supplying `companionId` AND a `memoryRepository` being injected (see CompanionChatOptions).
 * With either one missing, behavior is EXACTLY the stateless behavior above — zero change.
 */
import type { CompleteOptions, LlmProvider } from '../providers/types.js';
import type { CompanionMemoryRecord, CompanionMemoryRepository } from '../persistence/repositories.js';
import { buildMemoryContext, defaultCompanionMemory, updateMemoryAfterTurn } from './memory.js';
import {
  parseCompanionChatInput,
  CompanionChatValidationError,
  type CompanionChatMessage,
  type CompanionPersona,
  type CompanionPersonality,
} from './types.js';

/** Minimal response shape (structurally compatible with the gateway's GatewayResponse). */
export interface CompanionResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface CompanionChatOptions {
  /** Optional LLM provider (dependency-injected). Omitted ⇒ deterministic canned replies. */
  provider?: LlmProvider;
  maxTokens?: number;
  temperature?: number;
  /** Max characters kept from the model's reply. Default 600. */
  maxReplyChars?: number;
  /**
   * Optional persistent memory store (dependency-injected, same seam as `provider`). Omitted ⇒
   * no memory lookup/update at all, regardless of whether the request supplies a companionId —
   * chat stays exactly as stateless as it is today. When provided AND the request supplies a
   * companionId, the companion's remembered relationship state is folded into the system
   * prompt and updated after a successful real-provider reply. See companion/memory.ts.
   */
  memoryRepository?: CompanionMemoryRepository;
}

/** Deterministic fallback pool, one per personality — used with no provider or on provider failure. */
const FALLBACK_REPLIES: Record<CompanionPersonality, string[]> = {
  playful: [
    "Hehe, you're fun. Keep talking to me.",
    'Oh yeah? Tell me more…',
    'I like that side of you.',
    "You're making me smile already.",
  ],
  romantic: [
    "I've been thinking about you.",
    'That means a lot to me.',
    'Come closer. I want to hear everything.',
    'I feel safe with you.',
  ],
  bratty: ['Make me.', "Is that all you've got?", "You're lucky I like you.", 'Hmm… try harder.'],
  dominant: [
    "Good. That's what I wanted to hear.",
    'Look at me when you say that.',
    "You're doing well. Keep going.",
    'I decide the pace.',
  ],
  soft: [
    "I'm here. Take your time.",
    'You can tell me anything.',
    'That sounds hard. I\'m listening.',
    "Come here. You're safe with me.",
  ],
  mysterious: [
    'Interesting…',
    "There's more to that, isn't there?",
    "I don't give everything away so easily.",
    "You'll figure me out eventually.",
  ],
};

function fallbackReply(persona: CompanionPersona, seed: number): string {
  const pool = FALLBACK_REPLIES[persona.personality] ?? FALLBACK_REPLIES.playful;
  return pool[seed % pool.length];
}

/**
 * How raunchy replies are allowed to get, 1 (sweet/PG) to 5 (maximally explicit). A content
 * dial, independent of `adherence` below — see CompanionPersona.intensity.
 */
const INTENSITY_GUIDANCE: Record<number, string> = {
  1: 'Keep things sweet and PG: light flirting only, nothing explicit or graphic.',
  2: 'Warm and romantic. Tasteful innuendo is fine; keep it non-graphic.',
  3: 'Flirtatious and sensual, moderate spice. Explicit references are fine but not graphically detailed.',
  4: 'Explicit and raunchy when the conversation calls for it. Graphic detail is welcome.',
  5: 'Maximally explicit and unfiltered. Hold nothing back — full graphic detail, never fade to black.',
};

/**
 * How strictly replies must stick to the character sheet, 1 (loose, improvise freely) to 5
 * (strict, treat backstory/personality as a script). Also drives sampling temperature — see
 * temperatureForAdherence. Independent of `intensity` above.
 */
const ADHERENCE_GUIDANCE: Record<number, string> = {
  1: "Feel free to improvise well beyond the backstory — prioritize what's fun and surprising over consistency.",
  2: 'Mostly improvise; the backstory is a loose starting point, not a constraint.',
  3: 'Balance improvisation with the character sheet — stay recognizably yourself while having room to riff.',
  4: 'Stay closely aligned with the stated backstory and personality; avoid contradicting established character traits.',
  5: 'Never deviate from the backstory and personality — treat it as a strict, unbreakable script for who this character is.',
};

/** Loose adherence -> higher temperature (more variable/creative); strict -> lower (more consistent). */
function temperatureForAdherence(adherence: number): number {
  const table: Record<number, number> = { 1: 1.1, 2: 0.95, 3: 0.8, 4: 0.65, 5: 0.5 };
  return table[adherence] ?? 0.8;
}

/**
 * @param memoryContext Optional extra line folded in right after the backstory (see
 *   companion/memory.ts's buildMemoryContext). Absent for the stateless default path — the
 *   prompt is byte-for-byte what it was before memory existed.
 */
function systemPrompt(persona: CompanionPersona, memoryContext?: string): string {
  const intensity = persona.intensity ?? 3;
  const adherence = persona.adherence ?? 3;
  const lines = [
    `You are ${persona.name}, an adult (age ${persona.age}) fictional companion character with a ${persona.personality} personality.`,
    persona.backstory ? `Backstory: ${persona.backstory}` : undefined,
    memoryContext,
    'This is a private, consensual, fictional roleplay between two adults on an 18+ platform. Flirtatious, romantic, and explicit adult content is allowed and expected when it fits the character and conversation — do not deflect, sanitize, or refuse on that basis alone.',
    `Content intensity (${intensity}/5): ${INTENSITY_GUIDANCE[intensity] ?? INTENSITY_GUIDANCE[3]}`,
    `Character adherence (${adherence}/5): ${ADHERENCE_GUIDANCE[adherence] ?? ADHERENCE_GUIDANCE[3]}`,
    'Stay fully in character. Reply as the character speaking directly to the user, in 1-3 short sentences.',
    'Never mention that you are an AI, a model, or a system. Never break character. Never add stage directions or narration outside quotes.',
    'Every character in this roleplay, including yourself, is a consenting adult. Never depict a minor.',
  ].filter(Boolean);
  return lines.join('\n');
}

function buildPrompt(history: CompanionChatMessage[], message: string): string {
  const lines = history.map((turn) => `${turn.role === 'user' ? 'User' : 'You'}: ${turn.text}`);
  lines.push(`User: ${message}`);
  lines.push('You:');
  return lines.join('\n');
}

/** Trim, drop surrounding quotes, collapse whitespace, and cap length. */
function sanitize(text: string, maxChars: number): string {
  let t = text.replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (t.length > maxChars) t = `${t.slice(0, maxChars - 3).trimEnd()}...`;
  return t;
}

/**
 * POST /v1/companion/chat — generate one in-character reply for a companion.
 * Stateless by default: the full persona + trimmed history is sent by the client on every
 * turn. When the request supplies `companionId` AND `options.memoryRepository` is wired in,
 * a small persistent relationship memory (companion/memory.ts) is folded into the system
 * prompt and updated after a successful real-provider reply — see the module doc comment.
 * With either one absent, this function behaves EXACTLY as it did before memory existed.
 */
export async function handleCompanionChat(
  body: unknown,
  options: CompanionChatOptions = {},
): Promise<CompanionResponse> {
  let parsed;
  try {
    parsed = parseCompanionChatInput(body);
  } catch (err) {
    if (err instanceof CompanionChatValidationError) {
      return { status: 400, body: { error: err.message, code: err.code } };
    }
    throw err;
  }
  // parseCompanionChatInput already enforces the 18+ floor (throws persona_not_adult), caught
  // above like any other validation error — nothing further to check here.

  const { persona, history, message, companionId } = parsed;
  const seed = message.length + history.length;

  // Opt-in memory lookup: only when BOTH a companionId was supplied and a repository is
  // injected. Absent either, `memory` stays undefined and every branch below behaves exactly
  // as it did before memory existed (no extra prompt line, no post-turn write).
  const memoryRepository = companionId ? options.memoryRepository : undefined;
  const memory: CompanionMemoryRecord | undefined = memoryRepository
    ? memoryRepository.get(companionId as string) ?? defaultCompanionMemory(companionId as string)
    : undefined;

  // The deterministic StubProvider (the factory default when HDV_LLM_PROVIDER is unset) is a
  // fine placeholder for HOPE's one-line intent paraphrase, but its raw prompt-echo output
  // reads as broken text for a companion reply. Treat it the same as "no provider": use the
  // curated per-personality pool instead — the real upgrade path is HDV_LLM_PROVIDER=openai_compatible
  // (Ollama/BYOK), not the offline stub.
  if (!options.provider || options.provider.name === 'stub') {
    return {
      status: 200,
      body: { reply: fallbackReply(persona, seed), source: 'fallback', model: null },
    };
  }

  const opts: CompleteOptions = {
    system: systemPrompt(persona, memory ? buildMemoryContext(memory) : undefined),
    maxTokens: options.maxTokens ?? 200,
    // An explicit server-side override (options.temperature) always wins; otherwise the
    // persona's adherence dial drives it (loose adherence -> higher/more-creative temperature).
    temperature: options.temperature ?? temperatureForAdherence(persona.adherence ?? 3),
  };

  try {
    const result = await options.provider.complete(buildPrompt(history, message), opts);
    const cleaned = sanitize(result.text, options.maxReplyChars ?? 600);
    if (!cleaned) {
      return {
        status: 200,
        body: { reply: fallbackReply(persona, seed), source: 'fallback', model: null, error: 'provider returned empty text' },
      };
    }
    // Fire-and-forget: a REAL provider reply landed, so update + persist memory in the
    // background. Never awaited — the chat response must not wait on the memory write, and a
    // memory-persistence failure must never surface as a chat failure (caught + logged below).
    if (memory && memoryRepository) {
      void persistMemoryUpdate(memoryRepository, memory, message, cleaned, options.provider);
    }
    return { status: 200, body: { reply: cleaned, source: 'llm', model: result.model } };
  } catch (err) {
    return {
      status: 200,
      body: {
        reply: fallbackReply(persona, seed),
        source: 'fallback',
        model: null,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Background helper: compute the next memory record and upsert it. Errors are caught, logged,
 * and swallowed — memory persistence is best-effort and must never affect the chat response
 * that already went out.
 */
async function persistMemoryUpdate(
  repository: CompanionMemoryRepository,
  memory: CompanionMemoryRecord,
  userMessage: string,
  botReply: string,
  provider: LlmProvider,
): Promise<void> {
  try {
    const updated = await updateMemoryAfterTurn(memory, userMessage, botReply, provider);
    repository.upsert(updated);
  } catch (err) {
    console.error(
      `[companion/memory] failed to persist memory for companionId=${memory.companionId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
