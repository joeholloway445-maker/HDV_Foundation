/**
 * serving/ — the shared model-serving seam (Phase 6.2).
 *
 * A thin, dependency-free bridge to a shared vLLM 7B server (one base, loaded once) plus the
 * per-persona delta representation that makes the "2M personas" number honest. Offline-first:
 * `offlineVllmFetch()` runs the whole seam in CI with no infrastructure. Nothing here routes,
 * gates, or touches the ledger — it is pure text transport + accounting.
 */
export {
  VllmClient,
  VllmClientError,
  offlineVllmFetch,
} from './vllm_client.js';
export type {
  VllmClientOptions,
  VllmSampling,
  VllmUsage,
  VllmCompletion,
  VllmCompleteOptions,
} from './vllm_client.js';

export {
  createPersonaAdapter,
  renderPersonaRequest,
  completeWithPersona,
  accountPersonaBatch,
} from './persona_adapters.js';
export type {
  PersonaAdapter,
  PersonaAdapterInput,
  RenderedPersonaRequest,
  PersonaBatchAccounting,
} from './persona_adapters.js';
