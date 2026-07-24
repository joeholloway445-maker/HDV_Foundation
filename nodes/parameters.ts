/**
 * nodes/parameters.ts — Phase 4 parameter accounting.
 *
 * Formalizes the headline "~14.3 quadrillion parameters" figure so it is computed, not
 * asserted, and can be broken down per agent and split into CONCEPTUAL (full fleet
 * capacity) vs ACTIVE (what is actually materialized and burning compute right now).
 *
 * The core identity:
 *
 *     TOTAL_CONCEPTUAL_PARAMETERS
 *       = TOTAL_NODES × PERSONAS_PER_NODE × MODEL_PARAMS
 *       = 20,480 × 100 × 7,000,000,000
 *       = 1.4336 × 10^16   (~14.3 quadrillion)
 *
 * Idle agents cost ~zero: personas are ephemeral (spawn → execute → terminate) and nodes
 * are materialized on demand, so the ACTIVE parameter count tracks live personas only.
 * This module has no side effects and imports only the matrix constants.
 */
import {
  BIG_FIVE_COUNT,
  MODEL_PARAMS,
  MODEL_SIZE,
  NODES_PER_AGENT,
  PERSONAS_PER_NODE,
  TOTAL_CONCEPTUAL_PARAMETERS,
  TOTAL_NODES,
} from './constants.js';
import { AgentRole } from '../config/routing_schema.js';

/** Personas a single agent's matrix can host at full capacity (4,096 × 100). */
export const PERSONAS_PER_AGENT = NODES_PER_AGENT * PERSONAS_PER_NODE; // 409,600

/** Conceptual parameters under a single Big AI (4,096 × 100 × 7B). */
export const PARAMETERS_PER_AGENT = PERSONAS_PER_AGENT * MODEL_PARAMS; // 2.8672e15

/** Total ephemeral personas across the whole fleet at full capacity (20,480 × 100). */
export const TOTAL_PERSONAS = TOTAL_NODES * PERSONAS_PER_NODE; // 2,048,000

/** Which Big AI are always-on (standby) vs ephemeral (spun up on demand). */
export const ALWAYS_ON_AGENTS: readonly AgentRole[] = [AgentRole.HOPE, AgentRole.KNOLL, AgentRole.APEX];
export const EPHEMERAL_AGENTS: readonly AgentRole[] = [AgentRole.DREAM, AgentRole.VISION];

export interface AgentParameterBreakdown {
  role: AgentRole;
  alwaysOn: boolean;
  ephemeral: boolean;
  nodes: number;
  personas: number;
  parameters: number;
  /** Fraction of the fleet's total conceptual parameters this agent represents. */
  shareOfTotal: number;
}

export interface ParameterAccounting {
  modelSize: string;
  modelParams: number;
  totalNodes: number;
  personasPerNode: number;
  totalPersonas: number;
  /** Full-fleet conceptual parameter count (~1.4336e16). */
  totalConceptualParameters: number;
  perAgent: AgentParameterBreakdown[];
  bigFiveCount: number;
}

/** Compute the full conceptual accounting (per-agent breakdown included). */
export function computeParameterAccounting(): ParameterAccounting {
  const perAgent: AgentParameterBreakdown[] = Object.values(AgentRole).map((role) => ({
    role,
    alwaysOn: ALWAYS_ON_AGENTS.includes(role),
    ephemeral: EPHEMERAL_AGENTS.includes(role),
    nodes: NODES_PER_AGENT,
    personas: PERSONAS_PER_AGENT,
    parameters: PARAMETERS_PER_AGENT,
    shareOfTotal: PARAMETERS_PER_AGENT / TOTAL_CONCEPTUAL_PARAMETERS,
  }));

  return {
    modelSize: MODEL_SIZE,
    modelParams: MODEL_PARAMS,
    totalNodes: TOTAL_NODES,
    personasPerNode: PERSONAS_PER_NODE,
    totalPersonas: TOTAL_PERSONAS,
    totalConceptualParameters: TOTAL_CONCEPTUAL_PARAMETERS,
    perAgent,
    bigFiveCount: BIG_FIVE_COUNT,
  };
}

export interface ActiveParameterInput {
  /** Number of personas currently live (materialized + executing). */
  activePersonas: number;
}

