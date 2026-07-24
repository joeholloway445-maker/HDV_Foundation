/**
 * nodes/math/etalon_adaline.ts — Etalon baseline + Adaline (LMS) pattern classification.
 *
 * Two complementary, fully deterministic classifiers over flattened 64×64 grid features
 * (4,096-dim). Pure TypeScript, no randomness, no external deps:
 *
 *   - Etalon baseline  : the "reference template" method. Each class is summarized by its
 *                        mean feature vector (its etalon). A sample is classified to the
 *                        nearest etalon by Euclidean distance. Cheap, interpretable baseline.
 *   - Adaline (LMS)    : a single Adaptive Linear Neuron trained with the Widrow-Hoff least
 *                        mean squares rule for binary (±1) classification. Weights start at
 *                        zero and epochs iterate the samples in the given order, so training
 *                        is reproducible bit-for-bit.
 */

/** Side length of the feature grid. */
export const GRID_SIZE = 64;
/** Flattened feature dimensionality (GRID_SIZE²). */
export const FEATURE_DIM = GRID_SIZE * GRID_SIZE; // 4096

/** Flatten a rows×cols grid (row-major) into a single feature vector. */
export function flattenGrid(grid: readonly (readonly number[])[]): number[] {
  const out: number[] = [];
  for (const row of grid) out.push(...row);
  return out;
}

function assertVector(features: readonly number[], dim: number): void {
  if (features.length !== dim) {
    throw new Error(`etalon_adaline: expected feature vector of length ${dim}, got ${features.length}`);
  }
  for (const v of features) {
    if (!Number.isFinite(v)) throw new Error('etalon_adaline: feature values must be finite');
  }
}

function euclidean(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// ---------------------------------------------------------------------------
// Etalon baseline
// ---------------------------------------------------------------------------

export interface LabeledSample {
  features: number[];
  label: string;
}

export interface EtalonPrediction {
  label: string;
  /** Distance to the winning etalon (lower = better). */
  distance: number;
  /** Distance to every class etalon, by label. */
  distances: Record<string, number>;
}

export interface EtalonClassifierOptions {
  /** Feature dimensionality. Default FEATURE_DIM (4096). */
  dim?: number;
}

/**
 * Etalon (reference-template) classifier. Learns one mean vector per class label and assigns
 * a query to the nearest etalon. Ties break toward the lexicographically smaller label.
 */
export class EtalonClassifier {
  private readonly dim: number;
  private readonly etalons = new Map<string, number[]>();

  constructor(options: EtalonClassifierOptions = {}) {
    this.dim = options.dim ?? FEATURE_DIM;
  }

  /** Fit the etalons: the per-class mean of the training features. */
  fit(samples: readonly LabeledSample[]): void {
    if (samples.length === 0) throw new Error('EtalonClassifier.fit: no samples provided');
    const sums = new Map<string, number[]>();
    const counts = new Map<string, number>();
    for (const { features, label } of samples) {
      assertVector(features, this.dim);
      const acc = sums.get(label) ?? new Array<number>(this.dim).fill(0);
      for (let i = 0; i < this.dim; i++) acc[i] += features[i];
      sums.set(label, acc);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    this.etalons.clear();
    for (const [label, acc] of sums) {
      const c = counts.get(label) ?? 1;
      this.etalons.set(label, acc.map((v) => v / c));
    }
  }

  /** The learned etalon (mean template) for a class, or undefined if unknown. */
  etalonFor(label: string): number[] | undefined {
    const e = this.etalons.get(label);
    return e ? [...e] : undefined;
  }

  labels(): string[] {
    return [...this.etalons.keys()].sort();
  }

  predict(features: readonly number[]): EtalonPrediction {
    if (this.etalons.size === 0) throw new Error('EtalonClassifier.predict: model is not fitted');
    assertVector(features, this.dim);
    const distances: Record<string, number> = {};
    let best = '';
    let bestDist = Infinity;
    for (const label of this.labels()) {
      const d = euclidean(features, this.etalons.get(label)!);
      distances[label] = d;
      if (d < bestDist) {
        bestDist = d;
        best = label;
      }
    }
    return { label: best, distance: bestDist, distances };
  }
}

// ---------------------------------------------------------------------------
// Adaline (Adaptive Linear Neuron, LMS / Widrow-Hoff)
// ---------------------------------------------------------------------------

export interface AdalineSample {
  features: number[];
  /** Target label, +1 or -1. */
  target: 1 | -1;
}

export interface AdalineOptions {
  /** Feature dimensionality. Default FEATURE_DIM (4096). */
  dim?: number;
  /** LMS learning rate. Default 0.01. */
  learningRate?: number;
  /** Training epochs (full passes over the samples). Default 10. */
  epochs?: number;
}

export interface AdalineTrainingReport {
  epochs: number;
  /** Mean squared error at the end of each epoch. */
  mseByEpoch: number[];
}

/**
 * Single Adaline unit for binary (±1) classification, trained with the LMS rule:
 *   w ← w + η · (target − net) · x,   b ← b + η · (target − net)
 * The net input is a plain linear combination (identity activation); the sign of the net
 * input is the predicted class. Deterministic: zero-initialized weights, fixed sample order.
 */
export class Adaline {
  private readonly dim: number;
  private readonly learningRate: number;
  private readonly epochs: number;
  private weights: number[];
  private bias = 0;

  constructor(options: AdalineOptions = {}) {
    this.dim = options.dim ?? FEATURE_DIM;
    this.learningRate = options.learningRate ?? 0.01;
    this.epochs = options.epochs ?? 10;
    this.weights = new Array<number>(this.dim).fill(0);
  }

  /** The raw linear net input wᵀx + b. */
  net(features: readonly number[]): number {
    assertVector(features, this.dim);
    let acc = this.bias;
    for (let i = 0; i < this.dim; i++) acc += this.weights[i] * features[i];
    return acc;
  }

  /** Predicted class: +1 when net input ≥ 0, else −1. */
  predict(features: readonly number[]): 1 | -1 {
    return this.net(features) >= 0 ? 1 : -1;
  }

  /** Current weight vector (copy) and bias, for inspection/tests. */
  parameters(): { weights: number[]; bias: number } {
    return { weights: [...this.weights], bias: this.bias };
  }

  /** Train in place with the LMS rule. Returns per-epoch MSE for convergence checks. */
  train(samples: readonly AdalineSample[]): AdalineTrainingReport {
    if (samples.length === 0) throw new Error('Adaline.train: no samples provided');
    for (const s of samples) assertVector(s.features, this.dim);

    const mseByEpoch: number[] = [];
    for (let epoch = 0; epoch < this.epochs; epoch++) {
      let sqErr = 0;
      for (const { features, target } of samples) {
        const output = this.net(features);
        const error = target - output;
        sqErr += error * error;
        const step = this.learningRate * error;
        for (let i = 0; i < this.dim; i++) this.weights[i] += step * features[i];
        this.bias += step;
      }
      mseByEpoch.push(sqErr / samples.length);
    }
    return { epochs: this.epochs, mseByEpoch };
  }
}
