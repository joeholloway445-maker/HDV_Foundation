/**
 * companion/portrait_types.ts — shared vocabulary for companion portraits (companion/).
 *
 * Sibling to companion/types.ts (chat). Same non-agent, non-routing posture: this never talks
 * to APEX/KNOLL/HOPE/DREAM/VISION, it only turns a persona description into an image via the
 * injected ImageProvider (providers/image_*.ts) — a pure prompt-to-image transducer, same as
 * the chat path's LlmProvider.
 *
 * HARD SAFETY FLOOR (not model-dependent, enforced here regardless of which ImageProvider is
 * configured): a portrait may only be requested for a persona whose stated age is 18 or older.
 * This mirrors the product's existing 18+ gate (FuckLike/web's age gate + the `adult` checkbox
 * on companion creation) at the API layer, so the check holds even if a client is bypassed.
 */
import { COMPANION_PERSONALITIES, type CompanionPersonality } from './types.js';

/** Visual style presets already used by FuckLike/web's gallery/create form. Free-form beyond these. */
export type PortraitStyle = 'realistic' | 'anime' | string;

export interface PortraitPersona {
  name: string;
  style: PortraitStyle;
  personality: CompanionPersonality;
  backstory?: string;
  /** Optional physical-appearance descriptor (hair, build, etc.) folded into the image prompt. */
  appearance?: string;
  /** Required. Must be >= 18 — see the module-level safety floor note above. */
  age: number;
}

export interface PortraitRequestInput {
  persona: unknown;
}

/** Thrown for malformed input or an under-18 persona; callers map this to a 400. */
export class PortraitValidationError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid_portrait_request') {
    super(message);
    this.name = 'PortraitValidationError';
    this.code = code;
  }
}

const MAX_NAME_CHARS = 80;
const MAX_STYLE_CHARS = 40;
const MAX_BACKSTORY_CHARS = 2000;
const MAX_APPEARANCE_CHARS = 400;
const MIN_ADULT_AGE = 18;

/** Parse + validate a raw body into a typed persona, enforcing the 18+ floor. */
export function parsePortraitRequest(body: unknown): { persona: PortraitPersona } {
  if (body === null || typeof body !== 'object') {
    throw new PortraitValidationError('body must be JSON with a "persona" object');
  }
  const b = body as Record<string, unknown>;

  if (b.persona === null || typeof b.persona !== 'object') {
    throw new PortraitValidationError('"persona" must be an object with at least a "name" and "age"');
  }
  const p = b.persona as Record<string, unknown>;

  const name = typeof p.name === 'string' ? p.name.trim().slice(0, MAX_NAME_CHARS) : '';
  if (!name) {
    throw new PortraitValidationError('"persona.name" must be a non-empty string');
  }

  const age = typeof p.age === 'number' ? p.age : Number(p.age);
  if (!Number.isFinite(age) || !Number.isInteger(age)) {
    throw new PortraitValidationError('"persona.age" must be a whole number');
  }
  if (age < MIN_ADULT_AGE) {
    throw new PortraitValidationError(
      `portrait generation requires an adult persona (age >= ${MIN_ADULT_AGE})`,
      'persona_not_adult',
    );
  }

  const style =
    typeof p.style === 'string' && p.style.trim() ? p.style.trim().slice(0, MAX_STYLE_CHARS) : 'realistic';
  const personality = normalisePersonality(p.personality);
  const backstory =
    typeof p.backstory === 'string' && p.backstory.trim()
      ? p.backstory.trim().slice(0, MAX_BACKSTORY_CHARS)
      : undefined;
  const appearance =
    typeof p.appearance === 'string' && p.appearance.trim()
      ? p.appearance.trim().slice(0, MAX_APPEARANCE_CHARS)
      : undefined;

  return { persona: { name, style, personality, backstory, appearance, age } };
}

function normalisePersonality(value: unknown): CompanionPersonality {
  if (typeof value === 'string' && (COMPANION_PERSONALITIES as readonly string[]).includes(value)) {
    return value as CompanionPersonality;
  }
  return 'playful';
}
