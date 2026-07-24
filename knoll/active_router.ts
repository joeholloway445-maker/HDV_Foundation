/**
 * knoll/active_router.ts — KnollActiveRouter (KNOLL as an independent ACTIVE router).
 *
 * KNOLL is no longer passive-only. Beyond gating every business packet (validator.ts) and
 * tripping the system freeze on anomalies (freeze.ts), KNOLL now ACTIVELY routes its OWN
 * monitoring probes across the mesh — health-sampling the HOPE / VISION / DREAM / APEX surfaces
 * on a cadence it controls — and emits every reading to the security audit trail.
 *
 * CONSTRAINT (still within KNOLL's remit): these are MONITORING probes only. KNOLL never issues
 * a business create/execute through this router — it does not simulate (DREAM), execute (VISION),
 * or interpret (HOPE); it only asks each surface "are you healthy?" and records the answer. The
 * probes are read-only health checks injected per surface; KNOLL supplies the routing cadence and
 * the audit sink, never the business work.
 */
import { AgentRole } from '../config/routing_schema.js';
import type { SecurityAuditLog } from './audit.js';

export type HealthStatus = 'healthy' | 'degraded' | 'unreachable';

/** The surfaces KNOLL actively health-samples. KNOLL itself is the prober, not a probe target. */
export const DEFAULT_PROBE_SURFACES: readonly AgentRole[] = [
  AgentRole.HOPE,
  AgentRole.VISION,
  AgentRole.DREAM,
  AgentRole.APEX,
];

/** What a surface's health probe may report back. A bare return (void) is treated as healthy. */
export interface HealthProbeResult {
  status?: HealthStatus;
  detail?: string;
}

/**
 * A read-only health probe for one agent surface. MUST NOT create/execute business work — it
 * only reports whether the surface is reachable/healthy. Throwing is treated as `unreachable`.
 */
export type HealthProbe = () => HealthProbeResult | void;

/** A single emitted health reading. */
export interface HealthSample {
  role: AgentRole;
  status: HealthStatus;
  /** Probe round-trip time in milliseconds. */
  latencyMs: number;
  detail?: string;
  timestamp: number;
}

export interface KnollActiveRouterOptions {
  /** Wall-clock for sample timestamps. Injectable for deterministic tests. */
  now?: () => number;
  /** Monotonic clock for latency measurement. Injectable for deterministic tests. */
  monotonic?: () => number;
  /** Which surfaces to sample when `sampleAll()` is called. Defaults to HOPE/VISION/DREAM/APEX. */
  surfaces?: readonly AgentRole[];
}

/**
 * KNOLL's active monitoring router. Register a health probe per surface, then have KNOLL route a
 * probe (sample) to one or all surfaces; every reading is appended to KNOLL's in-memory sample
 * log AND emitted to the shared SecurityAuditLog so health telemetry lives in the same audit
 * trail as routing verdicts.
 */
export class KnollActiveRouter {
  private readonly audit: SecurityAuditLog;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly surfaces: readonly AgentRole[];
  private readonly probes = new Map<AgentRole, HealthProbe>();
  private readonly samples: HealthSample[] = [];

  constructor(audit: SecurityAuditLog, options: KnollActiveRouterOptions = {}) {
    this.audit = audit;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.surfaces = options.surfaces ?? DEFAULT_PROBE_SURFACES;
  }

  /** Register (or replace) the health probe for a surface. */
  registerProbe(role: AgentRole, probe: HealthProbe): void {
    this.probes.set(role, probe);
  }

  /**
   * Route a monitoring probe to a single surface, record the reading, and emit it to the audit
   * trail. A missing probe is reported as `unreachable`; a throwing probe is caught and reported
   * as `unreachable` (KNOLL never lets a probe failure break its monitoring loop).
   */
  sample(role: AgentRole): HealthSample {
    const start = this.monotonic();
    let status: HealthStatus = 'healthy';
    let detail: string | undefined;

    const probe = this.probes.get(role);
    if (!probe) {
      status = 'unreachable';
      detail = 'no health probe registered';
    } else {
      try {
        const result = probe() ?? undefined;
        status = result?.status ?? 'healthy';
        detail = result?.detail;
      } catch (err) {
        status = 'unreachable';
        detail = err instanceof Error ? err.message : String(err);
      }
    }

    const sample: HealthSample = {
      role,
      status,
      latencyMs: round4(Math.max(0, this.monotonic() - start)),
      detail,
      timestamp: this.now(),
    };
    this.samples.push(sample);
    this.emit(sample);
    return sample;
  }

  /** Route a probe to every configured surface (a full health sweep). */
  sampleAll(): HealthSample[] {
    return this.surfaces.map((role) => this.sample(role));
  }

  /** Read-only view of every health sample KNOLL has taken. */
  allSamples(): readonly HealthSample[] {
    return this.samples;
  }

  /** The most recent sample for a surface, if any. */
  latest(role: AgentRole): HealthSample | undefined {
    for (let i = this.samples.length - 1; i >= 0; i--) {
      if (this.samples[i].role === role) return this.samples[i];
    }
    return undefined;
  }

  clear(): void {
    this.samples.length = 0;
  }

  /**
   * Emit a health reading into the shared security audit trail. Probes are observations, not
   * routing verdicts, so they are recorded with an `ALLOWED` outcome and a `KNOLL_HEALTH_PROBE`
   * reasoning tag — they never pollute the BLOCKED verdict stream.
   */
  private emit(sample: HealthSample): void {
    const detail = sample.detail ? ` detail=${sample.detail}` : '';
    this.audit.record(
      `knoll-probe:${sample.role}`,
      'ALLOWED',
      `KNOLL_HEALTH_PROBE role=${sample.role} status=${sample.status} latencyMs=${sample.latencyMs}${detail}`,
    );
  }
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}
