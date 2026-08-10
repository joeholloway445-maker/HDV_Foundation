/**
 * providers/image_factory.ts — build an ImageProvider from the environment.
 *
 * Mirrors providers/factory.ts exactly. Offline-first by construction: the DEFAULT is always
 * the deterministic StubImageProvider, so with no configuration the system stays fully
 * functional with no network and no API key.
 *
 * Environment variables:
 *   HDV_IMAGE_PROVIDER   = stub | google_ai_studio | colab_tunnel      (default: stub)
 *   HDV_IMAGE_API_KEY    = provider API key / shared secret            (required for google_ai_studio;
 *                                                                        optional for colab_tunnel)
 *   HDV_IMAGE_BASE_URL   = e.g. https://xxxx.ngrok-free.app            (required for colab_tunnel)
 *   HDV_IMAGE_MODEL      = e.g. imagen-3.0-generate-002                (required for google_ai_studio)
 *
 * Resolution order for each setting is: explicit argument -> environment variable -> default.
 */
import { ColabTunnelImageProvider } from './colab_tunnel_image.js';
import { GoogleAiStudioImageProvider } from './google_ai_studio_image.js';
import { StubImageProvider } from './image_stub.js';
import type { ImageProvider, ImageProviderKind } from './image_types.js';

export const ENV_IMAGE_PROVIDER = 'HDV_IMAGE_PROVIDER';
export const ENV_IMAGE_API_KEY = 'HDV_IMAGE_API_KEY';
export const ENV_IMAGE_BASE_URL = 'HDV_IMAGE_BASE_URL';
export const ENV_IMAGE_MODEL = 'HDV_IMAGE_MODEL';

const DEFAULT_GOOGLE_MODEL = 'imagen-3.0-generate-002';

export interface ImageFactoryOptions {
  /** Explicit provider kind (overrides env). */
  kind?: ImageProviderKind;
  /** Explicit base URL (overrides env) for colab_tunnel. */
  baseUrl?: string;
  /** Explicit API key (overrides env). */
  apiKey?: string;
  /** Explicit model (overrides env). */
  model?: string;
  /** Environment source (defaults to process.env). Handy for tests. */
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch (passed through to the HTTP providers). */
  fetchImpl?: typeof fetch;
}

/** Raised when the requested provider kind is not recognized. */
export class UnknownImageProviderError extends Error {
  constructor(kind: string) {
    super(
      `Unknown ${ENV_IMAGE_PROVIDER}=${JSON.stringify(kind)}; expected "stub", "google_ai_studio", or "colab_tunnel".`,
    );
    this.name = 'UnknownImageProviderError';
  }
}

/**
 * Build a provider from explicit options and/or the environment. Never throws for the default
 * (stub) path; only the google_ai_studio / colab_tunnel paths can throw when misconfigured.
 */
export function createImageProvider(options: ImageFactoryOptions = {}): ImageProvider {
  const env = options.env ?? process.env;
  const kind = normalizeKind(options.kind ?? env[ENV_IMAGE_PROVIDER] ?? 'stub');

  if (kind === 'stub') {
    return new StubImageProvider({ model: options.model ?? env[ENV_IMAGE_MODEL] });
  }

  if (kind === 'google_ai_studio') {
    const apiKey = options.apiKey ?? env[ENV_IMAGE_API_KEY];
    if (!apiKey) {
      throw new Error(`${ENV_IMAGE_PROVIDER}=google_ai_studio requires ${ENV_IMAGE_API_KEY}.`);
    }
    const model = options.model ?? env[ENV_IMAGE_MODEL] ?? DEFAULT_GOOGLE_MODEL;
    return new GoogleAiStudioImageProvider({ apiKey, model, fetchImpl: options.fetchImpl });
  }

  if (kind === 'colab_tunnel') {
    const baseUrl = options.baseUrl ?? env[ENV_IMAGE_BASE_URL];
    if (!baseUrl) {
      throw new Error(
        `${ENV_IMAGE_PROVIDER}=colab_tunnel requires ${ENV_IMAGE_BASE_URL} (e.g. an ngrok/Cloudflare Tunnel URL).`,
      );
    }
    return new ColabTunnelImageProvider({
      baseUrl,
      apiKey: options.apiKey ?? env[ENV_IMAGE_API_KEY],
      model: options.model ?? env[ENV_IMAGE_MODEL],
      fetchImpl: options.fetchImpl,
    });
  }

  throw new UnknownImageProviderError(kind);
}

/**
 * Like createImageProvider, but NEVER throws: on any error (including misconfiguration) it
 * falls back to the deterministic StubImageProvider. Use this on offline-first paths where
 * availability matters more than using the configured backend.
 */
export function createImageProviderOrStub(options: ImageFactoryOptions = {}): ImageProvider {
  try {
    return createImageProvider(options);
  } catch {
    return new StubImageProvider({ model: options.model });
  }
}

function normalizeKind(value: string): ImageProviderKind {
  const k = value.trim().toLowerCase();
  if (k === 'stub' || k === 'google_ai_studio' || k === 'colab_tunnel') return k;
  throw new UnknownImageProviderError(value);
}
