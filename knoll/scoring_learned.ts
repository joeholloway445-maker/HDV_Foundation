/**
 * knoll/scoring_learned.ts — the LEARNED behavioral scorer (Phase 7).
 *
 * A pure-TypeScript online logistic-regression classifier that KNOLL can consult AFTER the
 * six virtual laws (laws.ts) and the heuristic behavioral scorer (scoring.ts). It is trained
 * on exported `SecurityAudit`-like samples (an ALLOWED/BLOCKED label + the packet's behavioral
 * features) so the gate can learn deny pressure that the hand-tuned weights never captured.
 *
 * Deliberate constraints (the constitution wins ties):
 *   - **Additive only.** The learned scorer can only ADD denies. It NEVER overrides a hard-law
 *     allow and NEVER turns a deny into an allow. It runs only on packets that already passed
 *     the laws + heuristic, and its single power is to raise a *new* deny.
 *   - **shadow vs enforce.** In `shadow` mode the scorer logs its verdict and NEVER denies
 *     (safe rollout / data collection). In `enforce` mode an anomalous verdict adds a deny —
 *     exactly like the heuristic scorer's additive gate.
 *   - **No heavy deps.** No onnxruntime, no numpy — a few dozen lines of SGD in pure TS, so it
 *     runs in the default offline suite and stays inspectable.
 *
 * The classifier is intentionally simple and deterministic (no random init) so training and
 * verdicts are reproducible in tests and in CI.
 */
import { type RoutingPacket } from '../config/routing_schema.js';
import { extractFeatures, type BehavioralFeatures, type ScoringContext } from './features.js';
import type { FeatureWeights } from './scoring.js';

/** The fixed feature order the classifier's weight vector is aligned to. */
export const FEATURE_ORDER: ReadonlyArray<keyof BehavioralFeatures> = [
  'rate',
  'intentEntropy',
  'maliciousHits',
  'endpointRisk',
  'payloadSize',
  'priorityAbuse',
  'sourceReputation',
];

export type LearnedMode = 'shadow' | 'enforce';

/** A single training example: a behavioral feature vector and its ground-truth label. */
export interface LearnedSample {
  features: BehavioralFeatures;
  /** 1 = the packet should be DENIED (BLOCKED); 0 = it is fine to ALLOW. */
  label: 0 | 1;
  /** Optional provenance for debugging / dedup. */
  packetId?: string;
}

/**
 * A `SecurityAudit`-like record enriched with the packet it described. This is the shape a real
 * audit export would carry once packets are persisted alongside verdicts; `exportAuditTrainingSet`
 * turns a batch of these into `LearnedSample`s the scorer can train on.
 */
export interface LabeledPacketSample {
  packet: RoutingPacket;
  outcome: 'ALLOWED' | 'BLOCKED';
  /** Optional stateful context (rate/reputation) recorded at audit time. */
  context?: Partial<ScoringContext>;
}

/** Serializable model snapshot — enough to reproduce a verdict anywhere. */
export interface LearnedModel {
  weights: FeatureWeights;
  bias: number;
  featureOrder: ReadonlyArray<keyof BehavioralFeatures>;
}

export interface LearnedScore {
  /** Sigmoid output in 0..1 — the model's estimated probability the packet should be denied. */
  probability: number;
  threshold: number;
  /** probability >= threshold — in `enforce` mode this ADDS a deny. */
  isAnomalous: boolean;
  /** probability >= flagThreshold but < threshold — logged, never denies. */
  flagged: boolean;
  features: BehavioralFeatures;
  /** Per-feature signed contribution w_i * x_i to the pre-sigmoid logit. */
  contributions: Record<keyof BehavioralFeatures, number>;
  mode: LearnedMode;
}

export interface TrainOptions {
  /** Passes over the sample set. Default 200. */
  epochs?: number;
  /**
   * Deterministic order-shuffle seed. When set, samples are permuted the same way every run
   * (helps SGD escape ordering artifacts without introducing nondeterminism). Default: no shuffle.
   */
  shuffleSeed?: number;
}

