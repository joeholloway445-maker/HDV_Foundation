/**
 * providers/image_types.ts — the ImageProvider contract.
 *
 * Sibling seam to providers/types.ts (LlmProvider), same design goals: a thin, dependency-free,
 * OPTIONAL seam so higher layers (companion/portrait_handlers.ts) can turn a text prompt into
 * an image — never behavior. An image provider has no knowledge of agents, packets, routing,
 * KNOLL, or the ledger, and MUST never be used to execute or create anything in the system
 * beyond the image bytes it returns.
 *
 * Design goals:
 *   - Offline-first: the DEFAULT provider (StubImageProvider) always works with no network.
 *   - No hard SDK dependency: HTTP providers use the global `fetch`, not vendor SDKs.
 *   - Minimal surface: one method, `generate(prompt, opts) -> ImageResult`.
 *   - Provider-agnostic: callers never know or care whether the image came from a hosted API
 *     (Google AI Studio) or a self-hosted model behind a tunnel (Colab). Swapping the env var
 *     is the only change needed.
 */

/** Per-call options. All optional; providers pick sensible defaults. */
export interface GenerateImageOptions {
  /**
   * Free-form visual style hint (e.g. "realistic" | "anime"), passed through from
   * companion/portrait_types.ts's PortraitPersona.style. Providers that host more than one
   * checkpoint (e.g. colab/07_portrait_server.py routing realistic vs. anime personas to
   * different models) use this to pick which one to run; providers with a single fixed model
   * are free to ignore it.
   */
  style?: string;
  /** Things to steer the image away from (not all providers support this). */
  negativePrompt?: string;
  /** Output width in pixels. */
  width?: number;
  /** Output height in pixels. */
  height?: number;
  /** Sampling steps (diffusion-style providers only). */
  steps?: number;
  /** Deterministic seed, when the provider supports one. */
  seed?: number;
  /** Abort signal for cancellation / timeouts. */
  signal?: AbortSignal;
}

/** The result of a single image generation. */
export interface ImageResult {
  /** Base64-encoded image bytes (no `data:` prefix — callers add that if needed). */
  imageBase64: string;
  /** MIME type of the returned bytes, e.g. "image/png". */
  mimeType: string;
  /** The model that actually produced the image. */
  model: string;
}

/**
 * The single provider contract. Implementations are pure image transducers: prompt in, image
 * bytes out. They perform NO tool use, routing, or side effects on the matrix.
 */
export interface ImageProvider {
  /** Stable, human-readable identifier for the provider implementation. */
  readonly name: string;
  /** The default model this provider will use when a call does not override it. */
  readonly model: string;
  /** Turn a prompt into an image. Must reject (throw) on transport / API errors. */
  generate(prompt: string, opts?: GenerateImageOptions): Promise<ImageResult>;
}

/** Recognized provider selector values for the env-driven factory. */
export type ImageProviderKind = 'stub' | 'google_ai_studio' | 'colab_tunnel';
