/**
 * marketing/comparison.ts — the headline math, COMPUTED not asserted.
 *
 * This module is the single source of truth behind every number on the marketing page:
 *   1. The 14.3-quadrillion conceptual capacity (topology × 7B).
 *   2. The capacity ratio vs a frontier-class model (the "N× the frontier" line).
 *   3. The cost-efficiency worked example (idle-cheap ephemeral GPUs vs always-on serving).
 *
 * HONESTY CONTRACT (do not break):
 *   - 14.3Q is a *capacity* figure: TOPOLOGY × 7B, i.e. how much addressable persona-capacity
 *     the matrix can express when every leg fires. It is NOT a single trained 14.3Q weight file.
 *   - The capacity ratio (≈2,867× vs a 5T class) is a ratio of *addressable parameters*, not a
 *     benchmark of intelligence. We out-scale the frontier in addressable capacity, not IQ.
 *   - The cost-efficiency multiple is derived from labeled assumptions with a transparent
 *     formula. There is no magic "119,000,000×". Large multiples come honestly from low
 *     utilization × cheap ephemeral GPU-hours, and every input is a knob you can change.
 *
 * It imports the matrix constants so the capacity number can never drift from the backbone.
 * Pure, offline, deterministic. Run it:  npx tsx marketing/comparison.ts
 */
import {
  MODEL_PARAMS,
  PERSONAS_PER_NODE,
  TOTAL_CONCEPTUAL_PARAMETERS,
  TOTAL_NODES,
} from '../nodes/constants.js';

// ---------------------------------------------------------------------------
// 1. CONCEPTUAL CAPACITY — 14.3 quadrillion, when all five legs fire
// ---------------------------------------------------------------------------

/**
 * The headline capacity, recomputed here from first principles so the page's number is
 * provably `20,480 × 100 × 7,000,000,000`. It equals the backbone's TOTAL_CONCEPTUAL_PARAMETERS.
 *
 *   20,480 nodes × 100 personas/node × 7B params = 1.4336e16 (~14.3 quadrillion)
 */
export const CONCEPTUAL_CAPACITY = TOTAL_NODES * PERSONAS_PER_NODE * MODEL_PARAMS;

// Sanity: the marketing number must match the backbone constant exactly, or the build lies.
if (CONCEPTUAL_CAPACITY !== TOTAL_CONCEPTUAL_PARAMETERS) {
  throw new Error(
    `marketing capacity drift: ${CONCEPTUAL_CAPACITY} !== backbone ${TOTAL_CONCEPTUAL_PARAMETERS}`,
  );
}

// ---------------------------------------------------------------------------
// 2. CAPACITY RATIO vs a frontier-class model
// ---------------------------------------------------------------------------

/** A frontier-class model to compare against, expressed in parameters. */
export interface FrontierClass {
  /** Short label used in copy, e.g. "5T frontier class". */
  label: string;
  /** Reported/assumed parameter count of the frontier model. */
  params: number;
  /** Whether this is our PRIMARY, mathematically-clean comparison. */
  primary: boolean;
  note: string;
}

/**
 * The comparison set. The PRIMARY, accurate figure is 14.3Q vs a ~5-trillion-parameter
 * frontier class (e.g. reported Claude-scale) → 2,867×.
 *
 * The 12,380× number is ONLY correct against a ~1.158-trillion-parameter class. We publish it
 * as a secondary, clearly-scoped comparison — never as the headline against a 5T model.
 */
export const FRONTIER_CLASSES: readonly FrontierClass[] = [
  {
    label: '5T frontier class',
    params: 5e12,
    primary: true,
    note: 'Reported frontier-scale (e.g. ~5-trillion-parameter class). Our primary, accurate ratio.',
  },
  {
    label: '~1.158T class',
    params: 1.158e12,
    primary: false,
    note: 'The only class for which the ratio is ≈12,380×. Use only when explicitly comparing to ~1.16T.',
  },
];

export interface CapacityRatio {
  label: string;
  frontierParams: number;
  ratio: number;
  primary: boolean;
  note: string;
}

