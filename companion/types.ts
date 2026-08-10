/**
 * companion/types.ts — shared vocabulary for companion chat (companion/).
 *
 * The `companion/` package is a thin PRODUCT surface: it turns a persona + conversation
 * history into a single in-character reply. It is NOT one of the Big 5 agents and holds no
 * routing, security, or execution logic. It NEVER talks to APEX/KNOLL/HOPE/DREAM/VISION,
 * never routes a RoutingPacket, and never spends the APEX ledger — it only calls the same
 * injected LlmProvider text transducer HOPE's enricher uses (hope/enricher.ts), with a
 * companion-flavoured prompt instead of an interpretation one. No provider ⇒ deterministic
 * canned replies, so the endpoint stays fully functional offline.
 *
 * HARD SAFETY FLOOR (not model-dependent, enforced here regardless of which LlmProvider is
 * configured): a chat reply may only be generated for a persona whose stated age is 18 or
 * older. Same floor as companion/portrait_types.ts and companion/scene_types.ts — chat is the
 * one companion surface capable of open-ended (including explicit) text, so this is enforced
 * here too, not just on the image/video endpoints.
 */

/** A single turn in the visible chat transcript. */
export interface CompanionChatMessage {
  role: 'user' | 'bot';
  text: string;
}

/** Personality presets the deterministic fallback and system prompt both key off. */
export type CompanionPersonality =
  | 'playful'
  | 'romantic'
  | 'bratty'
  | 'dominant'
  | 'soft'
  | 'mysterious';

export const COMPANION_PERSONALITIES: readonly CompanionPersonality[] = [
  'playful',
  'romantic',
  'bratty',
  'dominant',
  'soft',
  'mysterious',
] as const;

/** The companion's character sheet, as sent by the client on every turn (stateless server). */
export interface CompanionPersona {
  name: string;
  personality: CompanionPersonality;
  backstory?: string;
  /** Required. Must be >= 18 — see the module-level safety floor note above. */
  age: number;
}

/** Raw request body shape (from FuckLike/web/app.js). Only `persona.name` + `message` required. */
export interface CompanionChatInput {
  persona: unknown;
  history?: unknown;
  message: unknown;
}

/** Thrown for malformed input; callers map this to a 400. */
export class CompanionChatValidationError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid_chat_request') {
    super(message);
    this.name = 'CompanionChatValidationError';
    this.code = code;
  }
}

const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_TURNS = 20;
const MAX_NAME_CHARS = 80;
const MAX_BACKSTORY_CHARS = 2000;
const MIN_ADULT_AGE = 18;

/** Parse + validate a raw body into a typed persona/history/message triple. */
export function parseCompanionChatInput(body: unknown): {
  persona: CompanionPersona;
  history: CompanionChatMessage[];
  message: string;
} {
  if (body === null || typeof body !== 'object') {
    throw new CompanionChatValidationError('body must be JSON with "persona" and "message"');
  }
  const b = body as Record<string, unknown>;

  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (!message) {
    throw new CompanionChatValidationError('"message" must be a non-empty string');
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new CompanionChatValidationError(`"message" exceeds ${MAX_MESSAGE_CHARS} characters`);
  }

  if (b.persona === null || typeof b.persona !== 'object') {
    throw new CompanionChatValidationError('"persona" must be an object with at least a "name"');
  }
  const p = b.persona as Record<string, unknown>;
  const name = typeof p.name === 'string' ? p.name.trim().slice(0, MAX_NAME_CHARS) : '';
  if (!name) {
    throw new CompanionChatValidationError('"persona.name" must be a non-empty string');
  }

  const age = typeof p.age === 'number' ? p.age : Number(p.age);
  if (!Number.isFinite(age) || !Number.isInteger(age)) {
    throw new CompanionChatValidationError('"persona.age" must be a whole number');
  }
  if (age < MIN_ADULT_AGE) {
    throw new CompanionChatValidationError(
      `companion chat requires an adult persona (age >= ${MIN_ADULT_AGE})`,
      'persona_not_adult',
    );
  }

  const personality = normalisePersonality(p.personality);
  const backstory =
    typeof p.backstory === 'string' && p.backstory.trim()
      ? p.backstory.trim().slice(0, MAX_BACKSTORY_CHARS)
      : undefined;

  const history = normaliseHistory(b.history);

  return { persona: { name, personality, backstory, age }, history, message };
}

function normalisePersonality(value: unknown): CompanionPersonality {
  if (typeof value === 'string' && (COMPANION_PERSONALITIES as readonly string[]).includes(value)) {
    return value as CompanionPersonality;
  }
  return 'playful';
}

function normaliseHistory(value: unknown): CompanionChatMessage[] {
  if (!Array.isArray(value)) return [];
  const turns: CompanionChatMessage[] = [];
  for (const raw of value.slice(-MAX_HISTORY_TURNS)) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const role = r.role === 'user' ? 'user' : r.role === 'bot' ? 'bot' : undefined;
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    if (!role || !text) continue;
    turns.push({ role, text: text.slice(0, MAX_MESSAGE_CHARS) });
  }
  return turns;
}
