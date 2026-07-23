/**
 * billing/pricing.ts — the pricing engine. Loads config/pricing.json and turns an ACTIVE
 * parameter footprint (activeParams × durationSec) into a concrete, explainable USD cost.
 *
 * Metering model (see config/pricing.json for the numbers):
 *
 *     activeParamSeconds = activeParams × durationSec
 *     cost = pricePerRequest + (activeParamSeconds / 1,000,000) × rate
 *
 * `rate` is USD per MILLION active-parameter-seconds. It is the tier's standard rate while the
 * account is within its included allowance, and the tier's OVERAGE rate once the included
 * allowance is spent — a clean, predictable "usage past your plan bills at the overage rate"
 * model. BYOK tiers are pass-through: $0 platform fee (or a flat passthroughFee only).
 *
 * Pure and offline: no network, no side effects, deterministic for the same inputs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODEL_PARAMS } from '../nodes/constants.js';
import type { PlanTier, RateApplied } from './types.js';
import { PLAN_TIERS, isPlanTier } from './types.js';

/** Raw per-tier row exactly as it appears in config/pricing.json (hardCapUsd may be null). */
export interface RawTierPricing {
  displayName: string;
  tagline: string;
  pricePerRequest: number;
  pricePerMillionActiveParamSeconds: number;
  overageRatePerMillionActiveParamSeconds: number;
  includedAllowanceUsd: number;
  hardCapUsd: number | null;
  byokPassthrough: boolean;
  passthroughFeeUsd: number;
}

/** Raw top-level shape of config/pricing.json. */
export interface RawPricingConfig {
  currency: string;
  meteringUnit: string;
  modelParams: number;
  version: string;
  tiers: Record<string, RawTierPricing>;
}

/** Normalized per-tier pricing (hardCapUsd Infinity when the raw value was null). */
export interface TierPricing extends Omit<RawTierPricing, 'hardCapUsd'> {
  tier: PlanTier;
  /** Infinity means "unlimited / soft cap". */
  hardCapUsd: number;
}

/** A concrete cost estimate with a full derivation, safe to show to a customer. */
export interface CostEstimate {
  tier: PlanTier;
  currency: string;
  unit: string;
  activeParams: number;
  durationSec: number;
  activeParamSeconds: number;
  /** activeParamSeconds / modelParams — usage expressed as conceptual "persona-seconds". */
  activePersonaSeconds: number;
  rate: RateApplied;
  ratePerMillionActiveParamSeconds: number;
  perRequestUsd: number;
  paramUsd: number;
  costUsd: number;
  /** One-line, human-readable derivation of costUsd. */
  breakdown: string;
}

/** A marketing-ready pricing row for GET /v1/billing/pricing. */
export interface PricingTableRow {
  tier: PlanTier;
  displayName: string;
  tagline: string;
  pricePerRequest: number;
  pricePerMillionActiveParamSeconds: number;
  overageRatePerMillionActiveParamSeconds: number;
  includedAllowanceUsd: number;
  /** null = unlimited (soft cap). */
  hardCapUsd: number | null;
  byok: boolean;
  passthroughFeeUsd: number;
  /** Included allowance re-expressed in the metering unit (null for BYOK / zero-rate). */
  includedActiveParamSeconds: number | null;
  /** Included allowance re-expressed as conceptual persona-hours (null for BYOK / zero-rate). */
  includedPersonaHours: number | null;
}

export interface EstimateInput {
  tier: PlanTier;
  activeParams: number;
  durationSec: number;
  /** Current spend on the account, used to decide included-vs-overage rate. Defaults to 0. */
  priorSpendUsd?: number;
}

/** Default location of the pricing config, resolved relative to this module (cwd-independent). */
export const DEFAULT_PRICING_PATH = fileURLToPath(new URL('../config/pricing.json', import.meta.url));

/**
 * The pricing engine. Immutable after construction: load once, price many times.
 */
export class PricingBook {
  readonly currency: string;
  readonly meteringUnit: string;
  readonly modelParams: number;
  readonly version: string;
  private readonly byTier: Map<PlanTier, TierPricing>;

  constructor(config: RawPricingConfig) {
    this.currency = config.currency ?? 'USD';
    this.meteringUnit = config.meteringUnit ?? 'active-parameter-seconds';
    this.modelParams = config.modelParams > 0 ? config.modelParams : MODEL_PARAMS;
    this.version = config.version ?? 'unknown';
    this.byTier = new Map();

    for (const tier of PLAN_TIERS) {
      const raw = config.tiers[tier];
      if (!raw) throw new Error(`pricing config is missing tier "${tier}"`);
      this.byTier.set(tier, normalizeTier(tier, raw));
    }
  }

  /** Resolve the normalized pricing for a tier (throws on unknown tier). */
  tier(tier: PlanTier): TierPricing {
    const p = this.byTier.get(tier);
    if (!p) throw new Error(`unknown plan tier "${tier}"`);
    return p;
  }

  /** All tiers in upgrade order. */
  tiers(): TierPricing[] {
    return PLAN_TIERS.map((t) => this.tier(t));
  }

