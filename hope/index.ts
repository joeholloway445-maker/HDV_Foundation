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
