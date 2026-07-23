/**
 * providers/types.ts — the LlmProvider contract.
 *
 * This package is a thin, dependency-free seam for OPTIONAL large-language-model access.
 * It exists so higher layers (e.g. HOPE, when explicitly given a provider) can enrich
 * *text* — never behavior. A provider turns a prompt into text; it has no knowledge of
 * agents, packets, routing, KNOLL, or the ledger, and MUST never be used to execute or
 * create anything in the system.
 *
 * Design goals:
 *   - Offline-first: the DEFAULT provider (StubProvider) always works with no network.
 *   - No hard SDK dependency: HTTP providers use the global `fetch`, not vendor SDKs.
 *   - Minimal surface: one method, `complete(prompt, opts) -> { text, model, usage }`.
 */

/** Token accounting for a single completion (best-effort; zeros when unknown). */
export interface LlmUsage {
  /** Tokens consumed by the prompt. */
  promptTokens: number;
  /** Tokens produced by the completion. */
  completionTokens: number;
  /** promptTokens + completionTokens. */
  totalTokens: number;
}

/** Per-call options. All optional; providers pick sensible, deterministic-leaning defaults. */
export interface CompleteOptions {
  /** Override the provider's configured model for this call. */
  model?: string;
  /** Optional system / instruction preamble (chat-style providers use a system message). */
  system?: string;
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Sampling temperature. Defaults are low so text stays stable and reviewable. */
  temperature?: number;
  /** Optional stop sequences. */
  stop?: string[];
  /** Abort signal for cancellation / timeouts. */
  signal?: AbortSignal;
}

/** The result of a single completion. */
export interface CompletionResult {
  /** The generated text (already trimmed of surrounding whitespace by convention). */
  text: string;
  /** The model that actually produced the text. */
  model: string;
  /** Best-effort token usage. */
  usage: LlmUsage;
}

/**
 * The single provider contract. Implementations are pure text transducers:
 * prompt in, text out. They perform NO tool use, routing, or side effects on the matrix.
 */
export interface LlmProvider {
  /** Stable, human-readable identifier for the provider implementation. */
  readonly name: string;
  /** The default model this provider will use when a call does not override it. */
  readonly model: string;
  /** Turn a prompt into text. Must reject (throw) on transport / API errors. */
  complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult>;
}

/** Recognized provider selector values for the env-driven factory. */
export type ProviderKind = 'stub' | 'openai_compatible';

/** Build a zeroed usage record. */
export function emptyUsage(): LlmUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}
