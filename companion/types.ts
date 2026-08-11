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
 * Chat is stateless BY DEFAULT and remains so unless the client opts in. An optional
 * `companionId` (see parseCompanionChatInput below and companion/memory.ts) lets a client mark
 * "this is the same saved companion as last time" so the handler can layer a small persistent
 * relationship memory on top — still never touching APEX/KNOLL/routing.
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
  /**
   * How explicit/raunchy replies may get. 1 (sweet/PG) .. 5 (maximally explicit). Defaults to 3.
   * A content-rating dial, independent of `adherence` — see companion/handlers.ts's
   * INTENSITY_GUIDANCE for the exact wording each level maps to.
   */
  intensity?: number;
  /**
   * How strictly replies must stick to personality/backstory vs. improvising freely. 1 (loose,
   * playful improvisation) .. 5 (strict, never deviate from the character sheet). Defaults to 3.
   * Also drives the LLM sampling temperature (loose ⇒ higher temperature) — see
   * companion/handlers.ts's temperatureForAdherence.
   */
  adherence?: number;
}

/** Raw request body shape (from FuckLike/web/app.js). Only `persona.name` + `message` required. */
export interface CompanionChatInput {
  persona: unknown;
  history?: unknown;
  message: unknown;
  /**
   * Optional, ENTIRELY OPT-IN client-supplied stable identifier for "which saved companion is
   * this" — see companion/memory.ts. Deliberately NOT a field on CompanionPersona: it isn't a
   * character trait, and there is no user-account system yet, so this is just an opaque,
   * client-generated id (not a real user id). Absent ⇒ chat behaves exactly as it always has
   * (fully stateless, no memory lookup/update).
   */
  companionId?: unknown;
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

/** Exported so sibling companion surfaces (e.g. speak_types.ts) reuse the exact same cap. */
export const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_TURNS = 20;
const MAX_NAME_CHARS = 80;
const MAX_BACKSTORY_CHARS = 2000;
const MIN_ADULT_AGE = 18;
const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DEFAULT_SCALE = 3;
const MAX_COMPANION_ID_CHARS = 128;
/** Opaque client-generated id: letters, digits, underscore, hyphen only ("alphanumeric-ish"). */
const COMPANION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Parse + validate a raw body into a typed persona/history/message triple. */
export function parseCompanionChatInput(body: unknown): {
  persona: CompanionPersona;
  history: CompanionChatMessage[];
  message: string;
  /** Absent ⇒ no companionId was supplied (the default, fully stateless path). */
  companionId?: string;
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
  const intensity = normaliseScale(p.intensity);
  const adherence = normaliseScale(p.adherence);

  const history = normaliseHistory(b.history);
  const companionId = normaliseCompanionId(b.companionId);

  return { persona: { name, personality, backstory, age, intensity, adherence }, history, message, companionId };
}

/**
 * Validate an optional client-supplied companionId. Absent/blank ⇒ undefined (no memory
 * lookup at all — the default, unchanged-behavior path). Present but malformed (too long, or
 * containing characters outside the alphanumeric-ish allow-list) ⇒ a validation error, same as
 * any other malformed field, rather than silently degrading to "no memory" for a client that
 * clearly intended to use one.
 */
function normaliseCompanionId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new CompanionChatValidationError('"companionId" must be a string', 'invalid_companion_id');
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_COMPANION_ID_CHARS) {
    throw new CompanionChatValidationError(
      `"companionId" exceeds ${MAX_COMPANION_ID_CHARS} characters`,
      'invalid_companion_id',
    );
  }
  if (!COMPANION_ID_PATTERN.test(trimmed)) {
    throw new CompanionChatValidationError(
      '"companionId" must contain only letters, digits, "_", or "-"',
      'invalid_companion_id',
    );
  }
  return trimmed;
}

/** Clamp to an integer 1-5, defaulting to 3 for anything missing/malformed. Never throws. */
function normaliseScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(n)));
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