export interface ActiveParameterUsage {
  activePersonas: number;
  activeParameters: number;
  /** activeParameters / totalConceptualParameters — how "lit up" the fleet is. */
  utilization: number;
  idleParameters: number;
}

/**
 * Compute the ACTIVE parameter footprint. Only live personas draw parameters; the rest of
 * the 14.3Q sits idle at ~zero compute. This is the number that maps to real GPU cost.
 */
export function computeActiveParameters(input: ActiveParameterInput): ActiveParameterUsage {
  const activePersonas = Math.max(0, Math.floor(input.activePersonas));
  const activeParameters = activePersonas * MODEL_PARAMS;
  const utilization = activeParameters / TOTAL_CONCEPTUAL_PARAMETERS;
  return {
    activePersonas,
    activeParameters,
    utilization,
    idleParameters: TOTAL_CONCEPTUAL_PARAMETERS - activeParameters,
  };
}

// ---------------------------------------------------------------------------
// Base-vs-delta accounting (Phase 6 — honest active-parameter footprint).
//
// The naive figure (`computeActiveParameters`) counts a full 7B model per live persona. That
// is the CONCEPTUAL number and is truthful for "capacity", but it is NOT what real compute
// costs once serving is shared: a vLLM replica loads the 7B BASE weights ONCE, and each
// persona is a cheap DELTA over those shared weights (a LoRA adapter + a prompt/sampling
// profile — see serving/persona_adapters.ts). The honest COST footprint is therefore:
//
//     activeCostParams = sharedBaseParams(replicas) + activePersonas × deltaParamsPerPersona
//
// This is what maps to GPU-seconds and to the eval board's cost_per_active_param_second. Idle
// personas contribute ZERO delta params, so idle ≈ $0 still holds.
// ---------------------------------------------------------------------------

/** A single 7B replica's transformer geometry (used to size a LoRA delta honestly). */
export const MODEL_HIDDEN_DIM = 4096;
export const MODEL_LAYERS = 32;
/** LoRA is applied to the q_proj and v_proj matrices by default (the standard PEFT target). */
export const LORA_TARGET_PROJECTIONS = 2;
/** Default LoRA rank for a per-persona adapter. */
export const DEFAULT_LORA_RANK = 16;

/**
 * Parameters in ONE persona's LoRA delta. For each targeted projection in each layer, LoRA adds
 * two low-rank matrices A (hidden×rank) and B (rank×hidden) → `2 · rank · hidden` params.
 * With the defaults this is ~8.39M params — about 0.12% of a 7B base, i.e. a genuinely cheap
 * delta. Prompt/sampling-only personas can pass rank = 0 (a pure prompt profile, zero weights).
 */
export function deltaParamsPerPersona(rank: number = DEFAULT_LORA_RANK): number {
  const r = Math.max(0, Math.floor(rank));
  return 2 * r * MODEL_HIDDEN_DIM * LORA_TARGET_PROJECTIONS * MODEL_LAYERS;
}

/**
 * Base weights resident across the serving fleet: the 7B model is loaded ONCE per replica,
 * regardless of how many personas ride on top of it. Defaults to a single replica.
 */
export function sharedBaseParams(replicas: number = 1): number {
  return Math.max(0, Math.floor(replicas)) * MODEL_PARAMS;
}

export interface BaseVsDeltaInput {
  /** Personas currently live (materialized + executing) as cheap deltas. */
  activePersonas: number;
  /** vLLM replicas that have the shared 7B base loaded. Default 1. */
  replicas?: number;
  /** Per-persona delta size. Default `deltaParamsPerPersona()` (~8.39M). */
  deltaParamsPerPersona?: number;
}

export interface BaseVsDeltaUsage {
  activePersonas: number;
  replicas: number;
  /** 7B base weights, counted once per replica. */
  sharedBaseParams: number;
  /** Per-persona delta size actually used in this accounting. */
  deltaParamsPerPersona: number;
  /** activePersonas × deltaParamsPerPersona — the only part that scales with load. */
  deltaParams: number;
  /** sharedBaseParams + deltaParams — the honest compute footprint (maps to GPU cost). */
  activeCostParams: number;
  /** activePersonas × MODEL_PARAMS — the naive/conceptual figure (no weight sharing). */
  naiveActiveParams: number;
  /** activeCostParams / naiveActiveParams — how much cheaper shared serving is (≤ 1). */
  amortizationRatio: number;
}

