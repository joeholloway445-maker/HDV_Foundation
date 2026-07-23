/**
 * observability/metrics.ts — MetricsCollector (Phase 5 observability).
 *
 * A passive meter for APEX traffic. It plugs into the router's read-only `DispatchObserver`
 * seam (see `apex/router.ts`) and NEVER touches routing, KNOLL, the ledger, or any packet —
 * it only counts what already happened. This preserves the constitution: observability is
 * out-of-band and cannot govern, execute, create, or interpret.
 *
 * It records:
 *   - verdict counters: packets routed (SUCCESS), blocked, failed,
 *   - a simple latency histogram (fixed millisecond buckets, cumulative for Prometheus),
 *   - KNOLL deny reasons (keyed by enforced-constraint label, so cardinality stays bounded),
 *   - per-destination packet counts,
 *   - an "active personas" estimate (a decaying gauge derived from ephemeral spawns).
 *
 * `snapshot()` yields a JSON-friendly object; `toPrometheus()` yields a Prometheus-ish text
 * exposition. Both are pure reads and can be called at any time.
 */
import { AgentRole } from '../config/routing_schema.js';
import type { DispatchEvent, DispatchObserver } from '../apex/router.js';
import { EPHEMERAL_AGENTS, PERSONAS_PER_NODE } from '../nodes/index.js';

/** Upper bounds (inclusive, in ms) for the latency histogram. `+Inf` is implicit. */
export const LATENCY_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000] as const;

/** How long a single ephemeral spawn is counted as "active" for the personas gauge. */
export const DEFAULT_ACTIVE_WINDOW_MS = 5_000;

export interface HistogramSnapshot {
  /** Cumulative counts keyed by the bucket upper bound (`"+Inf"` for the overflow bucket). */
  buckets: Record<string, number>;
  count: number;
  sumMs: number;
  /** Mean latency in ms (0 when no samples yet). */
  averageMs: number;
}

export interface MetricsSnapshot {
  startedAt: number;
  uptimeMs: number;
  packets: {
    total: number;
    routed: number;
    blocked: number;
    failed: number;
  };
  perDestination: Record<string, number>;
  denyReasons: Record<string, number>;
  latencyMs: HistogramSnapshot;
  cost: { totalUsd: number };
  personas: {
    ephemeralSpawns: number;
    activeEstimate: number;
    perNode: number;
    windowMs: number;
  };
}

export interface MetricsCollectorOptions {
  /** Injectable clock (ms). Defaults to `Date.now` — override for deterministic tests. */
  now?: () => number;
  /** Sliding window used by the active-personas gauge. */
  activeWindowMs?: number;
}

/** Set of ephemeral roles whose successful executions spin up (conceptual) personas. */
const EPHEMERAL_SET: ReadonlySet<AgentRole> = new Set(EPHEMERAL_AGENTS);

export class MetricsCollector {
  readonly startedAt: number;
  private readonly now: () => number;
  private readonly activeWindowMs: number;

  private total = 0;
  private routed = 0;
  private blocked = 0;
  private failed = 0;
  private totalCostUsd = 0;

  private readonly perDestination = new Map<AgentRole, number>();
  private readonly denyReasons = new Map<string, number>();

  /** Parallel arrays over LATENCY_BUCKETS_MS plus a trailing overflow (`+Inf`) slot. */
  private readonly bucketCounts = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
  private latencyCount = 0;
  private latencySumMs = 0;

  /** Timestamps of recent ephemeral spawns, used for the decaying active-personas gauge. */
  private readonly ephemeralSpawnTimes: number[] = [];
  private ephemeralSpawns = 0;

  constructor(options: MetricsCollectorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
    this.startedAt = this.now();
  }

  /** Bind this collector as a router `DispatchObserver`. */
  observer(): DispatchObserver {
    return (event) => this.observe(event);
  }

  /** Record a single dispatch outcome. Pure accounting — never mutates the event. */
  observe(event: DispatchEvent): void {
    this.total += 1;
    switch (event.status) {
      case 'SUCCESS':
        this.routed += 1;
        break;
      case 'BLOCKED':
        this.blocked += 1;
        this.denyReasons.set(reasonKey(event), (this.denyReasons.get(reasonKey(event)) ?? 0) + 1);
        break;
      case 'FAILED':
        this.failed += 1;
        break;
      default:
        break;
    }

    this.perDestination.set(event.destination, (this.perDestination.get(event.destination) ?? 0) + 1);
    this.totalCostUsd = round6(this.totalCostUsd + (event.cost_usd ?? 0));
    this.recordLatency(event.durationMs);

    // A successful route to an ephemeral agent (DREAM/VISION) conceptually spins up a node's
    // personas which then terminate — feed the decaying active-personas gauge.
    if (event.status === 'SUCCESS' && EPHEMERAL_SET.has(event.destination)) {
      this.ephemeralSpawns += 1;
      this.ephemeralSpawnTimes.push(this.now());
      this.pruneSpawns();
    }
  }

