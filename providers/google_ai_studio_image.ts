/**
 * providers/google_ai_studio_image.ts — Google AI Studio (Imagen) image client.
 *
 * Talks to the Generative Language API's `:predict` endpoint for Imagen models. Built on the
 * global `fetch` only — no `@google/generative-ai` SDK dependency, same "no hard SDK" rule as
 * providers/openai_compatible.ts.
 *
 * Fit: SFW portraits, fast and reliable. Google's safety filters apply and will refuse
 * explicit content — this is the right provider for family-safe imagery (e.g. MyFriendAnd.Ai-
 * style products), not for an adult product's NSFW path. For that, use
 * providers/colab_tunnel_image.ts pointed at a self-hosted model instead.
 */
import type { GenerateImageOptions, ImageProvider, ImageResult } from './image_types.js';

export interface GoogleAiStudioImageOptions {
  /** API key (Google AI Studio key, sent as the `key` query param). Required. */
  apiKey: string;
  /** Model id, e.g. "imagen-3.0-generate-002". Required. */
  model: string;
  /** Base URL, override only for testing. Defaults to the public Generative Language API. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 60000 (image generation is slower than text). */
  timeoutMs?: number;
  /** Injectable fetch implementation (defaults to global fetch). Handy for tests. */
  fetchImpl?: typeof fetch;
}

interface ImagenPrediction {
  bytesBase64Encoded?: string;
  mimeType?: string;
}
interface ImagenResponse {
  predictions?: ImagenPrediction[];
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Raised when the remote returns a non-2xx status or an unparseable/empty response. */
export class GoogleAiStudioImageError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'GoogleAiStudioImageError';
    this.status = status;
    this.body = body;
  }
}

export class GoogleAiStudioImageProvider implements ImageProvider {
  readonly name = 'google_ai_studio';
  readonly model: string;

  private readonly baseUrl: string;
  // Assigned via Object.defineProperty below (non-enumerable, so TS can't see the initialization).
  private readonly apiKey!: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleAiStudioImageOptions) {
    if (!options.apiKey) throw new Error('GoogleAiStudioImageProvider requires an apiKey.');
    if (!options.model) throw new Error('GoogleAiStudioImageProvider requires a model.');

    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 60_000;

    // Non-enumerable so the key never leaks through JSON.stringify/console.log/loggers.
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
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:predict?key=${encodeURIComponent(this.apiKey)}`;

    const body = {
      instances: [{ prompt: opts.negativePrompt ? `${prompt}\nAvoid: ${opts.negativePrompt}` : prompt }],
      parameters: { sampleCount: 1 },
    };

    const signal = combineSignals(opts.signal, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal.signal,
      });
    } catch (err) {
      throw new GoogleAiStudioImageError(
        `Request to Google AI Studio failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      signal.cleanup();
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new GoogleAiStudioImageError(
        `Google AI Studio returned HTTP ${response.status}`,
        response.status,
        raw,
      );
    }

    let parsed: ImagenResponse;
    try {
      parsed = JSON.parse(raw) as ImagenResponse;
    } catch {
      throw new GoogleAiStudioImageError('Response body was not valid JSON', response.status, raw);
    }

    const prediction = parsed.predictions?.[0];
    if (!prediction?.bytesBase64Encoded) {
      throw new GoogleAiStudioImageError(
        'Response contained no image (predictions[0].bytesBase64Encoded was empty) — likely blocked by safety filters',
        response.status,
        raw,
      );
    }

    return {
      imageBase64: prediction.bytesBase64Encoded,
      mimeType: prediction.mimeType ?? 'image/png',
      model: this.model,
    };
  }

  /** Safe serialization: name/model/baseUrl only — NEVER the API key. */
  toJSON(): { name: string; model: string; baseUrl: string } {
    return { name: this.name, model: this.model, baseUrl: this.baseUrl };
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
