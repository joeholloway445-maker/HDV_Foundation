/**
 * hope/index.ts — public surface of the HOPE interface layer.
 * HOPE interprets; it never executes or creates, and only ever talks to APEX.
 */
export { IntentInterpreter } from './interpreter.js';
export type { StructuredIntent, IntentKind, SendViaApex } from './interpreter.js';
