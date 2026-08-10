/**
 * providers/colab_tunnel_video.ts — client for a self-hosted world/video model exposed from
 * Colab (e.g. LingBot-World).
 *
 * Talks to the FastAPI server in colab/08_scene_server.py over a tunnel, same pattern as
 * colab_tunnel_image.ts and Ollama for text. Built on the global `fetch` only.
 *
 * Wire contract (see colab/08_scene_server.py for the reference server):
 *   POST {baseUrl}/generate
 *   body: { prompt, seed_image_base64, action_string?, frame_num?, seed? }
 *   200 -> { video_base64, mime_type?, model? }
 *
 * Video generation is dramatically slower than text or a single image — expect calls to take
 * minutes, not seconds. The default timeout here is generous accordingly; override per-call
 * with opts.signal if you need something different.
 */
import type { GenerateVideoOptions, VideoProvider, VideoResult } from './video_types.js';

export interface ColabTunnelVideoOptions {
  /** Base URL of the tunnel, e.g. "https://xxxx.ngrok-free.app". Required. */
  baseUrl: string;
  /** Optional shared-secret bearer token (Colab tunnels are often public URLs). */
  apiKey?: string;
  /** Reported model id when the server doesn't echo one back. Defaults to "colab-tunnel-video". */
  model?: string;
  /** Path appended to baseUrl. Defaults to "/generate". */
  generatePath?: string;
  /** Per-request timeout in milliseconds. Defaults to 600000 (10 min) — video generation is slow. */
  timeoutMs?: number;
  /** Injectable fetch implementation (defaults to global fetch). Handy for tests. */
  fetchImpl?: typeof fetch;
}

interface ColabVideoResponse {
  video_base64?: string;
  mime_type?: string;
  model?: string;
}

const DEFAULT_MODEL = 'colab-tunnel-video';

/** Raised when the remote returns a non-2xx status or an unparseable/empty response. */
export class ColabTunnelVideoError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'ColabTunnelVideoError';
    this.status = status;
    this.body = body;
  }
}

export class ColabTunnelVideoProvider implements VideoProvider {
  readonly name = 'colab_tunnel';
  readonly model: string;

  private readonly url: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ColabTunnelVideoOptions) {
    if (!options.baseUrl) throw new Error('ColabTunnelVideoProvider requires a baseUrl.');

    const base = options.baseUrl.replace(/\/+$/, '');
    const path = options.generatePath ?? '/generate';
    this.url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 600_000;

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

  async generate(
    prompt: string,
    seedImageBase64: string,
    opts: GenerateVideoOptions = {},
  ): Promise<VideoResult> {
    const body: Record<string, unknown> = { prompt, seed_image_base64: seedImageBase64 };
    if (opts.actionString) body.action_string = opts.actionString;
    if (opts.frameNum) body.frame_num = opts.frameNum;
    if (opts.seed !== undefined) body.seed = opts.seed;

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
      throw new ColabTunnelVideoError(
        `Request to ${this.url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      signal.cleanup();
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new ColabTunnelVideoError(`Colab tunnel returned HTTP ${response.status}`, response.status, raw);
    }

    let parsed: ColabVideoResponse;
    try {
      parsed = JSON.parse(raw) as ColabVideoResponse;
    } catch {
      throw new ColabTunnelVideoError('Response body was not valid JSON', response.status, raw);
    }

    if (!parsed.video_base64) {
      throw new ColabTunnelVideoError(
        'Response contained no video (video_base64 was empty)',
        response.status,
        raw,
      );
    }

    return {
      videoBase64: parsed.video_base64,
      mimeType: parsed.mime_type ?? 'video/mp4',
      model: parsed.model ?? this.model,
    };
  }

  toJSON(): { name: string; model: string; url: string } {
    return { name: this.name, model: this.model, url: this.url };
  }
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
