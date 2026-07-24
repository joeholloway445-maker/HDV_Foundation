/**
 * vision/sandbox.ts — sandbox isolation for VISION (Phase 3, hardened in Phase 4.2).
 *
 * VISION executes tools inside isolated sandboxes (Docker / gVisor). The session provides a
 * realistic abstraction — start/run/stop lifecycle, resource limits as metadata, realistic
 * session IDs, logs, and exit codes — while the actual container runtime remains a safe STUB
 * (no real containers are launched).
 *
 * Phase 4.2 hardening:
 *   - timeout kill: a run whose (simulated) duration exceeds the wall-clock timeout is
 *     force-killed (exit 124) and the session is stopped, mirroring a real OOM/timeout kill.
 *   - per-session audit: every tool invocation is recorded on the session and, optionally,
 *     forwarded to a shared ResourceMonitor.
 *   - concurrent session limit: SandboxManager caps how many sessions may be live at once.
 *
 * CONSTRAINT: the sandbox NEVER executes arbitrary host code. `run` dispatches to a mock
 * runner supplied by the caller (the tool). It only tracks lifecycle + accounting.
 */
import { randomBytes } from 'node:crypto';
import { estimateCpuSeconds, type ResourceMonitor } from './resource_monitor.js';
import { GvisorSandboxSession, isGvisorAvailable } from './sandbox_gvisor.js';

export type SandboxKind = 'docker' | 'gvisor';
export type SandboxStatus = 'created' | 'running' | 'stopped';

export interface ResourceLimits {
  /** Fractional CPU cores. */
  cpu: number;
  /** Memory cap in MB. */
  memMb: number;
  /** Wall-clock timeout in ms. */
  timeoutMs: number;
}

export const DEFAULT_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, timeoutMs: 5000 };

export interface SandboxLogLine {
  at: number;
  stream: 'stdout' | 'stderr' | 'system';
  message: string;
}

export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  output: Record<string, unknown>;
}

/**
 * A callback the tool provides; the sandbox invokes it as the mock "process".
 * `durationMs` and `memMb` are OPTIONAL simulated resource hints — when omitted, the
 * sandbox uses the real (near-zero) elapsed time. They let tools/tests exercise the
 * timeout-kill and memory-accounting paths deterministically.
 */
export type SandboxRunner = () => {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  output?: Record<string, unknown>;
  durationMs?: number;
  memMb?: number;
};

/** One recorded tool invocation on a session (the session-local audit trail). */
export interface SandboxInvocation {
  label: string;
  at: number;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
}

export interface SandboxSession {
  readonly id: string;
  readonly kind: SandboxKind;
  readonly limits: ResourceLimits;
  status: SandboxStatus;
  start(): void;
  run(label: string, runner: SandboxRunner): SandboxRunResult;
  stop(): SandboxSummary;
  logs(): readonly SandboxLogLine[];
  invocations(): readonly SandboxInvocation[];
}

export interface SandboxSummary {
  sessionId: string;
  kind: SandboxKind;
  runs: number;
  totalDurationMs: number;
  cpuSeconds: number;
  peakMemMb: number;
  timeouts: number;
  killedByTimeout: boolean;
  limits: ResourceLimits;
}

/** Optional collaborators injected into a session (all observe-only). */
export interface SandboxHooks {
  monitor?: ResourceMonitor;
  /** Invoked when the session stops (used by SandboxManager to free a slot). */
  onStop?: (sessionId: string) => void;
}

/**
 * Stub sandbox session. Emits realistic-looking container IDs and logs and tracks a
 * start → run* → stop lifecycle, but launches nothing real. Enforces the lifecycle
 * (can't run before start / after stop) so callers exercise realistic session handling.
 */
export class StubSandboxSession implements SandboxSession {
  readonly id: string;
  status: SandboxStatus = 'created';
  private readonly logLines: SandboxLogLine[] = [];
  private readonly invocationLog: SandboxInvocation[] = [];
  private runs = 0;
  private totalDurationMs = 0;
  private cpuSeconds = 0;
  private peakMemMb = 0;
  private timeouts = 0;
  private killedByTimeout = false;

