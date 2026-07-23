/**
 * knoll/scoring.ts — behavioral anomaly scoring engine (Phase 2).
 *
 * ADDITIVE to the six virtual laws (laws.ts) — it never replaces them. KNOLL runs the
 * laws first (structural / relational guarantees), then this scorer as a final
 * probabilistic gate for behavior the laws can't express as a hard rule (flooding,
 * high-entropy exfil blobs, priority abuse, bad source reputation over time).
 *
 * The scorer is stateful: it tracks a per-source sliding window of request timestamps
 * (rate) and an accumulating reputation risk (sources that keep tripping the scorer get
 * more suspicious). It remains monitor-only — it returns a verdict; it mutates no packet.
 */
import { AgentRole, type RoutingPacket } from '../config/routing_schema.js';
import { extractFeatures, type BehavioralFeatures, type ScoringContext } from './features.js';

export interface BehavioralScore {
  score: number;
  threshold: number;
  /** score >= threshold — the packet should be denied. */
  isAnomalous: boolean;
  /** score >= flagThreshold but < threshold — allowed, but worth logging. */
  flagged: boolean;
  features: BehavioralFeatures;
  contributions: Record<keyof BehavioralFeatures, number>;
}

export type FeatureWeights = Record<keyof BehavioralFeatures, number>;

export interface BehavioralScorerOptions {
  /** Deny threshold. score >= threshold → anomalous (deny). Default 0.6. */
  threshold?: number;
  /** Flag (log-but-allow) threshold. Default 0.4. */
  flagThreshold?: number;
  /** Per-feature weights; defaults sum to 1.0. */
  weights?: Partial<FeatureWeights>;
  /** Sliding rate window in ms. Default 1000. */
  rateWindowMs?: number;
  /** Normalization cap for the rate feature. Default 20. */
  rateSoftCap?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

const DEFAULT_WEIGHTS: FeatureWeights = {
  rate: 0.15,
  intentEntropy: 0.1,
  maliciousHits: 0.3,
  endpointRisk: 0.15,
  payloadSize: 0.1,
  priorityAbuse: 0.1,
  sourceReputation: 0.1,
};

export class BehavioralScorer {
  private readonly threshold: number;
  private readonly flagThreshold: number;
  private readonly weights: FeatureWeights;
  private readonly rateWindowMs: number;
  private readonly rateSoftCap: number;
  private readonly now: () => number;

  private readonly windows = new Map<AgentRole, number[]>();
  private readonly reputation = new Map<AgentRole, number>();

  constructor(options: BehavioralScorerOptions = {}) {
    this.threshold = options.threshold ?? 0.6;
    this.flagThreshold = options.flagThreshold ?? 0.4;
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.rateWindowMs = options.rateWindowMs ?? 1000;
    this.rateSoftCap = options.rateSoftCap ?? 20;
    this.now = options.now ?? Date.now;
  }

  /**
   * Score a packet. Updates the source's rate window and (on an anomalous verdict) its
   * reputation risk, so repeat offenders climb toward denial over time.
   */
  score(packet: RoutingPacket): BehavioralScore {
    const source = packet.header.source;
    const recentCount = this.observeRate(source);
    const reputationRisk = this.reputation.get(source) ?? 0;

    const ctx: ScoringContext = {
      recentCount,
      rateSoftCap: this.rateSoftCap,
      reputationRisk,
    };

    const features = extractFeatures(packet, ctx);
    const contributions = {} as Record<keyof BehavioralFeatures, number>;
    let score = 0;
    for (const key of Object.keys(this.weights) as (keyof BehavioralFeatures)[]) {
      const c = features[key] * this.weights[key];
      contributions[key] = round4(c);
      score += c;
    }
    score = clamp01(score);

    const isAnomalous = score >= this.threshold;
    const flagged = !isAnomalous && score >= this.flagThreshold;

    // Reputation feedback loop: anomalous sources get worse; flagged nudge upward;
    // clean traffic slowly decays reputation back toward zero (good behavior forgiven).
    if (isAnomalous) {
      this.bumpReputation(source, 0.25);
    } else if (flagged) {
      this.bumpReputation(source, 0.05);
    } else {
      this.decayReputation(source, 0.02);
    }

    return {
      score: round4(score),
      threshold: this.threshold,
      isAnomalous,
      flagged,
      features,
      contributions,
    };
  }

  /** Read a source's current reputation risk (0 clean .. 1 bad). */
  reputationOf(source: AgentRole): number {
    return round4(this.reputation.get(source) ?? 0);
  }

  reset(): void {
    this.windows.clear();
    this.reputation.clear();
  }

  private observeRate(source: AgentRole): number {
    const t = this.now();
    const arr = this.windows.get(source) ?? [];
    const cutoff = t - this.rateWindowMs;
    const pruned = arr.filter((ts) => ts > cutoff);
    pruned.push(t);
    this.windows.set(source, pruned);
    return pruned.length;
  }

  private bumpReputation(source: AgentRole, delta: number): void {
    this.reputation.set(source, clamp01((this.reputation.get(source) ?? 0) + delta));
  }

  private decayReputation(source: AgentRole, delta: number): void {
    this.reputation.set(source, clamp01((this.reputation.get(source) ?? 0) - delta));
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}
