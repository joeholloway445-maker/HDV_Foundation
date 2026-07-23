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
} from './matrix.js';
export type { AgentMatrix, SubManager, NodeIdentity, NodeStatus } from './matrix.js';

export { spawnPersona, executePersona, terminatePersona } from './persona.js';
export type { Persona, PersonaState, PersonaExecution } from './persona.js';
