/**
 * dream/index.ts — public surface of the DREAM simulation layer.
 * DREAM simulates; it never governs or executes, and never talks to VISION directly.
 */
export { SimulationEngine } from './engine.js';
export type { Outcome, SimulationResult, SendViaApex } from './engine.js';
