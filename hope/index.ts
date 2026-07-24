/**
 * hope/index.ts — public surface of the HOPE interface layer.
 * HOPE interprets and documents; it never executes or creates, and only ever talks to APEX.
 */
export { IntentInterpreter, destinationFor, isStopword } from './interpreter.js';
export type {
  StructuredIntent,
  IntentKind,
  Urgency,
  SendViaApex,
  InterpreterOptions,
} from './interpreter.js';

export { HopeDocumenter } from './documenter.js';
export type { IntentDocument, HopeDocumenterOptions } from './documenter.js';

export { HopeVoice } from './voice.js';

// Optional, dependency-injected LLM enrichment of the intent summary (heuristic by default).
export { IntentEnricher, heuristicSummary } from './enricher.js';
export type {
  EnrichedSummary,
  SummarySource,
  IntentEnricherOptions,
} from './enricher.js';

// Intent memory: interpretation-only recall archive (hash-vector embed + pgvector stub).
export {
  IntentMemory,
  InMemoryVectorStore,
  PgVectorStore,
  embedIntent,
  cosineSimilarity,
  EMBED_DIM,
} from './memory.js';
export type {
  StoredIntent,
  VectorQuery,
  VectorMatch,
  VectorStore,
  PgVectorClient,
  IntentMemoryOptions,
  RememberOptions,
  RecallOptions,
} from './memory.js';

// Reflected Hopes: per-user, isolated mirror containers (opt-in; cannot contaminate Core/Prime).
export {
  ReflectedHope,
  ReflectedHopeRegistry,
  CoreHopeStore,
  reflectedId,
  containerPath,
  isReflectedPath,
  isCoreOrPrimePath,
  assertIsolation,
  CORE_HOPE_ROOT,
  PRIME_HOPE_ROOT,
  REFLECTED_ROOT,
  OptInConsent,
  DEFAULT_OPT_IN,
  TacticalIntelException,
} from './reflected/index.js';
export type {
  ReflectedObservation,
  RecordOptions,
  ReflectedHopeOptions,
  ReflectedHopeRegistryOptions,
  ConsentState,
  OptInConsentOptions,
  IntelPurpose,
  IntelExceptionEntry,
  TacticalIntelExceptionOptions,
  ManipulationContext,
} from './reflected/index.js';

// Forward-facing console (interpretation/documentation/voice only; routes only if injected).
export {
  HopeConsole,
  renderTranscriptToHtml,
  escapeHtml,
  writeConsoleHtml,
  DEFAULT_OUTPUT_PATH,
} from './ui/index.js';
export type {
  HopeConsoleOptions,
  Turn,
  TurnRole,
  ConsoleTurn,
  RenderOptions,
} from './ui/index.js';
