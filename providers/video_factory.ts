/**
 * providers/video_factory.ts — build a VideoProvider from the environment.
 *
 * Mirrors providers/image_factory.ts. Offline-first: the DEFAULT is always the deterministic
 * StubVideoProvider.
 *
 * Environment variables:
 *   HDV_VIDEO_PROVIDER   = stub | colab_tunnel        (default: stub)
 *   HDV_VIDEO_API_KEY    = the Colab server's shared-secret token (optional)
 *   HDV_VIDEO_BASE_URL   = e.g. https://xxxx.ngrok-free.app (required for colab_tunnel)
 *   HDV_VIDEO_MODEL      = reported model id override (optional)
 */
import { ColabTunnelVideoProvider } from './colab_tunnel_video.js';
import { StubVideoProvider } from './video_stub.js';
import type { VideoProvider, VideoProviderKind } from './video_types.js';

export const ENV_VIDEO_PROVIDER = 'HDV_VIDEO_PROVIDER';
export const ENV_VIDEO_API_KEY = 'HDV_VIDEO_API_KEY';
export const ENV_VIDEO_BASE_URL = 'HDV_VIDEO_BASE_URL';
export const ENV_VIDEO_MODEL = 'HDV_VIDEO_MODEL';

export interface VideoFactoryOptions {
  kind?: VideoProviderKind;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export class UnknownVideoProviderError extends Error {
  constructor(kind: string) {
    super(`Unknown ${ENV_VIDEO_PROVIDER}=${JSON.stringify(kind)}; expected "stub" or "colab_tunnel".`);
    this.name = 'UnknownVideoProviderError';
  }
}

export function createVideoProvider(options: VideoFactoryOptions = {}): VideoProvider {
  const env = options.env ?? process.env;
  const kind = normalizeKind(options.kind ?? env[ENV_VIDEO_PROVIDER] ?? 'stub');

  if (kind === 'stub') {
    return new StubVideoProvider({ model: options.model ?? env[ENV_VIDEO_MODEL] });
  }

  if (kind === 'colab_tunnel') {
    const baseUrl = options.baseUrl ?? env[ENV_VIDEO_BASE_URL];
    if (!baseUrl) {
      throw new Error(
        `${ENV_VIDEO_PROVIDER}=colab_tunnel requires ${ENV_VIDEO_BASE_URL} (e.g. an ngrok/Cloudflare Tunnel URL).`,
      );
    }
    return new ColabTunnelVideoProvider({
      baseUrl,
      apiKey: options.apiKey ?? env[ENV_VIDEO_API_KEY],
      model: options.model ?? env[ENV_VIDEO_MODEL],
      fetchImpl: options.fetchImpl,
    });
  }

  throw new UnknownVideoProviderError(kind);
}

/** Like createVideoProvider, but NEVER throws: falls back to the stub on any misconfiguration. */
export function createVideoProviderOrStub(options: VideoFactoryOptions = {}): VideoProvider {
  try {
    return createVideoProvider(options);
  } catch {
    return new StubVideoProvider({ model: options.model });
  }
}

function normalizeKind(value: string): VideoProviderKind {
  const k = value.trim().toLowerCase();
  if (k === 'stub' || k === 'colab_tunnel') return k;
  throw new UnknownVideoProviderError(value);
}
