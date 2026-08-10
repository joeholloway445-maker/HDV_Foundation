/**
 * providers/colab_tunnel_image.ts — client for a self-hosted image model exposed from Colab.
 *
 * Talks to the small FastAPI server in colab/07_portrait_server.py over a tunnel (ngrok /
 * Cloudflare Tunnel / similar) — the same "point HDV at a plain HTTP endpoint" pattern as
 * Ollama (deploy/OLLAMA.md), just for images instead of text. Built on the global `fetch`
 * only, zero SDK dependency.
 *
 * Wire contract (see colab/07_portrait_server.py for the reference server):
 *   POST {baseUrl}/generate
 *   body: { prompt, style?, negative_prompt?, width?, height?, steps?, seed? }
 *   200 -> { image_base64, mime_type?, model? }
 *
 * `style` (e.g. "realistic" | "anime", from PortraitPersona.style) lets the server route to a
 * different checkpoint per persona style — see colab/07_portrait_server.py's MODEL_ROUTES.
 *
 * Fit: this is where an NSFW-capable checkpoint/LoRA lives, fully under your control — the
 * gateway never knows or cares which model is behind the tunnel, same as it doesn't know which
 * model is behind Ollama for text.
 */
import type { GenerateImageOptions, ImageProvider, ImageResult } from './image_types.js';

export interface ColabTunnelImageOptions {
  /** Base URL of the tunnel, e.g. "https://xxxx.ngrok-free.app". Required. */
  baseUrl: string;
  /** Optional shared-secret bearer token (Colab tunnels are often public URLs). */
  apiKey?: string;
  /** Reported model id when the server doesn't echo one back. Defaults to "colab-tunnel". */
  model?: string;
  /** Path appended to baseUrl. Defaults to "/generate". */
  generatePath?: string;
  /** Per-request timeout in milliseconds. Defaults to 120000 (diffusion models are slow, esp. on a free-tier GPU). */
  timeoutMs?: number;
  /** Injectable fetch implementation (defaults to global fetch). Handy for tests. */
  fetchImpl?: typeof fetch;
}

interface ColabImageResponse {
  image_base64?: string;
  mime_type?: string;
  model?: string;
}

const DEFAULT_MODEL = 'colab-tunnel';

/** Raised when the remote returns a non-2xx status or an unparseable/empty response. */
export class ColabTunnelImageError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'ColabTunnelImageError';
    this.status = status;
    this.body = body;
  }
}

export class ColabTunnelImageProvider implements ImageProvider {
  readonly name = 'colab_tunnel';
  readonly model: string;

  private readonly url: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ColabTunnelImageOptions) {
    if (!options.baseUrl) throw new Error('ColabTunnelImageProvider requires a baseUrl.');

    const base = options.baseUrl.replace(/\/+$/, '');
    const path = options.generatePath ?? '/generate';
    this.url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 120_000;

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

  async generate(prompt: string, opts: GenerateImageOptions = {}): Promise<ImageResult> {
    const body: Record<string, unknown> = { prompt };
    if (opts.style) body.style = opts.style;
    if (opts.negativePrompt) body.negative_prompt = opts.negativePrompt;
    if (opts.width) body.width = opts.width;
    if (opts.height) body.height = opts.height;
    if (opts.steps) body.steps = opts.steps;
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
      throw new ColabTunnelImageError(
        `Request to ${this.url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      signal.cleanup();
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new ColabTunnelImageError(`Colab tunnel returned HTTP ${response.status}`, response.status, raw);
    }

    let parsed: ColabImageResponse;
    try {
      parsed = JSON.parse(raw) as ColabImageResponse;
    } catch {
      throw new ColabTunnelImageError('Response body was not valid JSON', response.status, raw);
    }

    if (!parsed.image_base64) {
      throw new ColabTunnelImageError(
        'Response contained no image (image_base64 was empty)',
        response.status,
        raw,
      );
    }

    return {
      imageBase64: parsed.image_base64,
      mimeType: parsed.mime_type ?? 'image/png',
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
