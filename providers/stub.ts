/**
 * providers/stub.ts — the deterministic, offline StubProvider (DEFAULT).
 *
 * The StubProvider always works: no network, no API key, no vendor SDK. Given the same
 * prompt and options it returns the same text, so tests and demos are reproducible and the
 * system stays fully functional offline. It is the safe default the factory hands back when
 * no real provider is configured.
 *
 * It produces a short, structured, human-readable line derived deterministically from the
 * prompt — enough to exercise the LlmProvider seam end-to-end without any external service.
 */
import {
  emptyUsage,
  type CompleteOptions,
  type CompletionResult,
  type LlmProvider,
  type LlmUsage,
} from './types.js';

export interface StubProviderOptions {
  /** Reported model id. Defaults to "stub-1". */
  model?: string;
  /** Optional prefix for generated text (useful to visually mark stub output). */
  prefix?: string;
}

const DEFAULT_STUB_MODEL = 'stub-1';

export class StubProvider implements LlmProvider {
  readonly name = 'stub';
  readonly model: string;
  private readonly prefix: string;

  constructor(options: StubProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_STUB_MODEL;
    this.prefix = options.prefix ?? '';
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<CompletionResult> {
    // Deterministic: no randomness, no clock, no network.
    const model = opts.model ?? this.model;
    const text = this.render(prompt, opts);
    const usage = estimateUsage(prompt, text, opts.system);
    return { text, model, usage };
  }

  private render(prompt: string, opts: CompleteOptions): string {
    const cleaned = prompt.replace(/\s+/g, ' ').trim();
    const gist = summarizeDeterministically(cleaned);
    const tag = fingerprint(`${opts.system ?? ''}\u0000${cleaned}`);
    const body = `${gist} [stub:${tag}]`;
    return (this.prefix ? `${this.prefix} ${body}` : body).trim();
  }
}

/**
 * Compress a prompt into a compact, deterministic one-liner: the most salient words in
 * their original order, capped in length. No model, just a stable transform.
 */
function summarizeDeterministically(text: string): string {
  if (!text) return 'empty prompt';
  const words = text.split(' ').filter(Boolean);
  const salient = words.filter((w) => w.length > 3).slice(0, 12);
  const chosen = salient.length > 0 ? salient : words.slice(0, 8);
  const line = chosen.join(' ');
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** A short, stable hex fingerprint (FNV-1a) — matches the deterministic style used elsewhere. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Rough token estimate (~4 chars/token) so the stub reports plausible, deterministic usage. */
function estimateUsage(prompt: string, text: string, system?: string): LlmUsage {
  const usage = emptyUsage();
  const promptChars = (system ? system.length + 1 : 0) + prompt.length;
  usage.promptTokens = Math.ceil(promptChars / 4);
  usage.completionTokens = Math.ceil(text.length / 4);
  usage.totalTokens = usage.promptTokens + usage.completionTokens;
  return usage;
}
