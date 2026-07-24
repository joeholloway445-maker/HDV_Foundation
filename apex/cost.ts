/**
 * apex/cost.ts — the GPU cost model (Phase 6: "measure, don't assert").
 *
 * Until now the APEX ledger's `cost_usd` has been a constant/estimate (see
 * docs/PHASES_5_8_STATUS.md, "Real cost ledger"). This module turns it into a MEASURED figure
 * derived from what a worker actually reports:
 *
 *     costUsd = gpuSeconds × ratePerSecond × (activeParams / 1e9)
 *
 * i.e. dollars per GPU-second, scaled by how many BILLIONS of active parameters were resident
 * while the GPU ran. `activeParams` should be the HONEST base-vs-delta figure from
 * `nodes/parameters.activeCostParams` (shared base weights amortized per replica + cheap
 * per-persona deltas), not the naive full-model-per-persona number — that is what keeps
 * "idle ≈ $0" true and the eval board's `cost_per_active_param_second` real.
 *
 * SCOPE / SEAM: this file computes cost and, OPTIONALLY, decorates a ledger `LogRequestInput`
 * with the computed `cost_usd`. It does NOT change `apex/ledger.ts` or any default: the ledger
 * still treats `cost_usd` as optional (defaulting to 0), and callers opt in by pricing their
 * input through `priceLogRequest(...)` before handing it to `ledger.logRequest(...)`. Nothing
 * routes, gates, or mutates a packet here.
 */
import type { LogRequestInput } from './ledger.js';

/** One billion — the denominator that turns a raw parameter count into "billions of params". */
export const PARAMS_PER_BILLION = 1e9;

export interface GpuCostModelOptions {
  /**
   * USD per GPU-second for one billion active parameters. This is the single knob that maps a
   * worker's measured runtime to dollars. Must be finite and >= 0.
   */
  ratePerSecond: number;
  /** Optional floor so a billable execution never rounds to exactly $0. Default 0. */
  minUsd?: number;
}

export interface GpuCostInput {
  /** GPU-seconds the execution actually consumed (as reported by the worker). */
  gpuSeconds: number;
  /**
   * Active parameters resident during the run. Prefer the honest base-vs-delta figure from
   * `nodes/parameters.activeCostParams`.
   */
  activeParams: number;
  /** Per-call override of the model's configured `ratePerSecond`. */
  ratePerSecond?: number;
}

/**
 * A GPU-seconds × $/s × (activeParams/1e9) cost model.
 *
 * Deterministic and side-effect-free: same inputs → same dollars. Negative or non-finite
 * inputs are clamped to zero so a bad worker report can never produce a negative or NaN charge.
 */
export class GpuCostModel {
  readonly ratePerSecond: number;
  readonly minUsd: number;

  constructor(options: GpuCostModelOptions) {
    if (!Number.isFinite(options.ratePerSecond) || options.ratePerSecond < 0) {
      throw new Error('GpuCostModel requires a finite, non-negative ratePerSecond.');
    }
    this.ratePerSecond = options.ratePerSecond;
    this.minUsd = options.minUsd !== undefined && options.minUsd > 0 ? options.minUsd : 0;
  }

  /** Cost of a single execution: `gpuSeconds × ratePerSecond × (activeParams / 1e9)`. */
  costUsd(input: GpuCostInput): number {
    const gpuSeconds = clampNonNegative(input.gpuSeconds);
    const activeParams = clampNonNegative(input.activeParams);
    const rate = input.ratePerSecond !== undefined ? clampNonNegative(input.ratePerSecond) : this.ratePerSecond;
    const raw = gpuSeconds * rate * (activeParams / PARAMS_PER_BILLION);
    const cost = this.minUsd > 0 && raw > 0 ? Math.max(raw, this.minUsd) : raw;
    return round6(cost);
  }

  /**
   * Return a COPY of a ledger `LogRequestInput` with `cost_usd` set from a measured GPU run.
   * The base input is never mutated; this is the optional wire into the ledger path — callers
   * that don't opt in keep the ledger's default (cost_usd → 0), unchanged.
   */
  priceLogRequest(base: LogRequestInput, usage: GpuCostInput): LogRequestInput {
    return { ...base, cost_usd: this.costUsd(usage) };
  }
}

/**
 * Free-function form of {@link GpuCostModel.priceLogRequest} for call sites that already hold a
 * model instance and prefer a functional style.
 */
export function priceLogRequest(
  base: LogRequestInput,
  model: GpuCostModel,
  usage: GpuCostInput,
): LogRequestInput {
  return model.priceLogRequest(base, usage);
}

function clampNonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}
