/**
 * providers/openai_compatible.ts — an OpenAI-compatible chat client built on `fetch`.
 *
 * Works with any service that speaks the OpenAI Chat Completions API:
 *   - OpenAI            (https://api.openai.com/v1)
 *   - Groq              (https://api.groq.com/openai/v1)
 *   - Together AI       (https://api.together.xyz/v1)
 *   - local vLLM        (http://localhost:8000/v1)
 *   - local Ollama      (http://localhost:11434/v1)
 *
 * There is NO hard dependency on the `openai` SDK — this uses the global `fetch` only, so it
 * adds zero packages and runs anywhere Node >= 20 (or any modern runtime with fetch) does.
 *
 * Like every provider here it is a pure text transducer: prompt in, text out. It never
 * touches routing, KNOLL, the ledger, or any sandbox, and MUST NOT be used to execute.
 */
import {
  emptyUsage,
  type CompleteOptions,
  type CompletionResult,
  type LlmProvider,
  type LlmUsage,
} from './types.js';

export interface OpenAiCompatibleOptions {
  /** API base URL including the version path, e.g. "https://api.openai.com/v1". Required. */
  baseUrl: string;
  /** API key (sent as `Authorization: Bearer <key>`). Optional for keyless local servers. */
  apiKey?: string;
  /** Default model id, e.g. "gpt-4o-mini", "llama-3.1-8b-instant", "llama3". Required. */
  model: string;
  /** Chat completions path appended to baseUrl. Defaults to "/chat/completions". */
  chatPath?: string;
  /** Default max tokens for completions when a call does not specify one. */
  maxTokens?: number;
  /** Default temperature (kept low for stable, reviewable text). Defaults to 0.2. */
  temperature?: number;
  /** Per-request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  /** Extra headers merged into every request (e.g. org id, provider-specific headers). */
  headers?: Record<string, string>;
  /** Injectable fetch implementation (defaults to global fetch). Handy for tests. */
  fetchImpl?: typeof fetch;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** Raised when the remote returns a non-2xx status or an unparseable/empty body. */
export class OpenAiCompatibleError extends Error {
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'OpenAiCompatibleError';
    this.status = status;
    this.body = body;
  }
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai_compatible';
  readonly model: string;

  private readonly url: string;
  private readonly apiKey?: string;
  private readonly maxTokens?: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    if (!options.baseUrl) throw new Error('OpenAiCompatibleProvider requires a baseUrl.');
    if (!options.model) throw new Error('OpenAiCompatibleProvider requires a model.');

    const base = options.baseUrl.replace(/\/+$/, '');
    const path = options.chatPath ?? '/chat/completions';
    this.url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    // Store the API key as a NON-ENUMERABLE property so it never leaks through JSON.stringify,
    // object spreads, console.log(obj), or structured logging. Keys must never be serialized.
    Object.defineProperty(this, 'apiKey', {
      value: options.apiKey,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.temperature = options.temperature ?? 0.2;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.extraHeaders = options.headers ?? {};

    const impl = options.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new Error(
        'No fetch implementation available. Use Node >= 18/20 or pass options.fetchImpl.',
      );
    }
    this.fetchImpl = impl;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<CompletionResult> {
    const model = opts.model ?? this.model;
    const messages: ChatMessage[] = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? this.temperature,
    };
    const maxTokens = opts.maxTokens ?? this.maxTokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (opts.stop && opts.stop.length > 0) body.stop = opts.stop;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.extraHeaders,
    };
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
      throw new OpenAiCompatibleError(
        `Request to ${this.url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      signal.cleanup();
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new OpenAiCompatibleError(
        `OpenAI-compatible endpoint returned HTTP ${response.status}`,
        response.status,
        raw,
      );
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      throw new OpenAiCompatibleError('Response body was not valid JSON', response.status, raw);
    }

    const text = parsed.choices?.[0]?.message?.content ?? '';
    if (!text) {
      throw new OpenAiCompatibleError(
        'Response contained no completion text (choices[0].message.content was empty)',
        response.status,
        raw,
      );
    }

    return {
      text: text.trim(),
      model: parsed.model ?? model,
      usage: readUsage(parsed.usage),
    };
  }

  /**
   * Safe serialization: JSON.stringify(provider) and structured loggers only ever see the
   * provider name, model, and endpoint URL — NEVER the API key (which is also non-enumerable).
   */
  toJSON(): { name: string; model: string; url: string } {
    return { name: this.name, model: this.model, url: this.url };
  }
}

function readUsage(usage: ChatCompletionResponse['usage']): LlmUsage {
  const out = emptyUsage();
  if (!usage) return out;
  out.promptTokens = usage.prompt_tokens ?? 0;
  out.completionTokens = usage.completion_tokens ?? 0;
  out.totalTokens = usage.total_tokens ?? out.promptTokens + out.completionTokens;
  return out;
}

/**
 * Combine an optional caller signal with a timeout into a single AbortSignal. Returns a
 * cleanup fn that clears the timer to avoid leaks.
 */
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