  /**
   * Estimate the cost of `activeParams × durationSec` under a tier. Deterministic and pure —
   * this is exactly what `consume` charges (given the same priorSpendUsd).
   */
  estimate(input: EstimateInput): CostEstimate {
    const p = this.tier(input.tier);
    const activeParams = nonNeg(input.activeParams, Math.floor);
    const durationSec = nonNeg(input.durationSec, (n) => n);
    const priorSpendUsd = nonNeg(input.priorSpendUsd ?? 0, (n) => n);
    const activeParamSeconds = activeParams * durationSec;
    const activePersonaSeconds = round6(activeParamSeconds / this.modelParams);

    if (p.byokPassthrough) {
      const costUsd = round6(p.passthroughFeeUsd);
      return {
        tier: p.tier,
        currency: this.currency,
        unit: this.meteringUnit,
        activeParams,
        durationSec,
        activeParamSeconds,
        activePersonaSeconds,
        rate: 'byok',
        ratePerMillionActiveParamSeconds: 0,
        perRequestUsd: 0,
        paramUsd: 0,
        costUsd,
        breakdown:
          `BYOK pass-through — $0 platform fee` +
          (costUsd > 0 ? ` + $${costUsd} pass-through` : '') +
          ` (you pay only your own provider)`,
      };
    }

    // Within the included allowance you pay the standard rate; once it is exhausted, further
    // usage bills at the overage rate. A single, explainable threshold.
    const withinIncluded = priorSpendUsd < p.includedAllowanceUsd;
    const rateApplied: RateApplied = withinIncluded ? 'included' : 'overage';
    const rate = withinIncluded ? p.pricePerMillionActiveParamSeconds : p.overageRatePerMillionActiveParamSeconds;

    const perRequestUsd = round6(p.pricePerRequest);
    const paramUsd = round6((activeParamSeconds / 1_000_000) * rate);
    const costUsd = round6(perRequestUsd + paramUsd);

    const breakdown =
      `$${perRequestUsd}/req + ${(activeParamSeconds / 1_000_000).toFixed(4)}M param-sec × ` +
      `$${rate}/M (${rateApplied}) = $${costUsd}`;

    return {
      tier: p.tier,
      currency: this.currency,
      unit: this.meteringUnit,
      activeParams,
      durationSec,
      activeParamSeconds,
      activePersonaSeconds,
      rate: rateApplied,
      ratePerMillionActiveParamSeconds: rate,
      perRequestUsd,
      paramUsd,
      costUsd,
      breakdown,
    };
  }

  /** Build the public, marketing-ready pricing table (GET /v1/billing/pricing). */
  publicTable(): { currency: string; meteringUnit: string; modelParams: number; version: string; generatedAt: number; tiers: PricingTableRow[] } {
    const tiers = this.tiers().map((p): PricingTableRow => {
      const rate = p.pricePerMillionActiveParamSeconds;
      // included budget → included active-param-seconds → persona-hours (for the marketing card).
      const includedActiveParamSeconds =
        !p.byokPassthrough && rate > 0 ? Math.round((p.includedAllowanceUsd / rate) * 1_000_000) : null;
      const includedPersonaHours =
        includedActiveParamSeconds !== null ? round6(includedActiveParamSeconds / this.modelParams / 3600) : null;
      return {
        tier: p.tier,
        displayName: p.displayName,
        tagline: p.tagline,
        pricePerRequest: p.pricePerRequest,
        pricePerMillionActiveParamSeconds: p.pricePerMillionActiveParamSeconds,
        overageRatePerMillionActiveParamSeconds: p.overageRatePerMillionActiveParamSeconds,
        includedAllowanceUsd: p.includedAllowanceUsd,
        hardCapUsd: Number.isFinite(p.hardCapUsd) ? p.hardCapUsd : null,
        byok: p.byokPassthrough,
        passthroughFeeUsd: p.passthroughFeeUsd,
        includedActiveParamSeconds,
        includedPersonaHours,
      };
    });
    return {
      currency: this.currency,
      meteringUnit: this.meteringUnit,
      modelParams: this.modelParams,
      version: this.version,
      generatedAt: Date.now(),
      tiers,
    };
  }
}

/**
 * Load a PricingBook from disk. Defaults to config/pricing.json (resolved relative to this
 * module, so it works regardless of the process cwd). Honors HDV_PRICING_PATH when set.
 */
export function loadPricingBook(path?: string, env: NodeJS.ProcessEnv = process.env): PricingBook {
  const resolved = path ?? (env.HDV_PRICING_PATH && env.HDV_PRICING_PATH.trim().length > 0 ? env.HDV_PRICING_PATH.trim() : DEFAULT_PRICING_PATH);
  const raw = readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw) as RawPricingConfig;
  return new PricingBook(parsed);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalizeTier(tier: PlanTier, raw: RawTierPricing): TierPricing {
  if (!isPlanTier(tier)) throw new Error(`invalid plan tier "${tier}"`);
  return {
    tier,
    displayName: raw.displayName,
    tagline: raw.tagline,
    pricePerRequest: nonNeg(raw.pricePerRequest, (n) => n),
    pricePerMillionActiveParamSeconds: nonNeg(raw.pricePerMillionActiveParamSeconds, (n) => n),
    overageRatePerMillionActiveParamSeconds: nonNeg(raw.overageRatePerMillionActiveParamSeconds, (n) => n),
    includedAllowanceUsd: nonNeg(raw.includedAllowanceUsd, (n) => n),
    hardCapUsd: raw.hardCapUsd === null || raw.hardCapUsd === undefined ? Infinity : nonNeg(raw.hardCapUsd, (n) => n),
    byokPassthrough: Boolean(raw.byokPassthrough),
    passthroughFeeUsd: nonNeg(raw.passthroughFeeUsd ?? 0, (n) => n),
  };
}

function nonNeg(value: number, transform: (n: number) => number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return transform(value);
}

/** Round to 6 dp to match the ledger's micro-billing precision and remove FP dust. */
function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}