export interface LearnedBehavioralScorerOptions {
  /** Deny threshold on the sigmoid probability. Default 0.6. */
  threshold?: number;
  /** Flag (log-but-never-deny) threshold. Default 0.4. */
  flagThreshold?: number;
  /** SGD learning rate. Default 0.3. */
  learningRate?: number;
  /** L2 regularization strength. Default 1e-4. */
  l2?: number;
  /** shadow (log only) vs enforce (additive deny). Default 'shadow'. */
  mode?: LearnedMode;
  /** Optional initial weights (defaults to zeros — a deterministic cold start). */
  weights?: Partial<FeatureWeights>;
  /** Optional initial bias. Default 0. */
  bias?: number;
  /** Sliding rate window in ms for the standalone `rate` feature. Default 1000. */
  rateWindowMs?: number;
  /** Normalization cap for the rate feature. Default 20. */
  rateSoftCap?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

function zeroWeights(): FeatureWeights {
  const w = {} as FeatureWeights;
  for (const k of FEATURE_ORDER) w[k] = 0;
  return w;
}

/**
 * LearnedBehavioralScorer — online logistic regression over the seven behavioral features.
 *
 * It is self-contained: like the heuristic `BehavioralScorer` it tracks a per-source rate
 * window and an accumulating reputation risk so `score(packet)` works without external plumbing.
 * Its verdict is ADDITIVE — see the module header.
 */
export class LearnedBehavioralScorer {
  private readonly threshold: number;
  private readonly flagThreshold: number;
  private readonly learningRate: number;
  private readonly l2: number;
  private _mode: LearnedMode;
  private weights: FeatureWeights;
  private bias: number;
  private readonly rateWindowMs: number;
  private readonly rateSoftCap: number;
  private readonly now: () => number;

  private readonly windows = new Map<string, number[]>();
  private readonly reputation = new Map<string, number>();

  constructor(options: LearnedBehavioralScorerOptions = {}) {
    this.threshold = options.threshold ?? 0.6;
    this.flagThreshold = options.flagThreshold ?? 0.4;
    this.learningRate = options.learningRate ?? 0.3;
    this.l2 = options.l2 ?? 1e-4;
    this._mode = options.mode ?? 'shadow';
    this.weights = { ...zeroWeights(), ...options.weights };
    this.bias = options.bias ?? 0;
    this.rateWindowMs = options.rateWindowMs ?? 1000;
    this.rateSoftCap = options.rateSoftCap ?? 20;
    this.now = options.now ?? Date.now;
  }

  /** Current enforcement mode. `shadow` never denies; `enforce` adds denies. */
  get mode(): LearnedMode {
    return this._mode;
  }

  /** Flip between shadow (log-only) and enforce (additive deny). */
  setMode(mode: LearnedMode): void {
    this._mode = mode;
  }

  /** Export the trained model (weights + bias) for persistence or transport. */
  getModel(): LearnedModel {
    return { weights: { ...this.weights }, bias: this.bias, featureOrder: [...FEATURE_ORDER] };
  }

  /** Load a previously-exported model. Missing feature weights default to 0. */
  loadModel(model: LearnedModel): void {
    this.weights = { ...zeroWeights(), ...model.weights };
    this.bias = model.bias;
  }

  /**
   * One SGD step on a single labeled example. Returns the logistic loss BEFORE the update,
   * useful for tracking convergence. Public so callers can do fully-online learning.
   */
  trainOne(features: BehavioralFeatures, label: 0 | 1): number {
    const p = this.predict(features);
    const loss = logisticLoss(p, label);
    const err = p - label; // dLoss/dz for logistic regression
    for (const k of FEATURE_ORDER) {
      const grad = err * features[k] + this.l2 * this.weights[k];
      this.weights[k] -= this.learningRate * grad;
    }
    this.bias -= this.learningRate * err;
    return loss;
  }

  /**
   * Batch-train over labeled samples for a number of epochs. Returns the mean loss of the final
   * epoch so a caller (or test) can assert the model actually learned. Deterministic by default.
   */
  train(samples: readonly LearnedSample[], options: TrainOptions = {}): number {
    const epochs = options.epochs ?? 200;
    if (samples.length === 0) return 0;
    let lastEpochLoss = 0;
    for (let e = 0; e < epochs; e++) {
      const order =
        options.shuffleSeed === undefined
          ? samples
          : permute(samples, options.shuffleSeed + e);
      let sum = 0;
      for (const s of order) sum += this.trainOne(s.features, s.label);
      lastEpochLoss = sum / order.length;
    }
    return round4(lastEpochLoss);
  }

  /** Probability (0..1) that a feature vector should be denied. */
  predict(features: BehavioralFeatures): number {
    return sigmoid(this.logit(features));
  }