/** Compute 14.3Q ÷ frontierParams for a given class. */
export function capacityRatio(frontier: FrontierClass): CapacityRatio {
  return {
    label: frontier.label,
    frontierParams: frontier.params,
    ratio: CONCEPTUAL_CAPACITY / frontier.params,
    primary: frontier.primary,
    note: frontier.note,
  };
}

/** All configured capacity ratios. */
export function capacityRatios(): CapacityRatio[] {
  return FRONTIER_CLASSES.map(capacityRatio);
}

/** The single primary, accurate ratio (2,867× vs the 5T class). */
export function primaryCapacityRatio(): CapacityRatio {
  const primary = FRONTIER_CLASSES.find((f) => f.primary);
  if (!primary) throw new Error('no primary frontier class configured');
  return capacityRatio(primary);
}

// ---------------------------------------------------------------------------
// 3. COST EFFICIENCY — transparent worked example (NO magic number)
// ---------------------------------------------------------------------------

/**
 * The cost-efficiency model. We compare, over one billing period:
 *
 *   ALWAYS-ON BASELINE  — a frontier endpoint you reserve 24/7:
 *       cost_on  = hoursInPeriod × onDemandRatePerHour
 *
 *   HDV EPHEMERAL       — you only pay for the GPU-hours a persona is actually live:
 *       cost_hdv = activeGpuHours × ephemeralRatePerHour
 *
 * Efficiency multiple:
 *
 *       E = cost_on / cost_hdv
 *         = (hoursInPeriod × onDemandRatePerHour) / (activeGpuHours × ephemeralRatePerHour)
 *         = (1 / utilization) × (onDemandRatePerHour / ephemeralRatePerHour)
 *
 * where utilization = activeGpuHours / hoursInPeriod.
 *
 * So E is the product of exactly TWO labeled levers:
 *   - the UTILIZATION lever   (1 / u): always-on pays for every hour; you pay for active hours.
 *   - the RATE lever          (R_on / R_eph): reserved frontier GPU-hour vs cheap ephemeral one.
 *
 * Large multiples are honest consequences of low utilization and cheap idle-billed GPUs — not a
 * headline pulled from thin air. Change the knobs, the multiple changes; nothing is hidden.
 */
export interface CostScenario {
  label: string;
  /** Hours in the billing period (730 ≈ one month). */
  hoursInPeriod: number;
  /** GPU-hours a persona is actually live and billable in the period. */
  activeGpuHours: number;
  /** USD/hour to keep an always-on frontier endpoint reserved. */
  onDemandRatePerHour: number;
  /** USD/hour for an ephemeral commodity GPU (Colab Pro+ / Hostinger, idle-billed). */
  ephemeralRatePerHour: number;
}

export interface CostEfficiencyResult {
  label: string;
  utilization: number;
  utilizationFactor: number;
  rateFactor: number;
  alwaysOnCostUsd: number;
  hdvCostUsd: number;
  efficiencyMultiple: number;
  breakdown: string;
}

/** Compute the cost-efficiency multiple for one fully-labeled scenario. */
export function costEfficiency(s: CostScenario): CostEfficiencyResult {
  const utilization = s.activeGpuHours / s.hoursInPeriod;
  const utilizationFactor = 1 / utilization;
  const rateFactor = s.onDemandRatePerHour / s.ephemeralRatePerHour;
  const alwaysOnCostUsd = s.hoursInPeriod * s.onDemandRatePerHour;
  const hdvCostUsd = s.activeGpuHours * s.ephemeralRatePerHour;
  const efficiencyMultiple = alwaysOnCostUsd / hdvCostUsd;
  const breakdown =
    `$${alwaysOnCostUsd.toLocaleString()} always-on ÷ $${hdvCostUsd.toLocaleString()} HDV = ` +
    `${efficiencyMultiple.toFixed(0)}× ` +
    `(utilization ${(utilization * 100).toFixed(2)}% → ${utilizationFactor.toFixed(0)}× · ` +
    `rate ${rateFactor.toFixed(0)}×)`;
  return {
    label: s.label,
    utilization,
    utilizationFactor,
    rateFactor,
    alwaysOnCostUsd,
    hdvCostUsd,
    efficiencyMultiple,
    breakdown,
  };
}

