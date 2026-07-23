/**
 * nodes/matrix.ts — definitions and factory functions for the node matrix.
 *
 * Hierarchy per Big AI: SubManager (64) -> Node (64 each) -> Persona (100 per node,
 * ephemeral). Factory functions respect which Big AI owns the matrix and whether that
 * agent is ephemeral (DREAM/VISION) or always-on (HOPE/KNOLL/APEX).
 */
import type { AgentRole } from '../config/routing_schema.js';
import {
  MANAGERS_PER_AGENT,
  NODES_PER_MANAGER,
  NODES_PER_AGENT,
  PERSONAS_PER_NODE,
  TOTAL_NODES,
} from './constants.js';

export type NodeStatus = 'ACTIVE' | 'IDLE' | 'TERMINATED';

export interface NodeIdentity {
  node_id: string;
  role: AgentRole;
  managerId: string;
  status: NodeStatus;
  is_ephemeral: boolean;
  personaCapacity: number;
}

export interface SubManager {
  id: string;
  role: AgentRole;
  index: number;
  is_ephemeral: boolean;
  /** Node identities are generated lazily via `nodeIds()` to avoid materializing 20,480. */
  nodeCount: number;
}

export interface AgentMatrix {
  role: AgentRole;
  is_ephemeral: boolean;
  managers: SubManager[];
  managersPerAgent: number;
  nodesPerManager: number;
  nodesPerAgent: number;
}

/** Create the (lightweight) 64-manager matrix descriptor for one Big AI. */
export function createAgentMatrix(role: AgentRole, isEphemeral: boolean): AgentMatrix {
  const managers: SubManager[] = [];
  for (let i = 0; i < MANAGERS_PER_AGENT; i++) {
    managers.push({
      id: `${role}-mgr-${i.toString().padStart(2, '0')}`,
      role,
      index: i,
      is_ephemeral: isEphemeral,
      nodeCount: NODES_PER_MANAGER,
    });
  }
  return {
    role,
    is_ephemeral: isEphemeral,
    managers,
    managersPerAgent: MANAGERS_PER_AGENT,
    nodesPerManager: NODES_PER_MANAGER,
    nodesPerAgent: NODES_PER_AGENT,
  };
}

/** Deterministic node id for a (role, manager, node) triple. */
export function nodeId(role: AgentRole, managerIndex: number, nodeIndex: number): string {
  return `${role}-mgr-${managerIndex.toString().padStart(2, '0')}-node-${nodeIndex
    .toString()
    .padStart(2, '0')}`;
}

/** Materialize a single node identity on demand (never all 20,480 at once). */
export function createNode(role: AgentRole, managerIndex: number, nodeIndex: number, isEphemeral: boolean): NodeIdentity {
  return {
    node_id: nodeId(role, managerIndex, nodeIndex),
    role,
    managerId: `${role}-mgr-${managerIndex.toString().padStart(2, '0')}`,
    status: isEphemeral ? 'IDLE' : 'ACTIVE',
    is_ephemeral: isEphemeral,
    personaCapacity: PERSONAS_PER_NODE,
  };
}

/** Lazily iterate every node id under a manager (64 of them). */
export function* nodeIdsForManager(role: AgentRole, managerIndex: number): Generator<string> {
  for (let n = 0; n < NODES_PER_MANAGER; n++) {
    yield nodeId(role, managerIndex, n);
  }
}

/** Total node count for a single agent's matrix (4,096). */
export function nodesForAgent(): number {
  return NODES_PER_AGENT;
}

/** Total node count for the whole Big 5 fleet (20,480). */
export function totalFleetNodes(): number {
  return TOTAL_NODES;
}
