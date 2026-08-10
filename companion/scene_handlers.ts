/**
 * companion/scene_handlers.ts — request handler for companion scenes/loops (companion/).
 *
 * Mirrors companion/portrait_handlers.ts one layer up the stack: image+prompt -> video via the
 * injected VideoProvider, same dependency-injected/optional/never-routes posture.
 *
 * The LingBot camera schedule (actionString) defaults to a personality-derived one
 * (action_string.ts) rather than always being null/free-form when the client omits it — see
 * that module for the LingBot-World action_string format this is built against.
 */
import type { GenerateVideoOptions, VideoProvider } from '../providers/video_types.js';
import { parseSceneRequest, SceneValidationError, type ScenePersona } from './scene_types.js';
import { buildActionString } from './action_string.js';

export interface SceneResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface SceneOptions {
  /** Optional video provider (dependency-injected). Omitted ⇒ "unavailable" response, no crash. */
  provider?: VideoProvider;
  generateOptions?: Omit<GenerateVideoOptions, 'actionString'>;
}

function buildPrompt(persona: ScenePersona): string {
  const lines = [
    `Short looping scene featuring ${persona.name}, an adult (age ${persona.age}) fictional character.`,
    `Personality to convey through subtle motion and mood: ${persona.personality}.`,
  ];
  if (persona.appearance) lines.push(`Physical appearance: ${persona.appearance}.`);
  if (persona.backstory) lines.push(`Character background: ${persona.backstory}`);
  lines.push('Gentle, natural idle motion. The subject is clearly an adult throughout.');
  return lines.join(' ');
}

/**
 * POST /v1/companion/scene — animate an existing companion portrait into a short video.
 * Stateless: the seed image (typically the output of /v1/companion/portrait) and persona are
 * sent by the client on every call.
 */
export async function handleSceneRequest(body: unknown, options: SceneOptions = {}): Promise<SceneResponse> {
  let parsed;
  try {
    parsed = parseSceneRequest(body);
  } catch (err) {
    if (err instanceof SceneValidationError) {
      return { status: 400, body: { error: err.message, code: err.code } };
    }
    throw err;
  }

  const { persona, seedImage, actionString } = parsed;

  // Same rule as portraits: the stub is a placeholder ARTIFACT, not a placeholder EXPERIENCE —
  // treat it as "no provider" so nothing meaningless is ever handed to a client.
  if (!options.provider || options.provider.name === 'stub') {
    return { status: 200, body: { video: null, source: 'unavailable', model: null } };
  }

  // Tie the LingBot action tools to the prompt: a client can still supply an explicit
  // actionString for full manual control, but by default the camera schedule is derived from
  // persona.personality (see action_string.ts) instead of always being null/free-form motion.
  const effectiveActionString = actionString ?? buildActionString(persona.personality);

  try {
    const result = await options.provider.generate(buildPrompt(persona), seedImage, {
      ...options.generateOptions,
      actionString: effectiveActionString,
    });
    return {
      status: 200,
      body: {
        video: `data:${result.mimeType};base64,${result.videoBase64}`,
        source: options.provider.name,
        model: result.model,
      },
    };
  } catch (err) {
    return {
      status: 200,
      body: {
        video: null,
        source: 'unavailable',
        model: null,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
