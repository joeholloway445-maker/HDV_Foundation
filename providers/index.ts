/**
 * providers/index.ts — public surface of the optional LLM provider package.
 *
 * Everything here is a pure text transducer (prompt -> text). Providers know nothing about
 * agents, routing, KNOLL, or the ledger, and must never be used to execute or create in the
 * matrix. The default is always the deterministic, offline StubProvider.
 */
export type {
  LlmProvider,
  CompleteOptions,
  CompletionResult,
  LlmUsage,
  ProviderKind,
} from './types.js';
export { emptyUsage } from './types.js';

export { StubProvider } from './stub.js';
export type { StubProviderOptions } from './stub.js';

export { OpenAiCompatibleProvider, OpenAiCompatibleError } from './openai_compatible.js';
export type { OpenAiCompatibleOptions } from './openai_compatible.js';

export {
  createProvider,
  createProviderOrStub,
  UnknownProviderError,
  ENV_PROVIDER,
  ENV_BASE_URL,
  ENV_API_KEY,
  ENV_MODEL,
} from './factory.js';
export type { FactoryOptions } from './factory.js';

export { redactSecret, redactFrom, REDACTED } from './redact.js';
