/**
 * providers/kokoro_tunnel_tts.ts — client for a self-hosted Kokoro-82M TTS server.
 *
 * Talks to a `remsky/Kokoro-FastAPI`-shaped server — an OpenAI-compatible `/v1/audio/speech`
 * wrapper around Kokoro-82M (Apache-2.0, ~82M params, CPU-inference-capable) — over plain HTTP.
 * Same "point HDV at a plain HTTP endpoint" pattern as colab_tunnel_image.ts /
 * colab_tunnel_video.ts and Ollama for text, just for speech instead. The "_tunnel" naming
 * follows that same convention for consistency across the provider seams, but it is NOT
 * Colab-specific: Kokoro-82M is light enough to run as an always-on Docker sidecar directly on
 * the production VPS (see colab/10_kokoro_tts_server.md), so `baseUrl` will typically point at a
 * loopback/internal-network address rather than an ngrok/Cloudflare tunnel — the provider itself
 * doesn't care which, it only speaks plain HTTP. Built on the global `fetch` only, zero SDK
 * dependency.
 *
 * Wire contract (see colab/10_kokoro_tts_server.md for the reference server / verified command):
 *   POST {baseUrl}/v1/audio/speech
 *   body: { input: text, voice?, speed? }
 *   200 -> raw audio bytes (Content-Type: audio/wav or audio/mpeg, depending on server config)
 *
 * Unlike the image/video colab_tunnel providers (which expect a JSON envelope with a base64
 * field), Kokoro-FastAPI's `/v1/audio/speech` mirrors OpenAI's real audio API: the response body
 * IS the audio, with the format carried in the Content-Type header. This provider reads that
 * body as raw bytes and base64-encodes it itself.
 */
import { redactFrom } from './redact.js';
import type { GenerateTtsOptions, TtsProvider, TtsResult } from './tts_types.js';

export interface KokoroTunnelTtsOptions {
  /** Base URL of the server, e.g. "http://kokoro-tts:8880" or an ngrok/Cloudflare tunnel URL. Required. */
  baseUrl: string;
  /** Optional shared-secret bearer token. */
  apiKey?: string;
  /** Reported model id when the server doesn't echo one back via a header. Defaults to "kokoro-82m". */
  model?: string;
  /** Path appended to baseUrl. Defaults to "/v1/audio/speech" (Kokoro-FastAPI's OpenAI-compatible route). */
  speechPath?: string;
  /** Default voice, when a call doesn't specify one. Kokoro ships multiple named voices (e.g. "af_bella"). */
  voice?: string;
  /** Per-request timeout in milliseconds. Defaults to 30000 — CPU inference on a short line of dialogue is fast. */
  timeoutMs?: number;
  /** Injectable fetch implementation (defaults to global fetch). Handy for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = 'kokoro-82m';
const DEFAULT_SPEECH_PATH = '/v1/audio/speech';
const DEFAULT_TIMEOUT_MS = 30_000;
/** Fallback MIME type when the server's response carries no (or an unrecognized) Content-Type. */
const FALLBACK_MIME_TYPE = 'audio/wav';

/** Raised when the remote returns a non-2xx status or an empty response. Error messages are
 *  always scrubbed of the configured API key via providers/redact.ts before being thrown. */
export class KokoroTunnelTtsError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'KokoroTunnelTtsError';
    this.status = status;
    this.body = body;
  }
}

export class KokoroTunnelTtsProvider implements TtsProvider {
  readonly name = 'kokoro_tunnel';
  readonly model: string;

  private readonly url: string;
  private readonly apiKey?: string;
  private readonly defaultVoice?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: KokoroTunnelTtsOptions) {
    if (!options.baseUrl) throw new Error('KokoroTunnelTtsProvider requires a baseUrl.');

    const base = options.baseUrl.replace(/\/+$/, '');
    const path = options.speechPath ?? DEFAULT_SPEECH_PATH;
    this.url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    this.model = options.model ?? DEFAULT_MODEL;
    this.defaultVoice = options.voice;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    Object.defineProperty(this, 'apiKey', {
      value: options.apiKey,
      enumerable: false,
      writable: false,
      configurable: false,
    });

    const impl = options.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new Error(
        'No fetch implementation available. Use Node >= 18/20 or pass options.fetchImpl.',
      );
    }
    this.fetchImpl = impl;
  }

  async generate(text: string, opts: GenerateTtsOptions = {}): Promise<TtsResult> {
    const body: Record<string, unknown> = { input: text };
    const voice = opts.voice ?? this.defaultVoice;
    if (voice) body.voice = voice;
    if (opts.speed !== undefined) body.speed = opts.speed;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const signal = combineSignals(opts.signal, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new KokoroTunnelTtsError(
        redactFrom(`Request to ${this.url} failed: ${message}`, this.apiKey),
      );
    } finally {
      signal.cleanup();
    }

    const raw = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const snippet = redactFrom(raw.toString('utf8').slice(0, 2000), this.apiKey);
      throw new KokoroTunnelTtsError(`Kokoro TTS server returned HTTP ${response.status}`, response.status, snippet);
    }

    if (raw.length === 0) {
      throw new KokoroTunnelTtsError('Response contained no audio (empty body)', response.status);
    }

    return {
      audioBase64: raw.toString('base64'),
      mimeType: normalizeMimeType(response.headers.get('content-type')),
      model: response.headers.get('x-model') ?? this.model,
    };
  }

  toJSON(): { name: string; model: string; url: string } {
    return { name: this.name, model: this.model, url: this.url };
  }
}

/** Map a response Content-Type to one of the two audio formats this seam supports. */
function normalizeMimeType(contentType: string | null): string {
  if (!contentType) return FALLBACK_MIME_TYPE;
  const base = contentType.split(';')[0].trim().toLowerCase();
  if (base === 'audio/wav' || base === 'audio/x-wav' || base === 'audio/wave') return 'audio/wav';
  if (base === 'audio/mpeg' || base === 'audio/mp3') return 'audio/mpeg';
  return FALLBACK_MIME_TYPE;
}

function combineSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);

  const onAbort = (): void => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (caller) caller.removeEventListener('abort', onAbort);
    },
  };
}
