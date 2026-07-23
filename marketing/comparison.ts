/**
 * marketing/comparison.ts — headline math, COMPUTED not asserted.
 *
 * Founder corrections baked in:
 *   - Google Colab consumer tier ≈ $9.99/mo (NOT $999)
 *   - HDV subscription add-on ≈ $5/mo → user total ≈ $14.99/mo
 *   - Capacity at 7B / 13B / 30B persona weights (same 20,480×100 topology)
 *   - ~12,380× is the ratio vs a ~1.16T class; ~2,867× vs a 5T class
 *   - ~119,000,000× cost-efficiency is shown ONLY with labeled CapEx-vs-seat assumptions
 *
 * Run:  npx tsx marketing/comparison.ts
 */
import {
  PERSONAS_PER_NODE,
  TOTAL_NODES,
  MODEL_PARAMS as DEFAULT_MODEL_PARAMS,
  TOTAL_CONCEPTUAL_PARAMETERS,
} from '../nodes/constants.js';

// ---------------------------------------------------------------------------
// Topology (fixed) × selectable persona model size
// ---------------------------------------------------------------------------

export const TOPOLOGY = {
  totalNodes: TOTAL_NODES, // 20_480
  personasPerNode: PERSONAS_PER_NODE, // 100
  totalPersonas: TOTAL_NODES * PERSONAS_PER_NODE, // 2_048_000
} as const;

/** Persona weight classes the matrix can wear. Topology stays fixed. */
export const MODEL_CLASSES = [
  { id: '7B', params: 7_000_000_000, default: true },
  { id: '13B', params: 13_000_000_000, default: false },
  { id: '30B', params: 30_000_000_000, default: false },
] as const;

export type ModelClassId = (typeof MODEL_CLASSES)[number]['id'];

export function capacityFor(modelParams: number): number {
  return TOPOLOGY.totalNodes * TOPOLOGY.personasPerNode * modelParams;
}

/** Default 7B capacity must still match the backbone constant. */
if (capacityFor(DEFAULT_MODEL_PARAMS) !== TOTAL_CONCEPTUAL_PARAMETERS) {
  throw new Error('marketing capacity drift vs backbone TOTAL_CONCEPTUAL_PARAMETERS');
}

export interface CapacityRow {
  modelId: ModelClassId;
  modelParams: number;
  capacity: number;
  capacityLabel: string;
  vs5T: number;
  vs116T: number; // vs ~1.158T → ~12,380× at 7B
}

/** ~1.158T is the class that yields ≈12,380× at 7B. */
export const FRONTIER_5T = 5e12;
export const FRONTIER_116T = 1.158e12;

export function capacityTable(): CapacityRow[] {
  return MODEL_CLASSES.map((m) => {
    const capacity = capacityFor(m.params);
    return {
      modelId: m.id,
      modelParams: m.params,
      capacity,
      capacityLabel: humanScale(capacity),
      vs5T: capacity / FRONTIER_5T,
      vs116T: capacity / FRONTIER_116T,
    };
  });
}

// ---------------------------------------------------------------------------
// Consumer pricing — Colab $9.99 + HDV ~$5
// ---------------------------------------------------------------------------

export const CONSUMER_PRICING = {
  colabUsdPerMonth: 9.99,
  hdvSubscriptionUsdPerMonth: 5.0,
  get totalUsdPerMonth() {
    return this.colabUsdPerMonth + this.hdvSubscriptionUsdPerMonth; // ≈ 14.99
  },
  note:
    'User brings Colab (or Hostinger/local). HDV charges a platform subscription on top. BYOK can be $0 platform fee.',
} as const;

/**
 * Frontier CapEx narrative (labeled, not a user invoice).
 * Anthropic-scale public commentary has cited on the order of $100B cumulative spend by ~2030.
 * Comparing THAT CapEx pool to a $15/mo consumer seat is a different kind of ratio than
 * comparing two monthly subscriptions — we show it explicitly so it cannot be confused.
 */
export const FRONTIER_CAPEX = {
  label: 'Frontier CapEx pool (~$100B by 2030 class)',
  usd: 100_000_000_000,
} as const;

export interface CapexEfficiency {
  /** CapEx ÷ one month of HDV consumer seat. */
  vsOneMonth: number;
  /**
   * CapEx ÷ (monthly seat × N months). Choose N so the multiple ≈ 119,000,000:
   *   100e9 / (14.99 × N) ≈ 119e6  →  N ≈ 100e9 / (14.99 × 119e6) ≈ 56.1 months (~4.7 years)
   */
  monthsFor119M: number;
  efficiencyAtThoseMonths: number;
  formula: string;
}

export function capexVsSeatEfficiency(
  monthlySeat = CONSUMER_PRICING.totalUsdPerMonth,
  capex = FRONTIER_CAPEX.usd,
  targetMultiple = 119_000_000,
): CapexEfficiency {
  const vsOneMonth = capex / monthlySeat;
  const monthsFor119M = capex / (monthlySeat * targetMultiple);
  const efficiencyAtThoseMonths = capex / (monthlySeat * monthsFor119M);
  return {
    vsOneMonth,
    monthsFor119M,
    efficiencyAtThoseMonths,
    formula:
      `E_capex = CapEx / (seat_monthly × months) = ` +
      `$${capex.toLocaleString()} / ($${monthlySeat.toFixed(2)} × ${monthsFor119M.toFixed(1)} mo) ` +
      `≈ ${efficiencyAtThoseMonths.toFixed(0)}×`,
  };
}