  private recordLatency(durationMs: number): void {
    const d = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    this.latencyCount += 1;
    this.latencySumMs += d;
    let placed = false;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      if (d <= LATENCY_BUCKETS_MS[i]) {
        this.bucketCounts[i] += 1;
        placed = true;
        break;
      }
    }
    if (!placed) this.bucketCounts[this.bucketCounts.length - 1] += 1;
  }

  private pruneSpawns(nowTs: number = this.now()): void {
    const cutoff = nowTs - this.activeWindowMs;
    while (this.ephemeralSpawnTimes.length > 0 && this.ephemeralSpawnTimes[0] < cutoff) {
      this.ephemeralSpawnTimes.shift();
    }
  }

  /**
   * Estimate currently-active personas: ephemeral spawns within the sliding window times the
   * personas-per-node constant. A coarse gauge, not an exact live count (executions here are
   * synchronous and terminate immediately), but it tracks recent ephemeral pressure.
   */
  activePersonasEstimate(nowTs: number = this.now()): number {
    this.pruneSpawns(nowTs);
    return this.ephemeralSpawnTimes.length * PERSONAS_PER_NODE;
  }

  /** Cumulative-per-bucket histogram view (Prometheus semantics: each le includes lesser). */
  private histogram(): HistogramSnapshot {
    const buckets: Record<string, number> = {};
    let cumulative = 0;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      cumulative += this.bucketCounts[i];
      buckets[String(LATENCY_BUCKETS_MS[i])] = cumulative;
    }
    cumulative += this.bucketCounts[this.bucketCounts.length - 1];
    buckets['+Inf'] = cumulative;
    return {
      buckets,
      count: this.latencyCount,
      sumMs: round6(this.latencySumMs),
      averageMs: this.latencyCount === 0 ? 0 : round6(this.latencySumMs / this.latencyCount),
    };
  }

  /** A JSON-friendly point-in-time snapshot of everything measured so far. */
  snapshot(nowTs: number = this.now()): MetricsSnapshot {
    return {
      startedAt: this.startedAt,
      uptimeMs: Math.max(0, nowTs - this.startedAt),
      packets: {
        total: this.total,
        routed: this.routed,
        blocked: this.blocked,
        failed: this.failed,
      },
      perDestination: mapToRecord(this.perDestination),
      denyReasons: mapToRecord(this.denyReasons),
      latencyMs: this.histogram(),
      cost: { totalUsd: this.totalCostUsd },
      personas: {
        ephemeralSpawns: this.ephemeralSpawns,
        activeEstimate: this.activePersonasEstimate(nowTs),
        perNode: PERSONAS_PER_NODE,
        windowMs: this.activeWindowMs,
      },
    };
  }

  /** Render a Prometheus-ish text exposition (v0.0.4 format). Pure read. */
  toPrometheus(nowTs: number = this.now()): string {
    const snap = this.snapshot(nowTs);
    const lines: string[] = [];

    lines.push('# HELP big5_packets_total Packets processed by APEX, by KNOLL verdict.');
    lines.push('# TYPE big5_packets_total counter');
    lines.push(`big5_packets_total{verdict="routed"} ${snap.packets.routed}`);
    lines.push(`big5_packets_total{verdict="blocked"} ${snap.packets.blocked}`);
    lines.push(`big5_packets_total{verdict="failed"} ${snap.packets.failed}`);

    lines.push('# HELP big5_packets_by_destination_total Packets processed by destination agent.');
    lines.push('# TYPE big5_packets_by_destination_total counter');
    for (const [dest, n] of Object.entries(snap.perDestination)) {
      lines.push(`big5_packets_by_destination_total{destination="${escapeLabel(dest)}"} ${n}`);
    }

    lines.push('# HELP big5_knoll_denies_total KNOLL deny count by enforced-constraint reason.');
    lines.push('# TYPE big5_knoll_denies_total counter');
    for (const [reason, n] of Object.entries(snap.denyReasons)) {
      lines.push(`big5_knoll_denies_total{reason="${escapeLabel(reason)}"} ${n}`);
    }

    lines.push('# HELP big5_dispatch_duration_ms Gated-dispatch latency (KNOLL + handler).');
    lines.push('# TYPE big5_dispatch_duration_ms histogram');
    for (const [le, n] of Object.entries(snap.latencyMs.buckets)) {
      lines.push(`big5_dispatch_duration_ms_bucket{le="${escapeLabel(le)}"} ${n}`);
    }
    lines.push(`big5_dispatch_duration_ms_sum ${snap.latencyMs.sumMs}`);
    lines.push(`big5_dispatch_duration_ms_count ${snap.latencyMs.count}`);

    lines.push('# HELP big5_cost_usd_total Total cost billed by the APEX ledger (USD).');
    lines.push('# TYPE big5_cost_usd_total counter');
    lines.push(`big5_cost_usd_total ${snap.cost.totalUsd}`);

    lines.push('# HELP big5_active_personas_estimate Estimated active ephemeral personas.');
    lines.push('# TYPE big5_active_personas_estimate gauge');
    lines.push(`big5_active_personas_estimate ${snap.personas.activeEstimate}`);

    return lines.join('\n') + '\n';
  }

  /** Reset all counters (useful between test cases). */
  reset(): void {
    this.total = this.routed = this.blocked = this.failed = 0;
    this.totalCostUsd = 0;
    this.perDestination.clear();
    this.denyReasons.clear();
    this.bucketCounts.fill(0);
    this.latencyCount = 0;
    this.latencySumMs = 0;
    this.ephemeralSpawnTimes.length = 0;
    this.ephemeralSpawns = 0;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Deny key = the joined enforced-constraint labels (e.g. `LAW_3`, `HASH_INTEGRITY`,
 * `BEHAVIORAL_SCORE`). These are stable categories, so cardinality stays bounded — unlike
 * the free-text `reasoning`, which embeds packet-specific values.
 */
function reasonKey(event: DispatchEvent): string {
  const constraints = event.knoll.enforcedConstraints;
  if (constraints && constraints.length > 0) return constraints.join('+');
  const reasoning = event.knoll.reasoning;
  return reasoning && reasoning.trim().length > 0 ? reasoning.trim() : 'UNKNOWN';
}

function mapToRecord<K extends string>(map: Map<K, number>): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const [k, v] of map) out[k] = v;
  return out;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Round to 6 dp to match the ledger's micro-billing precision and remove FP dust. */
function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}
