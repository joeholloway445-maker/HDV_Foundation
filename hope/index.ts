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
