/**
 * nodes/math/shannon.ts — Shannon entropy over discrete distributions and the KNOLL
 * entropy-spike intervention signal.
 *
 * Pure, deterministic, dependency-free topology math. Nothing here mints a RoutingPacket,
 * imports a peer agent, or produces side effects — it is a numeric utility the security and
 * matrix layers can consult.
 *
 *   H(X) = - Σ p_i · log_b(p_i)   (0 · log 0 ≡ 0)
 *
 * `entropySpike` turns two entropy readings into a boolean intervention signal for KNOLL:
 * a sudden jump in the entropy of observed traffic/persona activity that exceeds `bound`
 * is the kind of behavior the six virtual laws cannot express as a hard rule.
 */

/** A discrete distribution as either raw weights/counts (array) or a labeled count map. */
export type Distribution = readonly number[] | Readonly<Record<string, number>>;

/** Extract the raw non-negative weights from either distribution shape. */
function weightsOf(dist: Distribution): number[] {
  const values = Array.isArray(dist)
    ? [...(dist as readonly number[])]
    : Object.values(dist as Record<string, number>);
  for (const v of values) {
    if (!Number.isFinite(v) || v < 0) {
      throw new Error('shannon: distribution weights must be finite and non-negative');
    }
  }
  return values;
}

/**
 * Normalize non-negative weights/counts into a probability distribution summing to 1.
 * An all-zero (or empty) distribution normalizes to an empty distribution (entropy 0).
 */
export function normalizeDistribution(dist: Distribution): number[] {
  const values = weightsOf(dist);
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return values.map((v) => v / total);
}

/**
 * Shannon entropy H(X) of a discrete distribution. Accepts raw counts/weights (they are
 * normalized internally) or a probability vector. `base` defaults to 2 (bits).
 */
export function shannonEntropy(dist: Distribution, base = 2): number {
  if (!(base > 1)) throw new Error('shannon: log base must be > 1');
  const probs = normalizeDistribution(dist);
  const denom = Math.log(base);
  let h = 0;
  for (const p of probs) {
    if (p > 0) h -= p * (Math.log(p) / denom);
  }
  // Guard against tiny negative zero from floating point.
  return h <= 0 ? 0 : h;
}

/**
 * Maximum possible entropy for `n` equiprobable outcomes: log_base(n). Handy for
 * normalizing an entropy reading into 0..1 before feeding it to a scorer.
 */
export function maxEntropy(n: number, base = 2): number {
  if (n <= 1) return 0;
  return Math.log(n) / Math.log(base);
}

/**
 * Normalized entropy in 0..1 (entropy divided by the maximum for the outcome count).
 * A uniform distribution → 1; a point mass → 0.
 */
export function normalizedEntropy(dist: Distribution, base = 2): number {
  const values = weightsOf(dist).filter((v) => v > 0);
  const max = maxEntropy(values.length, base);
  if (max === 0) return 0;
  return Math.min(1, shannonEntropy(dist, base) / max);
}

/**
 * KNOLL intervention signal: true when the entropy *increase* from `prev` to `curr`
 * exceeds `bound`. A spike in entropy (traffic/persona activity suddenly becoming far more
 * disordered than the baseline) is a soft anomaly worth a KNOLL look — it never mutates a
 * packet, it only flags.
 */
export function entropySpike(prev: number, curr: number, bound: number): boolean {
  if (![prev, curr, bound].every(Number.isFinite)) {
    throw new Error('entropySpike: prev, curr and bound must be finite numbers');
  }
  if (bound < 0) throw new Error('entropySpike: bound must be non-negative');
  return curr - prev > bound;
}