  constructor(
    readonly kind: SandboxKind,
    readonly limits: ResourceLimits = DEFAULT_LIMITS,
    private readonly hooks: SandboxHooks = {},
  ) {
    // Docker-style 64-hex-char id, prefixed so it's clearly a stub.
    this.id = `sbx_${kind}_${randomBytes(16).toString('hex')}`;
    this.log('system', `session ${this.id} created (cpu=${limits.cpu}, mem=${limits.memMb}MB, timeout=${limits.timeoutMs}ms)`);
    this.hooks.monitor?.openSession(this.id, this.kind, this.limits);
  }

  start(): void {
    if (this.status === 'running') return;
    if (this.status === 'stopped') throw new Error(`sandbox ${this.id} is stopped and cannot be restarted`);
    this.status = 'running';
    this.log('system', `starting ${this.kind} sandbox ${this.id}`);
  }

  run(label: string, runner: SandboxRunner): SandboxRunResult {
    if (this.status === 'stopped' && this.killedByTimeout) {
      throw new Error(`sandbox ${this.id} was killed after a timeout and cannot run again`);
    }
    if (this.status !== 'running') throw new Error(`sandbox ${this.id} must be started before run()`);
    const startedAt = Date.now();
    this.log('system', `exec "${label}" in ${this.id}`);
    let outcome: ReturnType<SandboxRunner>;
    try {
      outcome = runner();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('stderr', message);
      const durationMs = Math.max(1, Date.now() - startedAt);
      this.account(label, durationMs, this.limits.memMb, 1, false);
      return { exitCode: 1, stdout: '', stderr: message, durationMs, timedOut: false, output: {} };
    }
    // Prefer the tool's simulated duration/mem when supplied; else fall back to real elapsed.
    const durationMs = outcome.durationMs !== undefined
      ? Math.max(1, Math.round(outcome.durationMs))
      : Math.max(1, Date.now() - startedAt);
    const memMb = clampMem(outcome.memMb, this.limits.memMb);
    const timedOut = durationMs > this.limits.timeoutMs;
    if (outcome.stdout) this.log('stdout', outcome.stdout);
    if (outcome.stderr) this.log('stderr', outcome.stderr);
    const exitCode = timedOut ? 124 : outcome.exitCode;
    this.account(label, durationMs, memMb, exitCode, timedOut);

    if (timedOut) {
      // Timeout kill: a real container would be SIGKILL'd. Force-stop the session.
      this.killedByTimeout = true;
      this.log('system', `sandbox ${this.id} killed: run "${label}" exceeded timeout (${durationMs}ms > ${this.limits.timeoutMs}ms)`);
      this.stop();
    }

    return {
      exitCode,
      stdout: outcome.stdout ?? '',
      stderr: timedOut ? `killed: exceeded ${this.limits.timeoutMs}ms timeout` : outcome.stderr ?? '',
      durationMs,
      timedOut,
      output: outcome.output ?? {},
    };
  }

  stop(): SandboxSummary {
    if (this.status !== 'stopped') {
      this.status = 'stopped';
      this.log('system', `stopping sandbox ${this.id} (runs=${this.runs})`);
      this.hooks.monitor?.closeSession(this.id);
      this.hooks.onStop?.(this.id);
    }
    return this.summary();
  }

  logs(): readonly SandboxLogLine[] {
    return this.logLines;
  }

  invocations(): readonly SandboxInvocation[] {
    return this.invocationLog;
  }

  private summary(): SandboxSummary {
    return {
      sessionId: this.id,
      kind: this.kind,
      runs: this.runs,
      totalDurationMs: this.totalDurationMs,
      cpuSeconds: round4(this.cpuSeconds),
      peakMemMb: this.peakMemMb,
      timeouts: this.timeouts,
      killedByTimeout: this.killedByTimeout,
      limits: this.limits,
    };
  }

