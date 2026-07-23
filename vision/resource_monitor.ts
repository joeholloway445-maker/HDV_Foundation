/**
 * vision/resource_monitor.ts — sandbox resource accounting for VISION (Phase 4.2).
 *
 * Tracks CPU / memory / timeout usage metadata per sandbox session and keeps an audit
 * log of every tool invocation. This is pure accounting: it observes sandbox activity
 * and produces metadata for the APEX ledger to bill. It NEVER executes anything and
 * NEVER makes routing or policy decisions (that would violate VISION's constraints).
 *
 * CONSTRAINT: the monitor is observe-only. It cannot create artifacts, cannot govern,
 * and holds no channel to any peer agent — usage rolls up into ExecutionReports that
 * travel back to HOPE via APEX only.
 */
import type { ResourceLimits, SandboxKind } from './sandbox.js';

/** One measured (or simulated) resource sample from a single sandbox run. */
export interface ResourceSample {
  /** Wall-clock duration attributed to the run, in ms. */
  durationMs: number;
  /** CPU-seconds consumed (duration * fractional cpu limit). */
  cpuSeconds: number;
  /** Memory high-water estimate for the run, in MB. */
  memMb: number;
  /** Whether the run exceeded the session wall-clock timeout. */
  timedOut: boolean;
}

/** A single tool invocation, recorded for the audit trail. */
export interface ToolInvocationRecord {
  sessionId: string;
  /** The tool / run label passed to sandbox.run(). */
  label: string;
  at: number;
  durationMs: number;
  cpuSeconds: number;
  memMb: number;
  exitCode: number;
  timedOut: boolean;
}

/** Rolled-up resource usage for one sandbox session. */
export interface SessionResourceUsage {
  sessionId: string;
  kind: SandboxKind;
  limits: ResourceLimits;
  runs: number;
  totalDurationMs: number;
  cpuSeconds: number;
  /** Peak memory estimate observed across the session's runs, in MB. */
  peakMemMb: number;
  /** Number of runs that hit the wall-clock timeout. */
  timeouts: number;
  startedAt: number;
  endedAt?: number;
  /** Whether the session was killed because a run exceeded its timeout. */
  killedByTimeout: boolean;
}

/** Aggregate totals across every session the monitor has seen. */
export interface ResourceTotals {
  sessions: number;
  runs: number;
  totalDurationMs: number;
  cpuSeconds: number;
  timeouts: number;
}

/**
 * Estimate CPU-seconds for a run: fractional cpu limit applied over the wall-clock
 * duration. Purely metadata — nothing is measured off the host.
 */
export function estimateCpuSeconds(durationMs: number, limits: ResourceLimits): number {
  return round4((durationMs / 1000) * limits.cpu);
}

/**
 * ResourceMonitor — per-session usage accounting plus a tool-invocation audit log.
 * A single monitor can be shared across many sessions (e.g. by an ExecutionEngine).
 */
export class ResourceMonitor {
  private readonly sessions = new Map<string, SessionResourceUsage>();
  private readonly audit: ToolInvocationRecord[] = [];

  /** Register a session so its usage can be tracked. Idempotent per session id. */
  openSession(sessionId: string, kind: SandboxKind, limits: ResourceLimits): SessionResourceUsage {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const usage: SessionResourceUsage = {
      sessionId,
      kind,
      limits,
      runs: 0,
      totalDurationMs: 0,
      cpuSeconds: 0,
      peakMemMb: 0,
      timeouts: 0,
      startedAt: Date.now(),
      killedByTimeout: false,
    };
    this.sessions.set(sessionId, usage);
    return usage;
  }

  /** Record a single run: updates the session rollup and appends an audit record. */
  recordRun(sessionId: string, label: string, sample: ResourceSample, exitCode: number): void {
    const usage = this.sessions.get(sessionId);
    if (!usage) {
      throw new Error(`ResourceMonitor: session ${sessionId} is not open`);
    }
    usage.runs += 1;
    usage.totalDurationMs += sample.durationMs;
    usage.cpuSeconds = round4(usage.cpuSeconds + sample.cpuSeconds);
    usage.peakMemMb = Math.max(usage.peakMemMb, sample.memMb);
    if (sample.timedOut) {
      usage.timeouts += 1;
      usage.killedByTimeout = true;
    }
    this.audit.push({
      sessionId,
      label,
      at: Date.now(),
      durationMs: sample.durationMs,
      cpuSeconds: sample.cpuSeconds,
      memMb: sample.memMb,
      exitCode,
      timedOut: sample.timedOut,
    });
  }

  /** Mark a session finished. */
  closeSession(sessionId: string): void {
    const usage = this.sessions.get(sessionId);
    if (usage && usage.endedAt === undefined) usage.endedAt = Date.now();
  }

  /** Usage for a single session, or undefined if never opened. */
  usage(sessionId: string): SessionResourceUsage | undefined {
    return this.sessions.get(sessionId);
  }

  /** Usage rollups for every session, newest registration last. */
  usageAll(): readonly SessionResourceUsage[] {
    return Array.from(this.sessions.values());
  }

  /** The full tool-invocation audit trail. */
  auditLog(): readonly ToolInvocationRecord[] {
    return this.audit;
  }

  /** Audit records for a single session. */
  auditFor(sessionId: string): readonly ToolInvocationRecord[] {
    return this.audit.filter((r) => r.sessionId === sessionId);
  }

  /** Aggregate totals across all sessions. */
  totals(): ResourceTotals {
    let runs = 0;
    let totalDurationMs = 0;
    let cpuSeconds = 0;
    let timeouts = 0;
    for (const u of this.sessions.values()) {
      runs += u.runs;
      totalDurationMs += u.totalDurationMs;
      cpuSeconds += u.cpuSeconds;
      timeouts += u.timeouts;
    }
    return {
      sessions: this.sessions.size,
      runs,
      totalDurationMs,
      cpuSeconds: round4(cpuSeconds),
      timeouts,
    };
  }

  /** Clear all tracked state (test / session-boundary helper). */
  reset(): void {
    this.sessions.clear();
    this.audit.length = 0;
  }
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}
