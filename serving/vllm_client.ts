/**
 * serving/vllm_client.ts — a client for a shared vLLM (or any OpenAI-compatible) server that
 * speaks the /v1/completions API (Phase 6.2 "model serving that fits the persona model").
 *
 * The persona model is: one 7B BASE loaded once on the GPU server; each persona is a cheap
 * delta (LoRA/prompt/sampling — see persona_adapters.ts) sent per request. This client is the
 * thin transport to that server. Like providers/, it depends ONLY on the global `fetch` (no
 * vendor SDK) and is a pure text transducer — it never routes, gates, or touches the ledger.
 *
 * It targets the TEXT completions endpoint (`POST {baseUrl}/completions`), not chat completions,
 * because persona prompts are pre-assembled (system profile + user text) by persona_adapters.ts.
 *
 * OFFLINE-FIRST: `offlineVllmFetch()` returns a deterministic fake `fetch` that produces a
 * completions-shaped response with no network. Construct the client with it and the whole seam
 * runs in CI with zero infrastructure; a missing real server therefore never breaks tests.
 */

export interface VllmSampling {
  /** Sampling temperature. Low by default for stable, reviewable text. */
  temperature?: number;
  /** Nucleus sampling top-p. */
  topP?: number;
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Stop sequences. */
  stop?: string[];
}

export interface VllmClientOptions {
  /** Server base URL INCLUDING the version path, e.g. "http://vllm:8000/v1". Required. */
  baseUrl: string;
  /** Default model id served by vLLM, e.g. "meta-llama/Llama-2-7b-hf". Required. */
  model: string;
  /** API key (sent as `Authorization: Bearer <key>`). Optional for keyless local servers. */
  apiKey?: string;
  /** Completions path appended to baseUrl. Defaults to "/completions". */
  completionsPath?: string;
  /** Default sampling used when a call does not override it. */
  sampling?: VllmSampling;
  /** Per-request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Injectable fetch (defaults to global fetch). Pass `offlineVllmFetch()` for tests/CI. */
  fetchImpl?: typeof fetch;
}

export interface VllmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface VllmCompletion {
  /** Generated text, trimmed of surrounding whitespace by convention. */
  text: string;
  /** Model that produced the text. */
  model: string;
  /** Best-effort token usage (zeros when the server omits it). */
  usage: VllmUsage;
}

export interface VllmCompleteOptions extends VllmSampling {
  /** Override the configured model for this call (e.g. to select a LoRA-merged model id). */
  model?: string;
  /** LoRA adapter id to activate for this request (vLLM `--enable-lora`; passed as `lora_request`). */
  loraId?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

interface CompletionsResponse {
  model?: string;
  choices?: Array<{ text?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Raised on a non-2xx status or an unparseable/empty body. */
export class VllmClientError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'VllmClientError';
    this.status = status;
    this.body = body;
  }
}

export class VllmClient {
  readonly model: string;
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly sampling: VllmSampling;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: VllmClientOptions) {
    if (!options.baseUrl) throw new Error('VllmClient requires a baseUrl.');
    if (!options.model) throw new Error('VllmClient requires a model.');

    const base = options.baseUrl.replace(/\/+$/, '');
    const path = options.completionsPath ?? '/completions';
    this.url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    // Non-enumerable so the key never leaks through JSON.stringify / logging (mirrors providers/).
    Object.defineProperty(this, 'apiKey', {
      value: options.apiKey,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    this.model = options.model;
    this.sampling = { temperature: 0.2, ...options.sampling };
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.extraHeaders = options.headers ?? {};

    const impl = options.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new Error('No fetch available. Use Node >= 18/20 or pass options.fetchImpl (e.g. offlineVllmFetch()).');
    }
    this.fetchImpl = impl;
  }

  /** Send one prompt to `/v1/completions` and return the generated text. */
  async complete(prompt: string, opts: VllmCompleteOptions = {}): Promise<VllmCompletion> {
    const model = opts.model ?? this.model;
    const body: Record<string, unknown> = {
      model,
      prompt,
      temperature: opts.temperature ?? this.sampling.temperature,
    };
    const maxTokens = opts.maxTokens ?? this.sampling.maxTokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    const topP = opts.topP ?? this.sampling.topP;
    if (topP !== undefined) body.top_p = topP;
    const stop = opts.stop ?? this.sampling.stop;
    if (stop && stop.length > 0) body.stop = stop;
    if (opts.loraId) body.lora_request = { lora_name: opts.loraId };

    const headers: Record<string, string> = { 'content-type': 'application/json', ...this.extraHeaders };
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
      throw new VllmClientError(`Request to ${this.url} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      signal.cleanup();
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new VllmClientError(`vLLM endpoint returned HTTP ${response.status}`, response.status, raw);
    }

    let parsed: CompletionsResponse;
    try {
      parsed = JSON.parse(raw) as CompletionsResponse;
    } catch {
      throw new VllmClientError('Response body was not valid JSON', response.status, raw);
    }

    const text = parsed.choices?.[0]?.text ?? '';
    if (!text) {
      throw new VllmClientError('Response contained no completion text (choices[0].text was empty)', response.status, raw);
    }

    return { text: text.trim(), model: parsed.model ?? model, usage: readUsage(parsed.usage) };
  }

  /** Safe serialization: never exposes the API key. */
  toJSON(): { model: string; url: string } {
    return { model: this.model, url: this.url };
  }
}

/**
 * A deterministic, offline `fetch` that mimics a vLLM `/v1/completions` server. Same request →
 * same response, no network. Used as `fetchImpl` so the serving seam runs end-to-end in CI.
 */
export function offlineVllmFetch(): typeof fetch {
  const impl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let body: { model?: string; prompt?: string } = {};
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body) as { model?: string; prompt?: string };
      } catch {
        body = {};
      }
    }
    const prompt = body.prompt ?? '';
    const model = body.model ?? 'offline-vllm-7b';
    const text = renderDeterministic(prompt);
    const payload: CompletionsResponse = {
      model,
      choices: [{ text }],
      usage: {
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(text),
        total_tokens: estimateTokens(prompt) + estimateTokens(text),
      },
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return impl as unknown as typeof fetch;
}

function renderDeterministic(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  const gist = cleaned.split(' ').filter((w) => w.length > 3).slice(0, 12).join(' ') || 'empty prompt';
  return `${gist} [vllm-offline:${fingerprint(cleaned)}]`;
}

function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function readUsage(usage: CompletionsResponse['usage']): VllmUsage {
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
  };
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
