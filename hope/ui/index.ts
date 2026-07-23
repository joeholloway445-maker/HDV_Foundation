/**
 * hope/ui/index.ts — public surface of HOPE's forward-facing console.
 *
 * Presentation layer over HOPE's interpret/document/voice stack. It never executes or creates,
 * and reaches the rest of the system only through an optional, injected `sendViaApex` callback.
 */
export { HopeConsole } from './console.js';
export type { HopeConsoleOptions, Turn, TurnRole, ConsoleTurn } from './console.js';

export { renderTranscriptToHtml, escapeHtml } from './render.js';
export type { RenderOptions } from './render.js';

export { writeConsoleHtml, DEFAULT_OUTPUT_PATH } from './static.js';
