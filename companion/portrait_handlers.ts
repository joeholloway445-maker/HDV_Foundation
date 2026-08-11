/**
 * companion/portrait_handlers.ts — request handler for companion portraits (companion/).
 *
 * Mirrors companion/handlers.ts (chat): a pure-ish function that takes parsed input and
 * returns `{ status, body }`, unit-testable without binding a port. Provider use here is the
 * same pattern as chat and hope/enricher.ts — a pure prompt-to-image transducer,
 * dependency-injected, optional, never used to route, execute, or create.
 */
import type { GenerateImageOptions, ImageProvider } from '../providers/image_types.js';
import type { CreatorPersonaRepository, LikenessUsageEventRepository } from '../persistence/repositories.js';
import { recordLikenessUsage } from '../creator/handlers.js';
import {
  parsePortraitRequest,
  PortraitValidationError,
  type PortraitPersona,
} from './portrait_types.js';

/** Minimal response shape (structurally compatible with the gateway's GatewayResponse). */
export interface PortraitResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface PortraitOptions {
  /** Optional image provider (dependency-injected). Omitted ⇒ "unavailable" response, no crash. */
  provider?: ImageProvider;
  generateOptions?: GenerateImageOptions;
  /**
   * Optional creator-marketplace usage-attribution wiring (creator/). When BOTH are provided
   * AND `persona.personaId` matches a creator-submitted CreatorPersona, a successful real-
   * provider portrait generation is recorded in the background as a small billable
   * LikenessUsageEvent (creator/handlers.ts's recordLikenessUsage). Fire-and-forget: never adds
   * latency, never fails the portrait response, and is a clean no-op — exactly today's behavior
   * — whenever either is omitted or personaId isn't creator-owned (the common case).
   */
  creatorPersonaRepository?: CreatorPersonaRepository;
  likenessUsageRepository?: LikenessUsageEventRepository;
}

function buildPrompt(persona: PortraitPersona): string {
  const lines = [
    `Character portrait of an adult (age ${persona.age}) fictional character named ${persona.name}.`,
    `Visual style: ${persona.style}.`,
    `Personality to convey through expression and mood: ${persona.personality}.`,
  ];
  if (persona.appearance) lines.push(`Physical appearance: ${persona.appearance}.`);
  if (persona.backstory) lines.push(`Character background: ${persona.backstory}`);
  lines.push('The subject is clearly an adult. Do not depict a minor or anyone who appears underage.');
  return lines.join(' ');
}

/**
 * POST /v1/companion/portrait — generate one portrait image for a companion persona.
 * Stateless: the full persona is sent by the client on every call, exactly like chat.
 */
export async function handlePortraitRequest(
  body: unknown,
  options: PortraitOptions = {},
): Promise<PortraitResponse> {
  let parsed;
  try {
    parsed = parsePortraitRequest(body);
  } catch (err) {
    if (err instanceof PortraitValidationError) {
      return { status: 400, body: { error: err.message, code: err.code } };
    }
    throw err;
  }

  const { persona } = parsed;

  // The deterministic StubImageProvider (factory default when HDV_IMAGE_PROVIDER is unset) is a
  // placeholder pixel, not a placeholder experience — treat it the same as "no provider" and
  // return a clean "unavailable" response so the frontend can show its own avatar/initial
  // fallback instead of a meaningless solid-color square.
  if (!options.provider || options.provider.name === 'stub') {
    return {
      status: 200,
      body: { image: null, source: 'unavailable', model: null },
    };
  }

  try {
    const result = await options.provider.generate(buildPrompt(persona), {
      ...options.generateOptions,
      style: persona.style,
      personaId: persona.personaId,
    });
    // Fire-and-forget: attribute this real generation to a creator persona in the background —
    // see PortraitOptions's doc comment above. No-ops cleanly if personaId isn't creator-owned.
    recordLikenessUsage(persona.personaId, 'portrait_generated', {
      creatorPersonaRepository: options.creatorPersonaRepository,
      likenessUsageRepository: options.likenessUsageRepository,
    });
    return {
      status: 200,
      body: {
        image: `data:${result.mimeType};base64,${result.imageBase64}`,
        source: options.provider.name,
        model: result.model,
      },
    };
  } catch (err) {
    return {
      status: 200,
      body: {
        image: null,
        source: 'unavailable',
        model: null,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
