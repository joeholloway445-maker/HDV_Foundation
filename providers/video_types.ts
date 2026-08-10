/**
 * providers/video_types.ts — the VideoProvider contract.
 *
 * Sibling seam to image_types.ts (ImageProvider), same design goals. The key difference from
 * images is that this class of model (world/video models like LingBot-World) is
 * image-CONDITIONED: it animates a given seed image rather than creating one from nothing, so
 * `generate` takes a seed image alongside the prompt. Everything else about the contract is
 * identical in spirit to the other provider seams: a pure transducer, no knowledge of agents,
 * packets, routing, KNOLL, or the ledger, and never used to execute or create anything beyond
 * the returned video bytes.
 */

/** Per-call options. */
export interface GenerateVideoOptions {
  /**
   * Compact keyboard-schedule camera/action control, e.g. "w-10,a-10,d-10". Optional — omit
   * for free-form motion with no explicit camera path. See colab/08_scene_server.py for the
   * exact format (mirrors run_playground.py's WASD/IJKL action-string design in lingbot-world).
   */
  actionString?: string;
  /** Output frame count. Provider-specific defaults apply when omitted. */
  frameNum?: number;
  /** Deterministic seed, when the provider supports one. */
  seed?: number;
  /** Abort signal for cancellation / timeouts. Video generation is slow — callers should use a long timeout. */
  signal?: AbortSignal;
}

/** The result of a single video generation. */
export interface VideoResult {
  /** Base64-encoded video bytes (no `data:` prefix). */
  videoBase64: string;
  /** MIME type of the returned bytes, e.g. "video/mp4". */
  mimeType: string;
  /** The model that actually produced the video. */
  model: string;
}

/**
 * The single provider contract. `generate` takes the prompt AND a base64-encoded seed image
 * (no `data:` prefix) — image-to-video is the whole point of this seam.
 */
export interface VideoProvider {
  readonly name: string;
  readonly model: string;
  generate(prompt: string, seedImageBase64: string, opts?: GenerateVideoOptions): Promise<VideoResult>;
}

export type VideoProviderKind = 'stub' | 'colab_tunnel';
