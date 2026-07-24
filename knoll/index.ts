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
