/**
 * mcp/estimate.ts — a minimal, offline cost-estimate helper for the MCP front door.
 *
 * The repository has no dedicated billing/pricing package, so this module implements a
 * small, deterministic, network-free estimator. It is intentionally simple and honest: it
 * turns an ACTIVE parameter footprint + a duration into a rough USD figure using a
 * published-here rate table, and never calls any paid API.
 *
 * The model:
 *   estimatedUsd = (activeParams / 1e9) × (durationSec / 3600) × ratePerBillionParamHour
 *
 * `ratePerBillionParamHour` is a heuristic GPU-amortized rate. A model hint scales it: local
 * / 7B tiers are cheapest, hosted frontier tiers are more expensive. Because idle personas
 * draw ~zero compute (see nodes/parameters.ts), only the ACTIVE parameter count is billed.
 */
import { MODEL_PARAMS } from '../nodes/constants.js';

/** Base rate: USD to keep one billion ACTIVE parameters resident+running for one hour. */
export const DEFAULT_RATE_PER_BILLION_PARAM_HOUR = 0.0005;

/**
 * Multipliers applied to the base rate based on a substring match against the model hint.
 * Local / small (7B-class) tiers are the cheapest; hosted frontier tiers cost more. The
 * first matching entry (in order) wins; unknown hints fall back to `1` (local-ish).
 */
export const MODEL_RATE_MULTIPLIERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/stub/i, 0.1],
  [/local|ollama|llama|mistral|qwen|phi|gemma|7b|8b/i, 1],
  [/13b|mixtral|mid/i, 2],
  [/gpt-4o-mini|mini|small|haiku|flash/i, 4],
  [/gpt-4o|gpt-4|claude|opus|sonnet|frontier|70b|large/i, 12],
];

export interface EstimateCostInput {
  /** ACTIVE parameter count (not the 14.3Q conceptual total). Coerced to a non-negative int. */
  activeParams: number;
  /** Billed duration in seconds. Coerced to a non-negative number. */
  durationSec: number;
  /** Optional model hint used to scale the base rate (see MODEL_RATE_MULTIPLIERS). */
  model?: string;
}

export interface EstimateCostResult {
  activeParams: number;
  /** activeParams / 7B — how many conceptual 7B personas that footprint represents. */
  activePersonas: number;
  durationSec: number;
  model: string;
  ratePerBillionParamHour: number;
  modelMultiplier: number;
  estimatedUsd: number;
  /** A short, human-readable derivation so callers/agents can sanity-check the number. */
  breakdown: string;
}

/** Resolve the rate multiplier for a model hint (case-insensitive, first match wins). */
export function modelMultiplier(model: string): number {
  for (const [pattern, factor] of MODEL_RATE_MULTIPLIERS) {
    if (pattern.test(model)) return factor;
  }
  return 1;
}

/**
 * Estimate the USD cost of running `activeParams` for `durationSec`. Pure, deterministic,
 * offline. Never throws for finite inputs; negative / non-finite values are floored to zero.
 */
export function estimateCost(input: EstimateCostInput): EstimateCostResult {
  const activeParams = safeNonNegative(input.activeParams, Math.floor);
  const durationSec = safeNonNegative(input.durationSec, (n) => n);
  const model = (input.model ?? 'local-7b').trim() || 'local-7b';

  const multiplier = modelMultiplier(model);
  const rate = round6(DEFAULT_RATE_PER_BILLION_PARAM_HOUR * multiplier);

  const billions = activeParams / 1e9;
  const hours = durationSec / 3600;
  const estimatedUsd = round6(billions * hours * rate);
  const activePersonas = Math.round(activeParams / MODEL_PARAMS);

  const breakdown =
    `${billions.toFixed(3)}B params × ${hours.toFixed(4)}h × ` +
    `$${rate}/B-param-h (${model} ×${multiplier}) = $${estimatedUsd}`;

  return {
    activeParams,
    activePersonas,
    durationSec,
    model,
    ratePerBillionParamHour: rate,
    modelMultiplier: multiplier,
    estimatedUsd,
    breakdown,
  };
}

function safeNonNegative(value: number, transform: (n: number) => number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return transform(value);
}

function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}
