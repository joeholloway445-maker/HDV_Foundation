/**
 * dream/index.ts — public surface of the DREAM simulation layer.
 * DREAM simulates; it never governs or executes, and never talks to VISION directly.
 */
export { SimulationEngine } from './engine.js';
export type {
  Outcome,
  OutcomeNode,
  SimulationResult,
  SimulationConfig,
  SendViaApex,
} from './engine.js';

export { DreamScheduler } from './scheduler.js';
export type {
  StreamEvent,
  StreamEventType,
  ScheduleDecision,
  DreamSchedulerOptions,
} from './scheduler.js';
