/**
 * vision/sandbox_gvisor.ts — Phase 5 REAL gVisor sandbox adapter for VISION.
 *
 * Phase 3/4 shipped `StubSandboxSession` (sandbox.ts): a realistic start→run*→stop lifecycle
 * with resource accounting and timeout kills, but launching NOTHING real. This module is the
 * first real slice of that isolation seam: `GvisorSandboxSession` implements the SAME
 * `SandboxSession` interface, but provisions a genuinely isolated sandbox using gVisor
 * (`runsc`) driven through Docker's `--runtime=runsc`.
 *
 * OFFLINE-FIRST / SAFE-BY-DEFAULT
 * -------------------------------
 *   - `isGvisorAvailable()` probes for the `runsc` runtime (and `docker`) on the host. When
 *     they are absent it returns `false`, and the factory (`createSandboxSession`) transparently
 *     falls back to the stub. So the default offline suite and any host without gVisor keep
 *     working unchanged — no container is ever launched there.
 *   - Even when gVisor IS available, this adapter only shells out for a run whose supplied
 *     runner returns a concrete `output.command` (a real command to execute inside the
 *     sandbox). Runs that provide only simulated `durationMs`/`memMb` are accounted for exactly
 *     like the stub, so the adapter is a strict superset of the stub's behavior.
 *
 * INVARIANT PRESERVED (mirrors sandbox.ts): the sandbox is isolation + accounting only. It runs
 * the caller-provided command inside a locked-down gVisor container with CPU/memory caps and a
 * wall-clock timeout kill (exit 124); it never governs, routes, or bypasses APEX/KNOLL. VISION
 * still returns results to HOPE via APEX only.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { estimateCpuSeconds } from './resource_monitor.js';
import {
  DEFAULT_LIMITS,
  type ResourceLimits,
  type SandboxHooks,
  type SandboxInvocation,
  type SandboxKind,
  type SandboxLogLine,
  type SandboxRunResult,
  type SandboxRunner,
  type SandboxSession,
  type SandboxStatus,
  type SandboxSummary,
} from './sandbox.js';

/** The gVisor OCI runtime binary. Its presence is the availability signal. */
export const GVISOR_RUNTIME_BIN = 'runsc';
/** Default sandbox image — a minimal, widely-cached base. Override via options. */
export const DEFAULT_GVISOR_IMAGE = 'alpine:3.20';

let cachedAvailable: boolean | undefined;

