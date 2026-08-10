/**
 * providers/index.ts — public surface of the optional LLM provider package.
 *
 * Everything here is a pure text transducer (prompt -> text). Providers know nothing about
 * agents, routing, KNOLL, or the ledger, and must never be used to execute or create in the
 * matrix. The default is always the deterministic, offline StubProvider.
 */
export type {
  LlmProvider,
  CompleteOptions,
  CompletionResult,
  LlmUsage,
  ProviderKind,
} from './types.js';
export { emptyUsage } from './types.js';

export { StubProvider } from './stub.js';
export type { StubProviderOptions } from './stub.js';

export { OpenAiCompatibleProvider, OpenAiCompatibleError } from './openai_compatible.js';
export type { OpenAiCompatibleOptions } from './openai_compatible.js';

export {
  createProvider,
  createProviderOrStub,
  UnknownProviderError,
  ENV_PROVIDER,
  ENV_BASE_URL,
  ENV_API_KEY,
  ENV_MODEL,
} from './factory.js';
export type { FactoryOptions } from './factory.js';

export { redactSecret, redactFrom, REDACTED } from './redact.js';

// --- Image providers (sibling seam: prompt -> image, same offline-first rules) -------------
export type {
  ImageProvider,
  GenerateImageOptions,
  ImageResult,
  ImageProviderKind,
} from './image_types.js';

export { StubImageProvider } from './image_stub.js';
export type { StubImageProviderOptions } from './image_stub.js';

export { GoogleAiStudioImageProvider, GoogleAiStudioImageError } from './google_ai_studio_image.js';
export type { GoogleAiStudioImageOptions } from './google_ai_studio_image.js';

export { ColabTunnelImageProvider, ColabTunnelImageError } from './colab_tunnel_image.js';
export type { ColabTunnelImageOptions } from './colab_tunnel_image.js';

export {
  createImageProvider,
  createImageProviderOrStub,
  UnknownImageProviderError,
  ENV_IMAGE_PROVIDER,
  ENV_IMAGE_API_KEY,
  ENV_IMAGE_BASE_URL,
  ENV_IMAGE_MODEL,
} from './image_factory.js';
export type { ImageFactoryOptions } from './image_factory.js';

// --- Video providers (sibling seam: prompt + seed image -> video, e.g. LingBot-World) -------
export type {
  VideoProvider,
  GenerateVideoOptions,
  VideoResult,
  VideoProviderKind,
} from './video_types.js';

export { StubVideoProvider } from './video_stub.js';
export type { StubVideoProviderOptions } from './video_stub.js';

export { ColabTunnelVideoProvider, ColabTunnelVideoError } from './colab_tunnel_video.js';
export type { ColabTunnelVideoOptions } from './colab_tunnel_video.js';

export {
  createVideoProvider,
  createVideoProviderOrStub,
  UnknownVideoProviderError,
  ENV_VIDEO_PROVIDER,
  ENV_VIDEO_API_KEY,
  ENV_VIDEO_BASE_URL,
  ENV_VIDEO_MODEL,
} from './video_factory.js';
export type { VideoFactoryOptions } from './video_factory.js';
