/**
 * vision/sandbox.ts — sandbox isolation for VISION (Phase 3).
 *
 * VISION executes tools inside isolated sandboxes (Docker / gVisor). Phase 3 provides a
 * realistic session abstraction — start/run/stop lifecycle, resource limits as metadata,
 * realistic session IDs, logs, and exit codes — while the actual container runtime
 * remains a safe STUB (no real containers are launched).
 *
 * CONSTRAINT: the sandbox NEVER executes arbitrary host code. `run` dispatches to a mock
 * runner supplied by the caller (the tool). It only tracks lifecycle + accounting.
 */
import { randomBytes } from 'node:crypto';

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

/** A callback the tool provides; the sandbox invokes it as the mock "process". */
export type SandboxRunner = () => { exitCode: number; stdout?: string; stderr?: string; output?: Record<string, unknown> };

export interface SandboxSession {
  readonly id: string;
  readonly kind: SandboxKind;
  readonly limits: ResourceLimits;
  status: SandboxStatus;
  start(): void;
  run(label: string, runner: SandboxRunner): SandboxRunResult;
  stop(): SandboxSummary;
  logs(): readonly SandboxLogLine[];
}

export interface SandboxSummary {
  sessionId: string;
  kind: SandboxKind;
  runs: number;
  totalDurationMs: number;
  limits: ResourceLimits;
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
  private runs = 0;
  private totalDurationMs = 0;

  constructor(
    readonly kind: SandboxKind,
    readonly limits: ResourceLimits = DEFAULT_LIMITS,
  ) {
    // Docker-style 64-hex-char id, prefixed so it's clearly a stub.
    this.id = `sbx_${kind}_${randomBytes(16).toString('hex')}`;
    this.log('system', `session ${this.id} created (cpu=${limits.cpu}, mem=${limits.memMb}MB, timeout=${limits.timeoutMs}ms)`);
  }

  start(): void {
    if (this.status === 'running') return;
    if (this.status === 'stopped') throw new Error(`sandbox ${this.id} is stopped and cannot be restarted`);
    this.status = 'running';
    this.log('system', `starting ${this.kind} sandbox ${this.id}`);
  }

  run(label: string, runner: SandboxRunner): SandboxRunResult {
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
      this.runs += 1;
      this.totalDurationMs += durationMs;
      return { exitCode: 1, stdout: '', stderr: message, durationMs, timedOut: false, output: {} };
    }
    const durationMs = Math.max(1, Date.now() - startedAt);
    const timedOut = durationMs > this.limits.timeoutMs;
    if (outcome.stdout) this.log('stdout', outcome.stdout);
    if (outcome.stderr) this.log('stderr', outcome.stderr);
    this.runs += 1;
    this.totalDurationMs += durationMs;
    return {
      exitCode: timedOut ? 124 : outcome.exitCode,
      stdout: outcome.stdout ?? '',
      stderr: outcome.stderr ?? '',
      durationMs,
      timedOut,
      output: outcome.output ?? {},
    };
  }

  stop(): SandboxSummary {
    if (this.status !== 'stopped') {
      this.status = 'stopped';
      this.log('system', `stopping sandbox ${this.id} (runs=${this.runs})`);
    }
    return {
      sessionId: this.id,
      kind: this.kind,
      runs: this.runs,
      totalDurationMs: this.totalDurationMs,
      limits: this.limits,
    };
  }

  logs(): readonly SandboxLogLine[] {
    return this.logLines;
  }

  private log(stream: SandboxLogLine['stream'], message: string): void {
    this.logLines.push({ at: Date.now(), stream, message });
  }
}

/** Factory: create a sandbox session of the given kind with optional resource limits. */
export function createSandboxSession(kind: SandboxKind = 'gvisor', limits?: Partial<ResourceLimits>): SandboxSession {
  return new StubSandboxSession(kind, { ...DEFAULT_LIMITS, ...limits });
}