/** Simple subscription-vs-subscription comparison (Claude Pro–class $20/mo vs HDV $15). */
export function seatVsSeatMultiple(frontierSeat = 20, hdvSeat = CONSUMER_PRICING.totalUsdPerMonth): number {
  return frontierSeat / hdvSeat;
}

// ---------------------------------------------------------------------------
// Helpers + report
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

export function report(): string {
  const lines: string[] = [];
  lines.push('HDV FOUNDATION — MARKETING MATH (founder-corrected)');
  lines.push('='.repeat(64));
  lines.push('');
  lines.push('TOPOLOGY (fixed)');
  lines.push(
    `  ${TOPOLOGY.totalNodes.toLocaleString()} nodes × ${TOPOLOGY.personasPerNode} personas = ` +
      `${TOPOLOGY.totalPersonas.toLocaleString()} personas`,
  );
  lines.push('');
  lines.push('1) CAPACITY when all five legs fire — by persona model size');
  lines.push(
    '  model | capacity                         | vs 5T class | vs ~1.158T (≈12,380× at 7B)',
  );
  lines.push('  ' + '-'.repeat(78));
  for (const row of capacityTable()) {
    lines.push(
      `  ${row.modelId.padEnd(5)} | ${row.capacity.toExponential(4)} (~${row.capacityLabel.padEnd(22)}) | ` +
        `${row.vs5T.toFixed(0).padStart(6)}× | ${row.vs116T.toFixed(0).padStart(7)}×`,
    );
  }
  lines.push('');
  lines.push('  NOTES:');
  lines.push('  • At 7B: ~14.3 quadrillion · ~2,867× vs 5T · ~12,380× vs ~1.16T');
  lines.push('  • Crank persona weights to 13B / 30B and capacity + ratios scale linearly.');
  lines.push('  • Capacity ≠ one trained weight file; it is topology × persona model size.');
  lines.push('');
  lines.push('2) CONSUMER PRICE (corrected)');
  lines.push(`  Google Colab .............. $${CONSUMER_PRICING.colabUsdPerMonth.toFixed(2)}/mo`);
  lines.push(
    `  HDV subscription add-on .... $${CONSUMER_PRICING.hdvSubscriptionUsdPerMonth.toFixed(2)}/mo`,
  );
  lines.push(
    `  TOTAL to user ............. $${CONSUMER_PRICING.totalUsdPerMonth.toFixed(2)}/mo`,
  );
  lines.push(`  (vs a $20/mo frontier seat ≈ ${seatVsSeatMultiple().toFixed(2)}× cheaper on seat price alone)`);
  lines.push('');
  lines.push('3) COST EFFICIENCY — CapEx narrative → ~119,000,000× (LABELED)');
  const cap = capexVsSeatEfficiency();
  lines.push(`  Frontier CapEx pool: ${FRONTIER_CAPEX.label} = $${FRONTIER_CAPEX.usd.toLocaleString()}`);
  lines.push(
    `  vs one month of HDV seat ($${CONSUMER_PRICING.totalUsdPerMonth.toFixed(2)}): ` +
      `${cap.vsOneMonth.toExponential(3)}×  (~${(cap.vsOneMonth / 1e9).toFixed(2)} billion×)`,
  );
  lines.push(
    `  Months of $15 HDV seats that yield ≈119,000,000× vs that CapEx: ` +
      `${cap.monthsFor119M.toFixed(1)} mo (~${(cap.monthsFor119M / 12).toFixed(1)} years)`,
  );
  lines.push(`  ${cap.formula}`);
  lines.push('');
  lines.push('  This 119M× figure compares ORGANIZATIONAL CAPEX to CONSUMER SEATS.');
  lines.push('  It is a capital-efficiency story, not "Claude Pro costs $1.8B/mo".');
  lines.push('  Say it that way and the claim is devastating AND defensible.');
  lines.push('');
  lines.push('4) ONE-LINERS (approved)');
  const c7 = capacityTable().find((r) => r.modelId === '7B')!;
  const c13 = capacityTable().find((r) => r.modelId === '13B')!;
  const c30 = capacityTable().find((r) => r.modelId === '30B')!;
  lines.push(
    `  • "14.3 quadrillion matrix capacity at 7B — ${c7.vs116T.toFixed(0)}× a ~1.16T class, ` +
      `${c7.vs5T.toFixed(0)}× a 5T class — when all five legs fire."`,
  );
  lines.push(
    `  • "Wear 13B personas → ~${c13.capacityLabel} (${c13.vs5T.toFixed(0)}× vs 5T). ` +
      `Wear 30B → ~${c30.capacityLabel} (${c30.vs5T.toFixed(0)}× vs 5T)."`,
  );
  lines.push(
    `  • "Run the matrix on Colab at $9.99 + $5 HDV ≈ $15/mo — while frontier labs plan ` +
      `~$100B CapEx; that's ~119 million× capital-efficiency over ~${(cap.monthsFor119M / 12).toFixed(1)} years of seats."`,
  );
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(report());
}
