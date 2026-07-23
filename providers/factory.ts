/**
 * providers/factory.ts — build an LlmProvider from the environment.
 *
 * Offline-first by construction: the DEFAULT is always the deterministic StubProvider, so
 * with no configuration the system stays fully functional with no network and no API key.
 *
 * Environment variables:
 *   HDV_LLM_PROVIDER  = stub | openai_compatible          (default: stub)
 *   HDV_LLM_BASE_URL  = e.g. https://api.openai.com/v1    (required for openai_compatible)
 *   HDV_LLM_API_KEY   = provider API key                  (optional for keyless local servers)
 *   HDV_LLM_MODEL     = e.g. gpt-4o-mini / llama3         (required for openai_compatible)
 *
 * Resolution order for each setting is: explicit argument -> environment variable -> default.
 */
import { OpenAiCompatibleProvider } from './openai_compatible.js';
import { StubProvider } from './stub.js';
import type { LlmProvider, ProviderKind } from './types.js';

export const ENV_PROVIDER = 'HDV_LLM_PROVIDER';
export const ENV_BASE_URL = 'HDV_LLM_BASE_URL';
export const ENV_API_KEY = 'HDV_LLM_API_KEY';
export const ENV_MODEL = 'HDV_LLM_MODEL';

const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

export interface FactoryOptions {
  /** Explicit provider kind (overrides env). */
  kind?: ProviderKind;
  /** Explicit base URL (overrides env) for openai_compatible. */
  baseUrl?: string;
  /** Explicit API key (overrides env) for openai_compatible. */
  apiKey?: string;
  /** Explicit model (overrides env). */
  model?: string;
  /** Environment source (defaults to process.env). Handy for tests. */
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch (passed through to the HTTP provider). */
  fetchImpl?: typeof fetch;
}

/** Raised when the requested provider kind is not recognized. */
export class UnknownProviderError extends Error {
  constructor(kind: string) {
    super(`Unknown ${ENV_PROVIDER}=${JSON.stringify(kind)}; expected "stub" or "openai_compatible".`);
    this.name = 'UnknownProviderError';
  }
}

/**
 * Build a provider from explicit options and/or the environment. Never throws for the
 * default (stub) path; only the openai_compatible path can throw when misconfigured.
 */
export function createProvider(options: FactoryOptions = {}): LlmProvider {
  const env = options.env ?? process.env;
  const kind = normalizeKind(options.kind ?? env[ENV_PROVIDER] ?? 'stub');

  if (kind === 'stub') {
    return new StubProvider({ model: options.model ?? env[ENV_MODEL] });
  }

  if (kind === 'openai_compatible') {
    const baseUrl = options.baseUrl ?? env[ENV_BASE_URL];
    if (!baseUrl) {
      throw new Error(
        `${ENV_PROVIDER}=openai_compatible requires ${ENV_BASE_URL} (e.g. https://api.openai.com/v1).`,
      );
    }
    const model = options.model ?? env[ENV_MODEL] ?? DEFAULT_OPENAI_MODEL;
    return new OpenAiCompatibleProvider({
      baseUrl,
      apiKey: options.apiKey ?? env[ENV_API_KEY],
      model,
      fetchImpl: options.fetchImpl,
    });
  }

  throw new UnknownProviderError(kind);
}

/**
 * Like createProvider, but NEVER throws: on any error (including misconfiguration) it falls
 * back to the deterministic StubProvider. Use this on offline-first paths where availability
 * matters more than using the configured backend.
 */
export function createProviderOrStub(options: FactoryOptions = {}): LlmProvider {
  try {
    return createProvider(options);
  } catch {
    return new StubProvider({ model: options.model });
  }
}

function normalizeKind(value: string): ProviderKind {
  const k = value.trim().toLowerCase();
  if (k === 'stub' || k === 'openai_compatible') return k;
  throw new UnknownProviderError(value);
}
