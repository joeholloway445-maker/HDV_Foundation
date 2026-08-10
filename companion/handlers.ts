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
 */
import type { CompleteOptions, LlmProvider } from '../providers/types.js';
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

function systemPrompt(persona: CompanionPersona): string {
  const lines = [
    `You are ${persona.name}, an adult (age ${persona.age}) fictional companion character with a ${persona.personality} personality.`,
    persona.backstory ? `Backstory: ${persona.backstory}` : undefined,
    'This is a private, consensual, fictional roleplay between two adults on an 18+ platform. Flirtatious, romantic, and explicit adult content is allowed and expected when it fits the character and conversation — do not deflect, sanitize, or refuse on that basis alone.',
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
 * Stateless: the full persona + trimmed history is sent by the client on every turn.
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

  const { persona, history, message } = parsed;
  const seed = message.length + history.length;

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
    system: systemPrompt(persona),
    maxTokens: options.maxTokens ?? 200,
    temperature: options.temperature ?? 0.8,
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
