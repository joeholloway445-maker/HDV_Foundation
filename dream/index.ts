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
  SendViaApex as SchedulerSendViaApex,
} from './scheduler.js';

export { StreamEnergyMeter, DEFAULT_ENERGY_WEIGHTS } from './energy.js';
export type { StreamEnergyMeterOptions } from './energy.js';

export { ScenarioBank, DEFAULT_SCENARIOS } from './scenario_bank.js';
export type {
  ScenarioTemplate,
  SpecializedScenario,
  ScenarioPriors,
} from './scenario_bank.js';