function binaryWorks(bin: string, args: string[]): boolean {
  try {
    const result = spawnSync(bin, args, { stdio: 'ignore', timeout: 3000 });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Whether a real gVisor sandbox can run here: the `runsc` runtime AND the `docker` client must
 * both be invocable. Cached after the first probe (pass `{ refresh: true }` to re-probe). When
 * this is `false`, `createSandboxSession('gvisor', …)` falls back to the stub.
 */
export function isGvisorAvailable(options: { refresh?: boolean } = {}): boolean {
  if (!options.refresh && cachedAvailable !== undefined) return cachedAvailable;
  const available = binaryWorks(GVISOR_RUNTIME_BIN, ['--version']) && binaryWorks('docker', ['--version']);
  cachedAvailable = available;
  return available;
}

export interface GvisorSandboxOptions extends SandboxHooks {
  /** Container image the sandbox runs. Default `DEFAULT_GVISOR_IMAGE`. */
  image?: string;
  /** Docker runtime name to request. Default `runsc` (gVisor). */
  runtime?: string;
}

/** The shape a runner may return to request a REAL command execution inside the sandbox. */
interface GvisorCommandHint {
  /** A command + args to exec inside the container. String is split on whitespace. */
  command?: string | string[];
}

/**
 * A real gVisor-backed `SandboxSession`. Provisions an isolated container on `start()`
 * (`docker run -d --runtime=runsc --cpus=… --memory=…m <image> sleep …`), execs caller
 * commands inside it on `run()`, and tears it down on `stop()`. Satisfies the exact same
 * synchronous `SandboxSession` interface as `StubSandboxSession`.
 */
export class GvisorSandboxSession implements SandboxSession {
  readonly id: string;
  readonly kind: SandboxKind = 'gvisor';
  readonly limits: ResourceLimits;
  status: SandboxStatus = 'created';

  private readonly image: string;
  private readonly runtime: string;
  private readonly hooks: GvisorSandboxOptions;
  private containerId?: string;

  private readonly logLines: SandboxLogLine[] = [];
  private readonly invocationLog: SandboxInvocation[] = [];
  private runsCount = 0;
  private totalDurationMs = 0;
  private cpuSeconds = 0;
  private peakMemMb = 0;
  private timeoutsCount = 0;
  private killedByTimeout = false;

  constructor(limits: ResourceLimits = DEFAULT_LIMITS, options: GvisorSandboxOptions = {}) {
    this.limits = limits;
    this.image = options.image ?? DEFAULT_GVISOR_IMAGE;
    this.runtime = options.runtime ?? GVISOR_RUNTIME_BIN;
    this.hooks = options;
    this.id = `sbx_gvisor_${randomBytes(16).toString('hex')}`;
    this.log('system', `session ${this.id} created (cpu=${limits.cpu}, mem=${limits.memMb}MB, timeout=${limits.timeoutMs}ms)`);
    this.hooks.monitor?.openSession(this.id, this.kind, this.limits);
  }

  start(): void {
    if (this.status === 'running') return;
    if (this.status === 'stopped') throw new Error(`sandbox ${this.id} is stopped and cannot be restarted`);
    // Keep-alive the sandbox for a little over its wall-clock timeout so exec's timeout kill,
    // not the container's own lifetime, governs a run.
    const keepAliveSec = Math.max(1, Math.ceil(this.limits.timeoutMs / 1000) + 5);
    const args = [
      'run',
      '-d',
      '--rm',
      `--runtime=${this.runtime}`,
      `--cpus=${this.limits.cpu}`,
      `--memory=${this.limits.memMb}m`,
      '--network=none',
      this.image,
      'sleep',
      String(keepAliveSec),
    ];
    const launch = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
    if (launch.error || launch.status !== 0) {
      const detail = launch.error ? launch.error.message : (launch.stderr ?? '').trim();
      throw new Error(`gVisor sandbox ${this.id} failed to start: ${detail || 'docker run failed'}`);
    }
    this.containerId = (launch.stdout ?? '').trim();
    this.status = 'running';
    this.log('system', `started gVisor sandbox ${this.id} (container ${this.containerId.slice(0, 12)})`);
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

    // If the runner requested a concrete command, execute it FOR REAL inside the gVisor
    // container; otherwise fall back to the runner's simulated result (stub-equivalent).
    const command = extractCommand(outcome.output);
    if (command && this.containerId) {
      return this.execReal(label, command, outcome, startedAt);
    }

    const durationMs = outcome.durationMs !== undefined
      ? Math.max(1, Math.round(outcome.durationMs))
      : Math.max(1, Date.now() - startedAt);
    const memMb = clampMem(outcome.memMb, this.limits.memMb);
    const timedOut = durationMs > this.limits.timeoutMs;
    if (outcome.stdout) this.log('stdout', outcome.stdout);
    if (outcome.stderr) this.log('stderr', outcome.stderr);
    const exitCode = timedOut ? 124 : outcome.exitCode;
    this.account(label, durationMs, memMb, exitCode, timedOut);
    if (timedOut) this.killOnTimeout(label, durationMs);

    return {
      exitCode,
      stdout: outcome.stdout ?? '',
      stderr: timedOut ? `killed: exceeded ${this.limits.timeoutMs}ms timeout` : outcome.stderr ?? '',
      durationMs,
      timedOut,
      output: outcome.output ?? {},
    };
  }

  private execReal(
    label: string,
    command: string[],
    outcome: ReturnType<SandboxRunner>,
    startedAt: number,
  ): SandboxRunResult {
    const exec = spawnSync('docker', ['exec', this.containerId as string, ...command], {
      encoding: 'utf8',
      timeout: this.limits.timeoutMs,
    });
    const durationMs = Math.max(1, Date.now() - startedAt);
    const timedOut = exec.error !== undefined && (exec.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const stdout = exec.stdout ?? '';
    const stderr = timedOut ? `killed: exceeded ${this.limits.timeoutMs}ms timeout` : exec.stderr ?? '';
    const exitCode = timedOut ? 124 : exec.status ?? 1;
    const memMb = clampMem(outcome.memMb, this.limits.memMb);
    if (stdout) this.log('stdout', stdout);
    if (stderr) this.log('stderr', stderr);
    this.account(label, durationMs, memMb, exitCode, timedOut);
    if (timedOut) this.killOnTimeout(label, durationMs);
    return {
      exitCode,
      stdout,
      stderr,
      durationMs,
      timedOut,
      output: { ...(outcome.output ?? {}), command, ran: 'gvisor' },
    };
  }

  stop(): SandboxSummary {
    if (this.status !== 'stopped') {
      this.status = 'stopped';
      this.log('system', `stopping sandbox ${this.id} (runs=${this.runsCount})`);
      if (this.containerId) {
        // Best-effort teardown; --rm removes it, this just stops the keep-alive early.
        spawnSync('docker', ['rm', '-f', this.containerId], { stdio: 'ignore', timeout: 15_000 });
        this.containerId = undefined;
      }
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

  private killOnTimeout(label: string, durationMs: number): void {
    this.killedByTimeout = true;
    this.log('system', `sandbox ${this.id} killed: run "${label}" exceeded timeout (${durationMs}ms > ${this.limits.timeoutMs}ms)`);
    this.stop();
  }

  private summary(): SandboxSummary {
    return {
      sessionId: this.id,
      kind: this.kind,
      runs: this.runsCount,
      totalDurationMs: this.totalDurationMs,
      cpuSeconds: round4(this.cpuSeconds),
      peakMemMb: this.peakMemMb,
      timeouts: this.timeoutsCount,
      killedByTimeout: this.killedByTimeout,
      limits: this.limits,
    };
  }

  private account(label: string, durationMs: number, memMb: number, exitCode: number, timedOut: boolean): void {
    const cpuSeconds = estimateCpuSeconds(durationMs, this.limits);
    this.runsCount += 1;
    this.totalDurationMs += durationMs;
    this.cpuSeconds = round4(this.cpuSeconds + cpuSeconds);
    this.peakMemMb = Math.max(this.peakMemMb, memMb);
    if (timedOut) this.timeoutsCount += 1;
    this.invocationLog.push({ label, at: Date.now(), durationMs, exitCode, timedOut });
    this.hooks.monitor?.recordRun(this.id, label, { durationMs, cpuSeconds, memMb, timedOut }, exitCode);
  }

  private log(stream: SandboxLogLine['stream'], message: string): void {
    this.logLines.push({ at: Date.now(), stream, message });
  }
}

function extractCommand(output: Record<string, unknown> | undefined): string[] | undefined {
  const raw = (output as GvisorCommandHint | undefined)?.command;
  if (typeof raw === 'string') {
    const parts = raw.trim().split(/\s+/).filter((s) => s.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  if (Array.isArray(raw)) {
    const parts = raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

function clampMem(memMb: number | undefined, cap: number): number {
  if (memMb === undefined || !Number.isFinite(memMb) || memMb < 0) return cap;
  return Math.min(memMb, cap);
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}
