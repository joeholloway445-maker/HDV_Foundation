/**
 * dream/engine.ts — DREAM, the Simulation Layer.
 *
 * DREAM generates all *possible* outcomes for a request (ephemeral creation of
 * scenarios). Phase 2 upgrades this to a multi-branch, Monte-Carlo-style engine:
 * configurable breadth/depth, parent/child outcome trees, per-outcome risk / reward /
 * feasibility, and Pareto-style selection of the top-K outcomes.
 *
 * It connects more deeply to the ephemeral matrix: a temporary DREAM matrix slice is
 * spun up via the SubManager orchestrator + NodeFleet, personas contribute divergent
 * scenario variants, and then everything is torn down (ephemeral by contract).
 *
 * CONSTRAINTS:
 *   - DREAM CANNOT govern. Ranking/selection is simulation output, not a routing/policy
 *     decision — APEX still decides what (if anything) happens next.
 *   - DREAM CANNOT execute. It never runs a tool or touches a sandbox.
 *   - DREAM never talks to VISION (or any peer) directly. Results go back via APEX only.
 *
 * DREAM registers a handler with APEX; APEX is the only source of its inbound packets.
 */
import { AgentRole, type RoutingPacket } from '../config/routing_schema.js';
import type { AgentHandler, CreatePacketInput, DispatchResult } from '../apex/index.js';
import {
  NodeFleet,
  SubManagerOrchestrator,
  executePersona,
  spawnPersona,
  terminatePersona,
} from '../nodes/index.js';

export interface Outcome {
  id: string;
  parentId?: string;
  depth: number;
  scenario: string;
  probability: number;
  utility: number;
  /** 0..1 — likelihood/severity of things going wrong. */
  risk: number;
  /** 0..1 — value if it goes right. */
  reward: number;
  /** 0..1 — how achievable the scenario is. */
  feasibility: number;
}

/** A nested node of the outcome tree (parent/child scenario links). */
export interface OutcomeNode {
  outcome: Outcome;
  children: OutcomeNode[];
}

export interface SimulationConfig {
  /** Scenario variants per parent, per level. Default 3. */
  breadth?: number;
  /** Depth of the outcome tree. Default 2. */
  depth?: number;
  /** How many top outcomes to return in `ranked`. Default 3. */
  topK?: number;
}

export interface SimulationResult {
  intent: string;
  /** All outcomes across every level, flat. */
  outcomes: Outcome[];
  /** Nested parent/child outcome tree. */
  tree: OutcomeNode;
  /** Top-K outcomes by combined score (reward · feasibility · (1 − risk)). */
  ranked: Outcome[];
  /** Non-dominated outcomes on (reward↑, feasibility↑, risk↓). */
  pareto: Outcome[];
  personaCount: number;
  breadth: number;
  depth: number;
}

/** Optional back-channel so DREAM can return results through APEX (never directly). */
export type SendViaApex = (input: CreatePacketInput) => DispatchResult;

export class SimulationEngine {
  private readonly defaults: Required<SimulationConfig>;

  constructor(
    private readonly sendViaApex?: SendViaApex,
    config: SimulationConfig = {},
  ) {
    this.defaults = {
      breadth: config.breadth ?? 3,
      depth: config.depth ?? 2,
      topK: config.topK ?? 3,
    };
  }

  /**
   * Simulate an outcome tree for a request. Spins up a temporary DREAM matrix slice
   * (managers + nodes), dreams divergent scenario variants with ephemeral personas
   * (spawn → execute → terminate), then tears the slice down. Pure simulation.
   */
  simulate(intent: string, data: Record<string, unknown> = {}, config: SimulationConfig = {}): SimulationResult {
    const breadth = config.breadth ?? this.defaults.breadth;
    const depth = config.depth ?? this.defaults.depth;
    const topK = config.topK ?? this.defaults.topK;

    // Temporary ephemeral DREAM matrix slice: managers are activated on demand as the
    // scenario tree grows (each manager coordinates up to 64 nodes).
    const orchestrator = new SubManagerOrchestrator(AgentRole.DREAM, true);
    orchestrator.activateManagers(1);
    const fleet = new NodeFleet();

    const state = { personaCount: 0, nodeCursor: 0 };
    const outcomes: Outcome[] = [];

    const rootOutcome: Outcome = {
      id: 'root',
      depth: 0,
      scenario: `Base scenario for "${intent}"`,
      probability: 1,
      utility: 0.5,
      risk: 0.5,
      reward: 0.5,
      feasibility: 0.5,
    };
    const tree: OutcomeNode = { outcome: rootOutcome, children: [] };

    this.expand(tree, intent, data, depth, breadth, orchestrator, fleet, state, outcomes);

    // Ephemeral by contract: tear the whole slice down after dreaming — release every
    // manager that was activated during expansion.
    fleet.releaseAll();
    const managersUsed = state.nodeCursor === 0 ? 0 : Math.floor((state.nodeCursor - 1) / 64) + 1;
    for (let m = 0; m < managersUsed; m++) orchestrator.releaseManager(m);

    const ranked = [...outcomes].sort((a, b) => combinedScore(b) - combinedScore(a)).slice(0, topK);
    const pareto = paretoFrontier(outcomes);

    return { intent, outcomes, tree, ranked, pareto, personaCount: state.personaCount, breadth, depth };
  }

