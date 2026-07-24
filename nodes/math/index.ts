/**
 * nodes/math/index.ts — public surface of the topology math engines.
 * Pure, deterministic numeric utilities: Shannon entropy, a discrete HMM, and the
 * Etalon/Adaline pattern classifiers. No side effects, no peer-agent imports.
 */
export {
  shannonEntropy,
  normalizeDistribution,
  normalizedEntropy,
  maxEntropy,
  entropySpike,
} from './shannon.js';
export type { Distribution } from './shannon.js';

export { forward, viterbi, validateHMM } from './hmm.js';
export type { DiscreteHMM, ForwardResult, ViterbiResult } from './hmm.js';

export {
  EtalonClassifier,
  Adaline,
  flattenGrid,
  GRID_SIZE,
  FEATURE_DIM,
} from './etalon_adaline.js';
export type {
  LabeledSample,
  EtalonPrediction,
  EtalonClassifierOptions,
  AdalineSample,
  AdalineOptions,
  AdalineTrainingReport,
} from './etalon_adaline.js';