  /**
   * Score a live packet. Updates the source's rate window + reputation exactly like the heuristic
   * scorer (repeat offenders climb) and returns a verdict. NOTE: this never mutates the packet and
   * — regardless of verdict — can only be used to ADD a deny (see `mode`).
   */
  score(packet: RoutingPacket, context?: Partial<ScoringContext>): LearnedScore {
    const source = packet.header.source;
    const recentCount = context?.recentCount ?? this.observeRate(source);
    const reputationRisk = context?.reputationRisk ?? this.reputation.get(source) ?? 0;

    const ctx: ScoringContext = {
      recentCount,
      rateSoftCap: context?.rateSoftCap ?? this.rateSoftCap,
      reputationRisk,
    };
    const features = extractFeatures(packet, ctx);
    return this.scoreFeatures(features, source, context === undefined);
  }

  /** Score a pre-extracted feature vector (no state update). Handy for offline evaluation. */
  scoreFeatures(
    features: BehavioralFeatures,
    source?: string,
    updateReputation = false,
  ): LearnedScore {
    const contributions = {} as Record<keyof BehavioralFeatures, number>;
    for (const k of FEATURE_ORDER) contributions[k] = round4(this.weights[k] * features[k]);

    const probability = round4(sigmoid(this.logit(features)));
    const isAnomalous = probability >= this.threshold;
    const flagged = !isAnomalous && probability >= this.flagThreshold;

    if (updateReputation && source !== undefined) {
      if (isAnomalous) this.bumpReputation(source, 0.25);
      else if (flagged) this.bumpReputation(source, 0.05);
      else this.decayReputation(source, 0.02);
    }

    return {
      probability,
      threshold: this.threshold,
      isAnomalous,
      flagged,
      features,
      contributions,
      mode: this._mode,
    };
  }

  /**
   * The additive verdict KNOLL consults. Returns whether this scorer wants to ADD a deny.
   * In `shadow` mode `deny` is ALWAYS false (log only). It can never allow anything — it has no
   * power to override a prior deny; it can only raise a new one.
   */
  verdict(packet: RoutingPacket, context?: Partial<ScoringContext>): { deny: boolean; score: LearnedScore } {
    const score = this.score(packet, context);
    const deny = this._mode === 'enforce' && score.isAnomalous;
    return { deny, score };
  }

  /** Read a source's current reputation risk (0 clean .. 1 bad). */
  reputationOf(source: string): number {
    return round4(this.reputation.get(source) ?? 0);
  }

  reset(): void {
    this.windows.clear();
    this.reputation.clear();
  }

  private logit(features: BehavioralFeatures): number {
    let z = this.bias;
    for (const k of FEATURE_ORDER) z += this.weights[k] * features[k];
    return z;
  }

  private observeRate(source: string): number {
    const t = this.now();
    const arr = this.windows.get(source) ?? [];
    const cutoff = t - this.rateWindowMs;
    const pruned = arr.filter((ts) => ts > cutoff);
    pruned.push(t);
    this.windows.set(source, pruned);
    return pruned.length;
  }

  private bumpReputation(source: string, delta: number): void {
    this.reputation.set(source, clamp01((this.reputation.get(source) ?? 0) + delta));
  }

  private decayReputation(source: string, delta: number): void {
    this.reputation.set(source, clamp01((this.reputation.get(source) ?? 0) - delta));
  }
}

/**
 * Turn a batch of `SecurityAudit`-like records into a learned training set. A BLOCKED outcome
 * becomes label 1 (deny), an ALLOWED outcome becomes label 0. Features are extracted from each
 * packet with the same pure extractor KNOLL uses live, so training and inference stay aligned.
 *
 * This is the seam a real pipeline uses: persist packets alongside their SecurityAudit verdicts,
 * export them here, train a `LearnedBehavioralScorer`, and roll it out in shadow mode first.
 */
export function exportAuditTrainingSet(samples: readonly LabeledPacketSample[]): LearnedSample[] {
  return samples.map((s) => {
    const ctx: ScoringContext = {
      recentCount: s.context?.recentCount ?? 1,
      rateSoftCap: s.context?.rateSoftCap ?? 20,
      reputationRisk: s.context?.reputationRisk ?? 0,
    };
    return {
      features: extractFeatures(s.packet, ctx),
      label: s.outcome === 'BLOCKED' ? 1 : 0,
      packetId: s.packet.header.packetId,
    };
  });
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function logisticLoss(p: number, label: 0 | 1): number {
  const eps = 1e-12;
  const clamped = Math.max(eps, Math.min(1 - eps, p));
  return -(label * Math.log(clamped) + (1 - label) * Math.log(1 - clamped));
}

/** Deterministic in-place-free permutation (mulberry32-seeded Fisher–Yates). */
function permute<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}
