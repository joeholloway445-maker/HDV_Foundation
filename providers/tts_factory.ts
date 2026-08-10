/**
 * providers/tts_factory.ts — build a TtsProvider from the environment.
 *
 * Mirrors providers/image_factory.ts / providers/video_factory.ts exactly. Offline-first by
 * construction: the DEFAULT is always the deterministic StubTtsProvider, so with no
 * configuration the system stays fully functional with no network and no API key.
 *
 * Environment variables:
 *   HDV_TTS_PROVIDER   = stub | kokoro_tunnel                     (default: stub)
 *   HDV_TTS_API_KEY    = the Kokoro server's shared-secret token  (optional)
 *   HDV_TTS_BASE_URL   = e.g. http://kokoro-tts:8880              (required for kokoro_tunnel)
 *   HDV_TTS_MODEL      = reported model id override                (optional)
 *   HDV_TTS_VOICE      = default named voice (e.g. "af_bella")     (optional)
 *
 * Resolution order for each setting is: explicit argument -> environment variable -> default.
 */
import { KokoroTunnelTtsProvider } from './kokoro_tunnel_tts.js';
import { StubTtsProvider } from './tts_stub.js';
import type { TtsProvider, TtsProviderKind } from './tts_types.js';

export const ENV_TTS_PROVIDER = 'HDV_TTS_PROVIDER';
export const ENV_TTS_API_KEY = 'HDV_TTS_API_KEY';
export const ENV_TTS_BASE_URL = 'HDV_TTS_BASE_URL';
export const ENV_TTS_MODEL = 'HDV_TTS_MODEL';
export const ENV_TTS_VOICE = 'HDV_TTS_VOICE';

export interface TtsFactoryOptions {
  /** Explicit provider kind (overrides env). */
  kind?: TtsProviderKind;
  /** Explicit base URL (overrides env) for kokoro_tunnel. */
  baseUrl?: string;
  /** Explicit API key (overrides env). */
  apiKey?: string;
  /** Explicit model (overrides env). */
  model?: string;
  /** Explicit default voice (overrides env). */
  voice?: string;
  /** Environment source (defaults to process.env). Handy for tests. */
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch (passed through to the HTTP provider). */
  fetchImpl?: typeof fetch;
}

/** Raised when the requested provider kind is not recognized. */
export class UnknownTtsProviderError extends Error {
  constructor(kind: string) {
    super(`Unknown ${ENV_TTS_PROVIDER}=${JSON.stringify(kind)}; expected "stub" or "kokoro_tunnel".`);
    this.name = 'UnknownTtsProviderError';
  }
}

/**
 * Build a provider from explicit options and/or the environment. Never throws for the default
 * (stub) path; only the kokoro_tunnel path can throw when misconfigured.
 */
export function createTtsProvider(options: TtsFactoryOptions = {}): TtsProvider {
  const env = options.env ?? process.env;
  const kind = normalizeKind(options.kind ?? env[ENV_TTS_PROVIDER] ?? 'stub');

  if (kind === 'stub') {
    return new StubTtsProvider({ model: options.model ?? env[ENV_TTS_MODEL] });
  }

  if (kind === 'kokoro_tunnel') {
    const baseUrl = options.baseUrl ?? env[ENV_TTS_BASE_URL];
    if (!baseUrl) {
      throw new Error(
        `${ENV_TTS_PROVIDER}=kokoro_tunnel requires ${ENV_TTS_BASE_URL} (e.g. http://kokoro-tts:8880, or an ngrok/Cloudflare Tunnel URL).`,
      );
    }
    return new KokoroTunnelTtsProvider({
      baseUrl,
      apiKey: options.apiKey ?? env[ENV_TTS_API_KEY],
      model: options.model ?? env[ENV_TTS_MODEL],
      voice: options.voice ?? env[ENV_TTS_VOICE],
      fetchImpl: options.fetchImpl,
    });
  }

  throw new UnknownTtsProviderError(kind);
}

/**
 * Like createTtsProvider, but NEVER throws: on any error (including misconfiguration) it falls
 * back to the deterministic StubTtsProvider. Use this on offline-first paths where availability
 * matters more than using the configured backend.
 */
export function createTtsProviderOrStub(options: TtsFactoryOptions = {}): TtsProvider {
  try {
    return createTtsProvider(options);
  } catch {
    return new StubTtsProvider({ model: options.model });
  }
}

function normalizeKind(value: string): TtsProviderKind {
  const k = value.trim().toLowerCase();
  if (k === 'stub' || k === 'kokoro_tunnel') return k;
  throw new UnknownTtsProviderError(value);
}