  private expand(
    parent: OutcomeNode,
    intent: string,
    data: Record<string, unknown>,
    remainingDepth: number,
    breadth: number,
    orchestrator: SubManagerOrchestrator,
    fleet: NodeFleet,
    state: { personaCount: number; nodeCursor: number },
    sink: Outcome[],
  ): void {
    if (remainingDepth <= 0) return;
    const level = parent.outcome.depth + 1;

    for (let i = 0; i < breadth; i++) {
      // Materialize a node on demand. As the tree grows past 64 nodes we activate the
      // next sub-manager (each coordinates up to 64 nodes) — respecting the invariants.
      const managerIndex = Math.floor(state.nodeCursor / 64) % 64;
      const nodeIndex = state.nodeCursor % 64;
      orchestrator.activateManagers(managerIndex + 1);
      const node = orchestrator.materializeNode(managerIndex, nodeIndex);
      fleet.materialize(AgentRole.DREAM, managerIndex, nodeIndex, true);
      state.nodeCursor += 1;

      const persona = spawnPersona(AgentRole.DREAM, node.node_id);
      const exec = executePersona(persona, { intent, ...data, branch: i, level, parent: parent.outcome.id });
      terminatePersona(persona);
      fleet.release(node.node_id);
      state.personaCount += 1;

      const reward = clamp01(exec.score);
      const feasibility = clamp01(derive(persona.id, 1.7, 0.31));
      const risk = clamp01(1 - (0.5 * reward + 0.5 * feasibility) + derive(persona.id, 3.1, 0.11) * 0.2);
      const outcome: Outcome = {
        id: persona.id,
        parentId: parent.outcome.id,
        depth: level,
        scenario: `Variant ${i + 1} @L${level} for "${intent}"`,
        probability: round4(1 / breadth),
        utility: round4(reward * feasibility),
        risk: round4(risk),
        reward: round4(reward),
        feasibility: round4(feasibility),
      };
      sink.push(outcome);

      const childNode: OutcomeNode = { outcome, children: [] };
      parent.children.push(childNode);
      this.expand(childNode, intent, data, remainingDepth - 1, breadth, orchestrator, fleet, state, sink);
    }
  }

  /**
   * APEX inbound handler. DREAM only ever receives packets from APEX. If a back-channel
   * was injected, DREAM returns its results by asking APEX to route them (never direct).
   */
  asHandler(): AgentHandler {
    return (packet: RoutingPacket) => {
      const cfg = readConfig(packet.payload.data);
      const result = this.simulate(packet.payload.intent, packet.payload.data, cfg);
      if (this.sendViaApex) {
        // Return path is mediated by APEX: DREAM -> APEX -> HOPE.
        this.sendViaApex({
          source: AgentRole.DREAM,
          destination: AgentRole.HOPE,
          intent: `simulation-result:${packet.payload.intent}`,
          data: {
            ranked: result.ranked,
            outcomeCount: result.outcomes.length,
            personaCount: result.personaCount,
          },
          priority: packet.header.priority,
        });
      }
      return {
        ranked: result.ranked,
        pareto: result.pareto,
        outcomeCount: result.outcomes.length,
        personaCount: result.personaCount,
        depth: result.depth,
        breadth: result.breadth,
      };
    };
  }
}

function readConfig(data: Record<string, unknown>): SimulationConfig {
  const cfg: SimulationConfig = {};
  if (typeof data.breadth === 'number') cfg.breadth = data.breadth;
  if (typeof data.depth === 'number') cfg.depth = data.depth;
  if (typeof data.topK === 'number') cfg.topK = data.topK;
  return cfg;
}

/** Combined desirability: high reward, high feasibility, low risk. */
function combinedScore(o: Outcome): number {
  return o.reward * o.feasibility * (1 - o.risk);
}

/** Non-dominated set on (reward↑, feasibility↑, risk↓). */
function paretoFrontier(outcomes: Outcome[]): Outcome[] {
  return outcomes.filter((a) => {
    return !outcomes.some(
      (b) =>
        b !== a &&
        b.reward >= a.reward &&
        b.feasibility >= a.feasibility &&
        b.risk <= a.risk &&
        (b.reward > a.reward || b.feasibility > a.feasibility || b.risk < a.risk),
    );
  });
}

/** Deterministic 0..1 derivation from a seed string + coefficients (scenario divergence). */
function derive(seed: string, mul: number, add: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const base = ((h >>> 0) % 10000) / 10000;
  return (base * mul + add) % 1;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}
