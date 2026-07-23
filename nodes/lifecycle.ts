/**
 * nodes/lifecycle.ts — fleet lifecycle management (Phase 2).
 *
 * The 20,480-node fleet is conceptual: at rest it costs ~nothing because nodes are only
 * *materialized* on demand and released afterward. This module tracks the live subset of
 * node identities and their status transitions (IDLE ⇄ ACTIVE → TERMINATED), and can
 * optionally mirror each identity into a NodeIdentityRepository for durability.
 *
 * Ephemeral agents (DREAM/VISION) terminate their nodes on release; always-on agents
 * (HOPE/KNOLL/APEX) return their nodes to IDLE (kept warm, but not billed as active).
 */
import type { AgentRole } from '../config/routing_schema.js';
import type { NodeIdentityRepository } from '../persistence/repositories.js';
import { TOTAL_NODES } from './constants.js';
import { createNode, nodeId, type NodeIdentity, type NodeStatus } from './matrix.js';

export interface NodeFleetOptions {
  /** Optional durable mirror for materialized node identities. */
  repository?: NodeIdentityRepository;
}

/**
 * Tracks only the *materialized* fraction of the fleet. Idle cost is near zero: an empty
 * fleet holds no node identities at all — the 20,480 total is a capacity, not a rows count.
 */
export class NodeFleet {
  private readonly live = new Map<string, NodeIdentity>();
  private readonly repository?: NodeIdentityRepository;

  constructor(options: NodeFleetOptions = {}) {
    this.repository = options.repository;
  }

  /** The fleet's total *capacity* (never all materialized at once). */
  get capacity(): number {
    return TOTAL_NODES;
  }

  /**
   * Materialize (or re-activate) a node on demand. Only at this point does the node get a
   * live identity; before this call it costs nothing.
   */
  materialize(role: AgentRole, managerIndex: number, nodeIndex: number, isEphemeral: boolean): NodeIdentity {
    const id = nodeId(role, managerIndex, nodeIndex);
    let node = this.live.get(id);
    if (!node) {
      node = createNode(role, managerIndex, nodeIndex, isEphemeral);
    }
    node.status = 'ACTIVE';
    this.live.set(id, node);
    this.mirror(node);
    return node;
  }

  /**
   * Release a node. Ephemeral nodes go TERMINATED and are dropped from the live set
   * (identity released); always-on nodes return to IDLE (kept warm).
   */
  release(nodeIdStr: string): NodeIdentity | undefined {
    const node = this.live.get(nodeIdStr);
    if (!node) return undefined;
    const next: NodeStatus = node.is_ephemeral ? 'TERMINATED' : 'IDLE';
    node.status = next;
    this.mirror(node);
    if (next === 'TERMINATED') {
      // Ephemeral identities are released back to the pool — fleet idle cost stays ~0.
      this.live.delete(nodeIdStr);
    }
    return node;
  }

  /** Release every live node in one sweep (e.g. tearing down an ephemeral agent). */
  releaseAll(): void {
    for (const id of Array.from(this.live.keys())) this.release(id);
  }

  /** Number of nodes currently materialized (ACTIVE or warm IDLE). */
  liveCount(): number {
    return this.live.size;
  }

  activeCount(): number {
    let n = 0;
    for (const node of this.live.values()) if (node.status === 'ACTIVE') n += 1;
    return n;
  }

  idleCount(): number {
    let n = 0;
    for (const node of this.live.values()) if (node.status === 'IDLE') n += 1;
    return n;
  }

  snapshot(): readonly NodeIdentity[] {
    return Array.from(this.live.values());
  }

  private mirror(node: NodeIdentity): void {
    this.repository?.upsert({
      node_id: node.node_id,
      role: node.role,
      status: node.status,
      last_seen: Date.now(),
      is_ephemeral: node.is_ephemeral,
    });
  }
}
