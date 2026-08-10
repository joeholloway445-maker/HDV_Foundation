/**
 * companion/speak_types.ts — shared vocabulary for companion speech (companion/).
 *
 * Sibling to companion/portrait_types.ts / companion/scene_types.ts, but a simpler transducer:
 * unlike portraits/scenes (which generate new visual content ABOUT a character and so carry the
 * 18+ persona floor), speak only converts text the client already has — a line of dialogue
 * already produced/approved by the companion/chat path — into audio. There is no new content
 * being generated about a persona here, so this module intentionally has no persona/age check;
 * the 18+ floor is enforced once, upstream, wherever the text originates (companion/types.ts).
 *
 * The one safety-adjacent control that DOES belong here is a length cap, so the TTS provider
 * (and its self-hosted CPU inference) can never be handed unbounded input. It reuses
 * MAX_MESSAGE_CHARS from companion/types.ts — the same cap already applied to chat messages —
 * rather than inventing a new number.
 */
import { MAX_MESSAGE_CHARS } from './types.js';

export interface SpeakRequestInput {
  text: unknown;
  voice?: unknown;
}

/** Thrown for malformed input; callers map this to a 400. */
export class SpeakValidationError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid_speak_request') {
    super(message);
    this.name = 'SpeakValidationError';
    this.code = code;
  }
}

const MAX_VOICE_CHARS = 80;

/** Parse + validate a raw body into typed text/voice, enforcing the shared message length cap. */
export function parseSpeakRequest(body: unknown): { text: string; voice?: string } {
  if (body === null || typeof body !== 'object') {
    throw new SpeakValidationError('body must be JSON with a "text" string');
  }
  const b = body as Record<string, unknown>;

  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) {
    throw new SpeakValidationError('"text" must be a non-empty string');
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new SpeakValidationError(`"text" exceeds ${MAX_MESSAGE_CHARS} characters`);
  }

  const voice =
    typeof b.voice === 'string' && b.voice.trim() ? b.voice.trim().slice(0, MAX_VOICE_CHARS) : undefined;

  return { text, voice };
}
