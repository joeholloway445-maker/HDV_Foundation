/**
 * vision/index.ts — public surface of the VISION action layer.
 * VISION executes; it never creates or governs, and never talks to DREAM directly.
 */
export { ExecutionEngine } from './engine.js';
export type { ExecutionResult, SandboxKind, SendViaApex } from './engine.js';