  private account(label: string, durationMs: number, memMb: number, exitCode: number, timedOut: boolean): void {
    const cpuSeconds = estimateCpuSeconds(durationMs, this.limits);
    this.runs += 1;
    this.totalDurationMs += durationMs;
    this.cpuSeconds = round4(this.cpuSeconds + cpuSeconds);
    this.peakMemMb = Math.max(this.peakMemMb, memMb);
    if (timedOut) this.timeouts += 1;
    this.invocationLog.push({ label, at: Date.now(), durationMs, exitCode, timedOut });
    this.hooks.monitor?.recordRun(this.id, label, { durationMs, cpuSeconds, memMb, timedOut }, exitCode);
  }

  private log(stream: SandboxLogLine['stream'], message: string): void {
    this.logLines.push({ at: Date.now(), stream, message });
  }
}

/**
 * Factory: create a sandbox session of the given kind with optional resource limits.
 *
 * Phase 5: when `kind === 'gvisor'` AND the gVisor runtime (`runsc` + `docker`) is available on
 * the host, this returns a REAL `GvisorSandboxSession` (vision/sandbox_gvisor.ts). When gVisor
 * is missing (the offline default and any host without it) it transparently falls back to the
 * `StubSandboxSession`, so callers get identical semantics with zero infra. Docker sandboxes
 * always use the stub for now (only gVisor has a real adapter).
 */
export function createSandboxSession(
  kind: SandboxKind = 'gvisor',
  limits?: Partial<ResourceLimits>,
  hooks?: SandboxHooks,
): SandboxSession {
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  if (kind === 'gvisor' && isGvisorAvailable()) {
    return new GvisorSandboxSession(resolved, hooks);
  }
  return new StubSandboxSession(kind, resolved, hooks);
}

/**
 * SandboxManager — caps how many sandbox sessions may be live concurrently, mirroring a
 * host that can only run so many containers at once. Observe-and-limit only; it never
 * inspects tool payloads or makes routing decisions.
 */
export interface SandboxManagerOptions {
  maxConcurrent?: number;
  monitor?: ResourceMonitor;
}

export const DEFAULT_MAX_CONCURRENT_SESSIONS = 8;

export class SandboxManager {
  readonly maxConcurrent: number;
  private readonly monitor?: ResourceMonitor;
  private readonly live = new Set<string>();
  private opened = 0;
  private rejected = 0;

  constructor(options: SandboxManagerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    if (this.maxConcurrent < 1) throw new Error('SandboxManager: maxConcurrent must be >= 1');
    this.monitor = options.monitor;
  }

  /** Number of currently-live (started/created, not-yet-stopped) sessions. */
  activeCount(): number {
    return this.live.size;
  }

  /** How many sessions were opened / rejected over this manager's lifetime. */
  stats(): { opened: number; rejected: number; active: number; maxConcurrent: number } {
    return { opened: this.opened, rejected: this.rejected, active: this.live.size, maxConcurrent: this.maxConcurrent };
  }

  /**
   * Create a session, enforcing the concurrency cap. Throws when the cap is reached; the
   * caller must stop() an existing session first. Stopping a session frees its slot.
   */
  create(kind: SandboxKind = 'gvisor', limits?: Partial<ResourceLimits>): SandboxSession {
    if (this.live.size >= this.maxConcurrent) {
      this.rejected += 1;
      throw new Error(
        `SandboxManager: concurrent session limit reached (${this.live.size}/${this.maxConcurrent})`,
      );
    }
    const session = new StubSandboxSession(kind, { ...DEFAULT_LIMITS, ...limits }, {
      monitor: this.monitor,
      onStop: (id) => this.live.delete(id),
    });
    this.live.add(session.id);
    this.opened += 1;
    return session;
  }
}

function clampMem(memMb: number | undefined, cap: number): number {
  if (memMb === undefined || !Number.isFinite(memMb) || memMb < 0) return cap;
  // A run can't credibly use more than the session's memory cap.
  return Math.min(memMb, cap);
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}
