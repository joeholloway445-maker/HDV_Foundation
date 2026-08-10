/**
 * companion/scene_types.ts — shared vocabulary for companion scenes/loops (companion/).
 *
 * Sibling to companion/portrait_types.ts, one step further: turns an EXISTING seed image (a
 * companion portrait, typically the one POST /v1/companion/portrait already produced) into a
 * short animated video via the injected VideoProvider (providers/video_*.ts) — image+prompt in,
 * video out. Never talks to APEX/KNOLL/HOPE/DREAM/VISION.
 *
 * Same HARD SAFETY FLOOR as portraits, enforced here independent of provider: persona.age must
 * be >= 18 or the request is rejected with 400 before any provider is ever called.
 */
import { COMPANION_PERSONALITIES, type CompanionPersonality } from './types.js';

export interface ScenePersona {
  name: string;
  personality: CompanionPersonality;
  backstory?: string;
  /** Required. Must be >= 18 — see the module-level safety floor note above. */
  age: number;
}

export interface SceneRequestInput {
  persona: unknown;
  /** Base64 image bytes, or a `data:<mime>;base64,<bytes>` URI (the prefix is stripped). */
  seedImage: unknown;
  /**
   * Optional compact keyboard-schedule camera control, e.g. "w-10,a-10,d-10". See
   * colab/08_scene_server.py for the format. Omit for free-form motion.
   */
  actionString?: unknown;
}

/** Thrown for malformed input or an under-18 persona; callers map this to a 400. */
export class SceneValidationError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid_scene_request') {
    super(message);
    this.name = 'SceneValidationError';
    this.code = code;
  }
}

const MAX_NAME_CHARS = 80;
const MAX_BACKSTORY_CHARS = 2000;
const MAX_ACTION_STRING_CHARS = 400;
const MIN_ADULT_AGE = 18;
// A base64 image is at minimum a few dozen bytes; this just catches obviously-empty/garbage
// input early. Real size limits belong at the HTTP layer (body size caps), not here.
const MIN_SEED_IMAGE_CHARS = 64;
const MAX_SEED_IMAGE_CHARS = 15_000_000; // ~11MB decoded — generous for a single portrait frame

/** Parse + validate a raw body into a typed persona/seedImage/actionString triple. */
export function parseSceneRequest(body: unknown): {
  persona: ScenePersona;
  seedImage: string;
  actionString?: string;
} {
  if (body === null || typeof body !== 'object') {
    throw new SceneValidationError('body must be JSON with "persona" and "seedImage"');
  }
  const b = body as Record<string, unknown>;

  if (b.persona === null || typeof b.persona !== 'object') {
    throw new SceneValidationError('"persona" must be an object with at least a "name" and "age"');
  }
  const p = b.persona as Record<string, unknown>;

  const name = typeof p.name === 'string' ? p.name.trim().slice(0, MAX_NAME_CHARS) : '';
  if (!name) {
    throw new SceneValidationError('"persona.name" must be a non-empty string');
  }

  const age = typeof p.age === 'number' ? p.age : Number(p.age);
  if (!Number.isFinite(age) || !Number.isInteger(age)) {
    throw new SceneValidationError('"persona.age" must be a whole number');
  }
  if (age < MIN_ADULT_AGE) {
    throw new SceneValidationError(
      `scene generation requires an adult persona (age >= ${MIN_ADULT_AGE})`,
      'persona_not_adult',
    );
  }

  const personality = normalisePersonality(p.personality);
  const backstory =
    typeof p.backstory === 'string' && p.backstory.trim()
      ? p.backstory.trim().slice(0, MAX_BACKSTORY_CHARS)
      : undefined;

  const seedImage = normaliseSeedImage(b.seedImage);

  let actionString: string | undefined;
  if (b.actionString !== undefined && b.actionString !== null) {
    if (typeof b.actionString !== 'string') {
      throw new SceneValidationError('"actionString" must be a string when provided');
    }
    const trimmed = b.actionString.trim().slice(0, MAX_ACTION_STRING_CHARS);
    if (trimmed) actionString = trimmed;
  }

  return { persona: { name, personality, backstory, age }, seedImage, actionString };
}

function normalisePersonality(value: unknown): CompanionPersonality {
  if (typeof value === 'string' && (COMPANION_PERSONALITIES as readonly string[]).includes(value)) {
    return value as CompanionPersonality;
  }
  return 'playful';
}

/** Accepts either raw base64 or a `data:...;base64,` URI; always returns raw base64. */
function normaliseSeedImage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SceneValidationError('"seedImage" must be a non-empty base64 string or data URI');
  }
  const trimmed = value.trim();
  const dataUriMatch = /^data:[^;]+;base64,(.+)$/s.exec(trimmed);
  const raw = dataUriMatch ? dataUriMatch[1] : trimmed;
  if (raw.length < MIN_SEED_IMAGE_CHARS) {
    throw new SceneValidationError('"seedImage" is too short to be a real image');
  }
  if (raw.length > MAX_SEED_IMAGE_CHARS) {
    throw new SceneValidationError('"seedImage" exceeds the maximum accepted size');
  }
  return raw;
}
