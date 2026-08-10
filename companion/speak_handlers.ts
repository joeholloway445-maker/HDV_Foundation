/**
 * companion/speak_handlers.ts — request handler for companion speech (companion/).
 *
 * Mirrors companion/portrait_handlers.ts / companion/scene_handlers.ts one layer down: a pure-ish
 * function that takes parsed input and returns `{ status, body }`, unit-testable without binding
 * a port. Provider use here is the same pattern as chat/portrait/scene — a pure
 * text-to-speech transducer, dependency-injected, optional, never used to route, execute, or
 * create.
 */
import type { GenerateTtsOptions, TtsProvider } from '../providers/tts_types.js';
import { parseSpeakRequest, SpeakValidationError } from './speak_types.js';

/** Minimal response shape (structurally compatible with the gateway's GatewayResponse). */
export interface SpeakResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface SpeakOptions {
  /** Optional TTS provider (dependency-injected). Omitted ⇒ "unavailable" response, no crash. */
  provider?: TtsProvider;
  generateOptions?: GenerateTtsOptions;
}

/**
 * POST /v1/companion/speak — synthesize speech audio for one line of (already-approved) text.
 * Stateless: the text is sent by the client on every call, exactly like chat.
 */
export async function handleSpeakRequest(body: unknown, options: SpeakOptions = {}): Promise<SpeakResponse> {
  let parsed;
  try {
    parsed = parseSpeakRequest(body);
  } catch (err) {
    if (err instanceof SpeakValidationError) {
      return { status: 400, body: { error: err.message, code: err.code } };
    }
    throw err;
  }

  const { text, voice } = parsed;

  // Same rule as portraits/scenes: the deterministic StubTtsProvider (factory default when
  // HDV_TTS_PROVIDER is unset) is a placeholder CLIP, not a placeholder EXPERIENCE — treat it
  // the same as "no provider" and return a clean "unavailable" response so the frontend can
  // fall back to text-only instead of playing silence.
  if (!options.provider || options.provider.name === 'stub') {
    return {
      status: 200,
      body: { audio: null, source: 'unavailable', model: null },
    };
  }

  try {
    const result = await options.provider.generate(text, {
      ...options.generateOptions,
      voice: voice ?? options.generateOptions?.voice,
    });
    return {
      status: 200,
      body: {
        audio: `data:${result.mimeType};base64,${result.audioBase64}`,
        source: options.provider.name,
        model: result.model,
      },
    };
  } catch (err) {
    return {
      status: 200,
      body: {
        audio: null,
        source: 'unavailable',
        model: null,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
