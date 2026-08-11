/**
 * providers/tts_types.ts — the TtsProvider contract.
 *
 * Sibling seam to image_types.ts / video_types.ts, same design goals: a thin, dependency-free,
 * OPTIONAL seam so higher layers (companion/speak_handlers.ts) can turn already-approved chat
 * text into spoken audio — never behavior. A TTS provider has no knowledge of agents, packets,
 * routing, KNOLL, or the ledger, and MUST never be used to execute or create anything in the
 * system beyond the audio bytes it returns.
 *
 * Design goals:
 *   - Offline-first: the DEFAULT provider (StubTtsProvider) always works with no network.
 *   - No hard SDK dependency: HTTP providers use the global `fetch`, not vendor SDKs.
 *   - Minimal surface: one method, `generate(text, opts) -> TtsResult`.
 *   - Provider-agnostic: callers never know or care whether the audio came from a hosted API or
 *     a self-hosted model behind a tunnel/sidecar. Swapping the env var is the only change
 *     needed.
 */

/** Per-call options. All optional; providers pick sensible defaults. */
export interface GenerateTtsOptions {
  /** Named voice to use, when the provider ships more than one (e.g. Kokoro-82M's voice packs). */
  voice?: string;
  /** Playback speed multiplier (1.0 = normal), when the provider supports one. */
  speed?: number;
  /** Abort signal for cancellation / timeouts. */
  signal?: AbortSignal;
}

/** The result of a single speech synthesis call. */
export interface TtsResult {
  /** Base64-encoded audio bytes (no `data:` prefix — callers add that if needed). */
  audioBase64: string;
  /** MIME type of the returned bytes: "audio/wav" or "audio/mpeg", depending on what the
   *  backing server returns. Both are supported by every provider in this seam; a caller that
   *  needs one specific format should check this field rather than assume one. */
  mimeType: string;
  /** The model that actually produced the audio. */
  model: string;
}

/**
 * The single provider contract. Implementations are pure text-to-speech transducers: text in,
 * audio bytes out. They perform NO tool use, routing, or side effects on the matrix.
 */
export interface TtsProvider {
  /** Stable, human-readable identifier for the provider implementation. */
  readonly name: string;
  /** The default model this provider will use when a call does not override it. */
  readonly model: string;
  /** Turn text into speech. Must reject (throw) on transport / API errors. */
  generate(text: string, opts?: GenerateTtsOptions): Promise<TtsResult>;
}

/** Recognized provider selector values for the env-driven factory. */
export type TtsProviderKind = 'stub' | 'kokoro_tunnel';
