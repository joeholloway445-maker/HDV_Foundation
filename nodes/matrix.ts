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

// ---------------------------------------------------------------------------
// SubManager orchestration (Phase 2)
//
// A single Big AI owns 64 sub-managers, each coordinating up to 64 nodes. Idle cost is
// near-zero: managers and nodes are only *materialized* on demand and released back to
// IDLE / TERMINATED when done. The orchestrator never eagerly builds all 4,096 nodes.
// ---------------------------------------------------------------------------

export type ManagerStatus = 'IDLE' | 'ACTIVE' | 'TERMINATED';

export interface ManagerActivation {
  manager: SubManager;
  status: ManagerStatus;
  /** Node identities materialized under this manager (never more than 64). */
  activeNodes: NodeIdentity[];
}

/**
 * Coordinates the sub-manager fleet for one Big AI. Managers start IDLE (zero materialized
 * nodes) and only spin up nodes when work arrives. `activateManagers` brings up to N of the
 * 64 managers online; each can materialize up to `NODES_PER_MANAGER` nodes.
 */
export class SubManagerOrchestrator {
  readonly matrix: AgentMatrix;
  private readonly activations = new Map<string, ManagerActivation>();

  constructor(
    readonly role: AgentRole,
    readonly isEphemeral: boolean,
  ) {
    this.matrix = createAgentMatrix(role, isEphemeral);
  }

  /**
   * Activate up to `count` managers (clamped to the 64-per-agent invariant). Idempotent:
   * re-activating an already-active manager returns its existing activation.
   */
  activateManagers(count: number): ManagerActivation[] {
    const n = Math.max(0, Math.min(count, MANAGERS_PER_AGENT));
    const out: ManagerActivation[] = [];
    for (let i = 0; i < n; i++) {
      const manager = this.matrix.managers[i];
      let activation = this.activations.get(manager.id);
      if (!activation || activation.status === 'TERMINATED') {
        activation = { manager, status: 'ACTIVE', activeNodes: [] };
        this.activations.set(manager.id, activation);
      }
      out.push(activation);
    }
    return out;
  }

  /**
   * Materialize a node under an active manager, on demand. Refuses to exceed the
   * 64-nodes-per-manager invariant and refuses managers that are not ACTIVE.
   */
  materializeNode(managerIndex: number, nodeIndex: number): NodeIdentity {
    const manager = this.matrix.managers[managerIndex];
    if (!manager) throw new Error(`SubManagerOrchestrator: no manager at index ${managerIndex}`);
    const activation = this.activations.get(manager.id);
    if (!activation || activation.status !== 'ACTIVE') {
      throw new Error(`SubManagerOrchestrator: manager ${manager.id} is not ACTIVE`);
    }
    if (nodeIndex < 0 || nodeIndex >= NODES_PER_MANAGER) {
      throw new Error(`SubManagerOrchestrator: nodeIndex ${nodeIndex} out of range (0..${NODES_PER_MANAGER - 1})`);
    }
    if (activation.activeNodes.length >= NODES_PER_MANAGER) {
      throw new Error(`SubManagerOrchestrator: manager ${manager.id} at node capacity (${NODES_PER_MANAGER})`);
    }
    const node = createNode(this.role, managerIndex, nodeIndex, this.isEphemeral);
    node.status = 'ACTIVE';
    activation.activeNodes.push(node);
    return node;
  }

  /** Release a manager: all its nodes go IDLE (always-on) or TERMINATED (ephemeral). */
  releaseManager(managerIndex: number): ManagerActivation | undefined {
    const manager = this.matrix.managers[managerIndex];
    if (!manager) return undefined;
    const activation = this.activations.get(manager.id);
    if (!activation) return undefined;
    const terminalNodeStatus: NodeStatus = this.isEphemeral ? 'TERMINATED' : 'IDLE';
    for (const node of activation.activeNodes) node.status = terminalNodeStatus;
    activation.status = this.isEphemeral ? 'TERMINATED' : 'IDLE';
    activation.activeNodes = [];
    return activation;
  }

  /** Count of managers currently ACTIVE (materialized), never more than 64. */
  activeManagerCount(): number {
    let n = 0;
    for (const a of this.activations.values()) if (a.status === 'ACTIVE') n += 1;
    return n;
  }

  /** Total nodes currently materialized across all active managers. */
  activeNodeCount(): number {
    let n = 0;
    for (const a of this.activations.values()) n += a.activeNodes.length;
    return n;
  }
}
