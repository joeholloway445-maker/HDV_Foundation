/**
 * knoll/index.ts — public surface of the KNOLL security layer.
 * KNOLL is always-on and monitor-only. It never creates or executes business tasks.
 */
export { Knoll } from './validator.js';
export type { KnollOptions } from './validator.js';
export { SecurityAuditLog } from './audit.js';
export type { SecurityAuditEntry, SecurityAuditLogOptions } from './audit.js';
export {
  VIRTUAL_LAWS,
  lawTokenWellFormed,
  lawValidEndpoints,
  lawNoDirectDreamVision,
  lawNoKnollForgery,
  lawHopeCannotCommand,
  lawNoMaliciousIntent,
  lawNoCrossTenant,
  lawPrimaryTriadDuty,
} from './laws.js';
export type { LawVerdict, KnollLaw, KnollLawContext } from './laws.js';
export { AuditHashChain } from './hashchain.js';
export type { HashChainLink, HashChainVerification } from './hashchain.js';
export { BehavioralScorer } from './scoring.js';
export type {
  BehavioralScore,
  BehavioralScorerOptions,
  FeatureWeights,
} from './scoring.js';
export { extractFeatures } from './features.js';
export type { BehavioralFeatures, ScoringContext } from './features.js';
// Entropy-spike intervention bridge (pure math; monitor-only, mutates nothing).
export { evaluateEntropySpike } from './entropy_bridge.js';
export type { EntropySpikeSignal } from './entropy_bridge.js';
export { LearnedBehavioralScorer, exportAuditTrainingSet, FEATURE_ORDER } from './scoring_learned.js';
export type {
  LearnedMode,
  LearnedSample,
  LabeledPacketSample,
  LearnedModel,
  LearnedScore,
  TrainOptions,
  LearnedBehavioralScorerOptions,
} from './scoring_learned.js';
export { SystemFreezeController, defaultIsHollowayToken, asFreezeControllable } from './freeze.js';
export type {
  FreezeState,
  QuarantineRecord,
  SystemFreezeControllerOptions,
} from './freeze.js';
export {
  createSovereignTokenRecognizer,
  createSovereignFreezeController,
  applySovereignFreezeOverride,
  parseOverrideToken,
  asHollowayOverrideToken,
} from './holloway_bridge.js';
export type { ApplySovereignFreezeOptions } from './holloway_bridge.js';
export { KnollActiveRouter, DEFAULT_PROBE_SURFACES } from './active_router.js';
export type {
  HealthStatus,
  HealthProbe,
  HealthProbeResult,
  HealthSample,
  KnollActiveRouterOptions,
} from './active_router.js';
