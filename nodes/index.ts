/**
 * nodes/index.ts — public surface of the node matrix layer.
 * The 20,480-node topology, factory functions, and the ephemeral persona lifecycle.
 */
export {
  MANAGERS_PER_AGENT,
  NODES_PER_MANAGER,
  NODES_PER_AGENT,
  BIG_FIVE_COUNT,
  TOTAL_NODES,
  PERSONAS_PER_NODE,
  MODEL_SIZE,
  MODEL_PARAMS,
  TOTAL_CONCEPTUAL_PARAMETERS,
} from './constants.js';

export {
  createAgentMatrix,
  createNode,
  nodeId,
  nodeIdsForManager,
  nodesForAgent,
  totalFleetNodes,
  SubManagerOrchestrator,
} from './matrix.js';
export type {
  AgentMatrix,
  SubManager,
  NodeIdentity,
  NodeStatus,
  ManagerStatus,
  ManagerActivation,
} from './matrix.js';

export { spawnPersona, executePersona, terminatePersona } from './persona.js';
export type { Persona, PersonaState, PersonaExecution } from './persona.js';

export { SpecialtyRouter, SPECIALIZATIONS, PERSONA_SPECIALTIES } from './specialization.js';
export type {
  PersonaSpecialty,
  PersonaSpecialization,
  SpecialtyMatch,
  SpecialtyAssignment,
  SpecialtyRouterOptions,
} from './specialization.js';

export { NodeFleet } from './lifecycle.js';
export type { NodeFleetOptions } from './lifecycle.js';

export { runPersonaPipeline } from './pipeline.js';
export type { PipelineRole, PipelineStageResult, PipelineResult } from './pipeline.js';

export {
  PERSONAS_PER_AGENT,
  PARAMETERS_PER_AGENT,
  TOTAL_PERSONAS,
  ALWAYS_ON_AGENTS,
  EPHEMERAL_AGENTS,
  computeParameterAccounting,
  computeActiveParameters,
  humanizeParameters,
  parameterReport,
} from './parameters.js';
export type {
  AgentParameterBreakdown,
  ParameterAccounting,
  ActiveParameterInput,
  ActiveParameterUsage,
} from './parameters.js';

// Topology math engines (pure/deterministic): Shannon entropy, discrete HMM, Etalon/Adaline.
export {
  shannonEntropy,
  normalizeDistribution,
  normalizedEntropy,
  maxEntropy,
  entropySpike,
  forward,
  viterbi,
  validateHMM,
  EtalonClassifier,
  Adaline,
  flattenGrid,
  GRID_SIZE,
  FEATURE_DIM,
} from './math/index.js';
export type {
  Distribution,
  DiscreteHMM,
  ForwardResult,
  ViterbiResult,
  LabeledSample,
  EtalonPrediction,
  EtalonClassifierOptions,
  AdalineSample,
  AdalineOptions,
  AdalineTrainingReport,
} from './math/index.js';
