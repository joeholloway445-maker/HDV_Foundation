/**
 * dream/energy.ts — stream-energy accounting for DREAM scheduling (Phase 4.2).
 *
 * A `StreamEnergyMeter` folds a stream of lightweight events into a single decaying
 * "attention energy" scalar. APEX watches the synthetic event stream and feeds each event
 * to the meter; the {@link DreamScheduler} then reads the accumulated level to decide the
 * *shape* of a speculative DREAM simulation (breadth / depth / priority).
 *
 * The meter models two forces:
 *   - ACCUMULATION — each event adds a weighted contribution (busy streams heat up).
 *   - DECAY — energy bleeds off exponentially with wall-clock time (quiet streams cool).
 *
 * CONSTRAINTS: this is bookkeeping only. It never governs, executes, or talks to any peer
 * agent — it is a pure, dependency-free helper the scheduler consults.
 */

/** The synthetic stream events APEX can feed to DREAM's scheduler. */
export type StreamEventType =
  | 'USER_REQUEST'
  | 'ENERGY_SPIKE'
  | 'IDLE_TICK'
  | 'CHAT_BURST'
  | 'ANOMALY_NEAR_MISS';

export interface StreamEvent {
  type: StreamEventType;
  /**
   * Optional 0..1 magnitude for the event. Scales the event's energy contribution and, for
   * ENERGY_SPIKE, is compared directly against the scheduler's spike threshold.
   */
  energy?: number;
  /** The intent to simulate (defaults per event type in the scheduler). */
  intent?: string;
  data?: Record<string, unknown>;
  /** Event timestamp (ms). Defaults to the meter's clock; injectable for deterministic tests. */
  at?: number;
}

export interface StreamEnergyMeterOptions {
  /** Time for accumulated energy to halve, in ms. Default 10_000 (10s). */
  halfLifeMs?: number;
  /** Upper clamp for accumulated energy. Default 1. */
  ceiling?: number;
  /** Lower clamp for accumulated energy. Default 0. */
  floor?: number;
  /** Per-event contribution weights. Merged over {@link DEFAULT_ENERGY_WEIGHTS}. */
  weights?: Partial<Record<StreamEventType, number>>;
  /** Clock source (ms). Default `Date.now`; inject for deterministic tests. */
  now?: () => number;
}

/**
 * Default per-event contributions. USER_REQUEST is the strongest signal; IDLE_TICK actively
 * drains attention (on top of passive decay) to model a cooling stream.
 */
export const DEFAULT_ENERGY_WEIGHTS: Record<StreamEventType, number> = {
  USER_REQUEST: 0.5,
  ENERGY_SPIKE: 0.4,
  ANOMALY_NEAR_MISS: 0.35,
  CHAT_BURST: 0.2,
  IDLE_TICK: -0.03,
};

export class StreamEnergyMeter {
  private readonly halfLifeMs: number;
  private readonly ceiling: number;
  private readonly floor: number;
  private readonly weights: Record<StreamEventType, number>;
  private readonly clock: () => number;
  private energy = 0;
  private lastAt: number;

  constructor(options: StreamEnergyMeterOptions = {}) {
    this.halfLifeMs = options.halfLifeMs ?? 10_000;
    this.ceiling = options.ceiling ?? 1;
    this.floor = options.floor ?? 0;
    this.weights = { ...DEFAULT_ENERGY_WEIGHTS, ...(options.weights ?? {}) };
    this.clock = options.now ?? Date.now;
    this.lastAt = this.clock();
  }

  /** Raw contribution an event adds *before* decay and clamping. */
  contribution(event: StreamEvent): number {
    const weight = this.weights[event.type] ?? 0;
    const magnitude = event.energy ?? 1;
    return weight * magnitude;
  }

  /** Decayed energy at `at` (default: now) WITHOUT mutating the meter. */
  level(at: number = this.clock()): number {
    return this.decay(this.energy, this.lastAt, at);
  }

  /**
   * Fold an event into the meter: decay the accumulated energy forward to the event time,
   * add the event's contribution, clamp to [floor, ceiling], and return the new level.
   */
  observe(event: StreamEvent): number {
    const at = event.at ?? this.clock();
    const decayed = this.decay(this.energy, this.lastAt, at);
    const next = clamp(decayed + this.contribution(event), this.floor, this.ceiling);
    this.energy = next;
    this.lastAt = at;
    return next;
  }

  /** Reset accumulated energy back to zero (as of `at`). */
  reset(at: number = this.clock()): void {
    this.energy = 0;
    this.lastAt = at;
  }

  private decay(energy: number, from: number, to: number): number {
    if (energy === 0) return 0;
    const elapsed = Math.max(0, to - from);
    if (elapsed === 0) return energy;
    return energy * Math.pow(0.5, elapsed / this.halfLifeMs);
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