/**
 * The honest active-cost parameter count under shared serving: base weights amortized per
 * replica plus a cheap per-persona delta. This is the figure the GPU cost model and the
 * billing meter should price against, not the naive full-model-per-persona number.
 */
export function activeCostParams(input: BaseVsDeltaInput): number {
  const activePersonas = Math.max(0, Math.floor(input.activePersonas));
  const replicas = Math.max(input.replicas === undefined ? 1 : Math.floor(input.replicas), 0);
  const delta = input.deltaParamsPerPersona ?? deltaParamsPerPersona();
  return sharedBaseParams(replicas) + activePersonas * Math.max(0, delta);
}

/** Full base-vs-delta breakdown, including how much shared serving amortizes the naive figure. */
export function computeBaseVsDelta(input: BaseVsDeltaInput): BaseVsDeltaUsage {
  const activePersonas = Math.max(0, Math.floor(input.activePersonas));
  const replicas = Math.max(input.replicas === undefined ? 1 : Math.floor(input.replicas), 0);
  const perPersona = Math.max(0, input.deltaParamsPerPersona ?? deltaParamsPerPersona());
  const base = sharedBaseParams(replicas);
  const deltaParams = activePersonas * perPersona;
  const cost = base + deltaParams;
  const naive = activePersonas * MODEL_PARAMS;
  return {
    activePersonas,
    replicas,
    sharedBaseParams: base,
    deltaParamsPerPersona: perPersona,
    deltaParams,
    activeCostParams: cost,
    naiveActiveParams: naive,
    amortizationRatio: naive > 0 ? cost / naive : 0,
  };
}

/** Format a big integer count of parameters into a human word scale (quadrillion, etc). */
export function humanizeParameters(n: number): string {
  const scales: Array<[number, string]> = [
    [1e18, 'quintillion'],
    [1e15, 'quadrillion'],
    [1e12, 'trillion'],
    [1e9, 'billion'],
    [1e6, 'million'],
    [1e3, 'thousand'],
  ];
  for (const [factor, name] of scales) {
    if (Math.abs(n) >= factor) return `${(n / factor).toFixed(3)} ${name}`;
  }
  return `${n}`;
}

/**
 * Human-readable parameter report. Optionally include an ACTIVE snapshot when a live
 * persona count is supplied (e.g. from a NodeFleet or a worker payload).
 */
export function parameterReport(activePersonas?: number): string {
  const acc = computeParameterAccounting();
  const lines: string[] = [];
  lines.push('BIG 5 MATRIX — PARAMETER ACCOUNTING');
  lines.push(
    `Model: ${acc.modelSize} (${acc.modelParams.toLocaleString()} params) · ` +
      `${acc.totalNodes.toLocaleString()} nodes × ${acc.personasPerNode} personas/node`,
  );
  lines.push(
    `Total personas (full capacity): ${acc.totalPersonas.toLocaleString()}`,
  );
  lines.push(
    `TOTAL CONCEPTUAL PARAMETERS: ${acc.totalConceptualParameters.toExponential(4)} ` +
      `(~${humanizeParameters(acc.totalConceptualParameters)})`,
  );
  lines.push('');
  lines.push('Per-agent breakdown (each Big AI owns an identical 4,096-node matrix):');
  for (const a of acc.perAgent) {
    const kind = a.alwaysOn ? 'always-on' : a.ephemeral ? 'ephemeral' : 'other';
    lines.push(
      `  ${a.role.padEnd(6)} ${kind.padEnd(10)} ` +
        `${a.nodes.toLocaleString()} nodes · ${a.personas.toLocaleString()} personas · ` +
        `${a.parameters.toExponential(4)} params (${(a.shareOfTotal * 100).toFixed(1)}%)`,
    );
  }

  if (typeof activePersonas === 'number') {
    const usage = computeActiveParameters({ activePersonas });
    lines.push('');
    lines.push('ACTIVE snapshot (idle personas draw ~zero compute):');
    lines.push(
      `  live personas: ${usage.activePersonas.toLocaleString()} · ` +
        `active params: ${usage.activeParameters.toExponential(4)} ` +
        `(~${humanizeParameters(usage.activeParameters)})`,
    );
    lines.push(
      `  utilization: ${(usage.utilization * 100).toExponential(3)}% of the 14.3Q conceptual total`,
    );
  }

  return lines.join('\n');
}