/**
 * Three fully-labeled scenarios spanning conservative → aggressive. Each is a real computation
 * from its assumptions; none is cherry-picked as "the" number. Real figures land after the
 * design-partner cost benchmark (docs/ROADMAP.md 6.3) turns ledger cost_usd into measured
 * GPU-seconds × $/s.
 */
export const COST_SCENARIOS: readonly CostScenario[] = [
  {
    // One reserved cloud GPU always on, vs commodity ephemeral, at moderate 20% utilization.
    label: 'Conservative (20% utilization)',
    hoursInPeriod: 730,
    activeGpuHours: 146, // 20% of 730
    onDemandRatePerHour: 8,
    ephemeralRatePerHour: 2,
  },
  {
    // A reserved multi-GPU frontier node vs Colab-class ephemeral, bursty 5% utilization.
    label: 'Moderate (5% utilization)',
    hoursInPeriod: 730,
    activeGpuHours: 36.5, // 5% of 730
    onDemandRatePerHour: 24,
    ephemeralRatePerHour: 1.2,
  },
  {
    // A reserved 5T-class multi-node endpoint vs spot/Colab T4, truly bursty 0.5% utilization.
    label: 'Aggressive (0.5% utilization)',
    hoursInPeriod: 730,
    activeGpuHours: 3.65, // 0.5% of 730
    onDemandRatePerHour: 90,
    ephemeralRatePerHour: 0.6,
  },
];

/** All configured cost-efficiency scenarios, computed. */
export function costEfficiencies(): CostEfficiencyResult[] {
  return COST_SCENARIOS.map(costEfficiency);
}

// ---------------------------------------------------------------------------
// Human-readable scale helper (mirrors nodes/parameters.humanizeParameters).
// ---------------------------------------------------------------------------

export function humanScale(n: number): string {
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

// ---------------------------------------------------------------------------
// CLI report — run `npx tsx marketing/comparison.ts` to print every number.
// ---------------------------------------------------------------------------

export function report(): string {
  const lines: string[] = [];
  lines.push('HDV FOUNDATION — MARKETING MATH (computed, not asserted)');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push('1) CONCEPTUAL CAPACITY (all five legs firing)');
  lines.push(`   20,480 nodes × 100 personas × 7B params`);
  lines.push(
    `   = ${CONCEPTUAL_CAPACITY.toExponential(4)} (~${humanScale(CONCEPTUAL_CAPACITY)} parameters)`,
  );
  lines.push('   NOTE: capacity the topology can express — not a single trained weight file.');
  lines.push('');
  lines.push('2) CAPACITY RATIO vs a frontier-class model');
  for (const r of capacityRatios()) {
    const tag = r.primary ? ' [PRIMARY]' : '';
    lines.push(
      `   14.3Q ÷ ${r.frontierParams.toExponential(2)} (${r.label}) = ` +
        `${r.ratio.toFixed(1)}×${tag}`,
    );
    lines.push(`     ${r.note}`);
  }
  lines.push('');
  lines.push('3) COST EFFICIENCY (idle-cheap ephemeral vs always-on) — worked examples');
  lines.push('   E = (1 / utilization) × (onDemandRate / ephemeralRate)');
  for (const c of costEfficiencies()) {
    lines.push(`   ${c.label}: ${c.breakdown}`);
  }
  lines.push('');
  lines.push('   No magic number: change any knob and the multiple changes. Real $/intent lands');
  lines.push('   after the design-partner cost benchmark (docs/ROADMAP.md 6.3).');
  return lines.join('\n');
}

// Print when executed directly (tsx/node ESM entrypoint check).
if (import.meta.url === `file://${process.argv[1]}`) {
  // eslint-disable-next-line no-console
  console.log(report());
}
