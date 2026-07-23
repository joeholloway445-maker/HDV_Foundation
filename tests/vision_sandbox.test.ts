/**
 * tests/vision_sandbox.test.ts — Phase 4.2 (VISION sandbox hardening + new tools).
 *
 * Covers the expanded VISION surface WITHOUT weakening any constraint:
 *   - http_fetch: allowlisted-domain stub, no real network, mock responses, host/scheme blocks
 *   - json_transform: safe path extract + array map, prototype-pollution safe
 *   - ResourceMonitor: per-session CPU/mem/timeout usage + tool-invocation audit
 *   - SandboxManager: concurrent session limit + slot release on stop
 *   - timeout kill: a run over the wall-clock timeout is force-killed (exit 124)
 *   - VISION still cannot govern and reports back to HOPE via APEX only
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentRole } from '../config/routing_schema.js';
import { ApexOrchestrator } from '../apex/index.js';
import {
  ExecutionEngine,
  ToolRegistry,
  SandboxManager,
  ResourceMonitor,
  createSandboxSession,
  estimateCpuSeconds,
  DEFAULT_HTTP_ALLOWLIST,
  DEFAULT_TOOLS,
} from '../vision/index.js';

// ---------------------------------------------------------------------------
// http_fetch — allowlisted stub, no real network
// ---------------------------------------------------------------------------

test('http_fetch is registered in the default tool library', () => {
  const engine = new ExecutionEngine();
  assert.ok(engine.availableTools().includes('http_fetch'));
  assert.ok(engine.availableTools().includes('json_transform'));
  assert.equal(DEFAULT_TOOLS.length, 6);
});

test('http_fetch returns a deterministic mock for an allowlisted host', () => {
  const engine = new ExecutionEngine();
  const report = engine.execute('fetch', {
    tool: 'http_fetch',
    args: { url: 'https://api.example.com/v1/items?limit=2', method: 'GET' },
  });
  assert.equal(report.ok, true);
  assert.equal(report.output.mock, true);
  const response = report.output.response as Record<string, unknown>;
  assert.equal(response.status, 200);
  const body = response.body as Record<string, unknown>;
  assert.equal(body.mock, true);
  assert.equal(body.path, '/v1/items');
  assert.deepEqual(body.query, { limit: '2' });
  assert.ok(DEFAULT_HTTP_ALLOWLIST.includes('api.example.com'));
});

test('http_fetch blocks a host that is not on the allowlist', () => {
  const engine = new ExecutionEngine();
  const report = engine.execute('fetch', {
    tool: 'http_fetch',
    args: { url: 'https://evil.example.io/steal' },
  });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 126);
  assert.equal(report.output.blocked, true);
  assert.equal(report.output.reason, 'host');
});

test('http_fetch blocks non-http(s) schemes', () => {
  const engine = new ExecutionEngine();
  const report = engine.execute('fetch', {
    tool: 'http_fetch',
    args: { url: 'file:///etc/passwd' },
  });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 126);
  assert.equal(report.output.reason, 'scheme');
});

test('http_fetch honors a per-call allowlist extension but stays a stub', () => {
  const engine = new ExecutionEngine();
  const report = engine.execute('fetch', {
    tool: 'http_fetch',
    args: { url: 'https://internal.svc.local/health', allow: ['internal.svc.local'] },
  });
  assert.equal(report.ok, true);
  assert.equal(report.output.mock, true);
});

test('http_fetch rejects malformed urls and unsupported methods', () => {
  const engine = new ExecutionEngine();
  const badUrl = engine.execute('fetch', { tool: 'http_fetch', args: { url: 'not a url' } });
  assert.equal(badUrl.ok, false);
  assert.equal(badUrl.exitCode, 22);

  const badMethod = engine.execute('fetch', {
    tool: 'http_fetch',
    args: { url: 'https://api.example.com/x', method: 'BREW' },
  });
  assert.equal(badMethod.ok, false);
  assert.equal(badMethod.exitCode, 2);
});

// ---------------------------------------------------------------------------
// json_transform — safe path extract + array map
// ---------------------------------------------------------------------------

test('json_transform extracts a value at a dot/bracket path', () => {
  const engine = new ExecutionEngine();
  const report = engine.execute('xf', {
    tool: 'json_transform',
    args: { data: { a: { b: [{ c: 42 }] } }, path: 'a.b[0].c' },
  });
  assert.equal(report.ok, true);
  assert.equal(report.output.mode, 'extract');
  assert.equal(report.output.found, true);
  assert.equal(report.output.value, 42);
});

test('json_transform reports a missing path without throwing', () => {
  const engine = new ExecutionEngine();
  const report = engine.execute('xf', {
    tool: 'json_transform',
    args: { data: { a: 1 }, path: 'a.missing.deep' },
  });
  assert.equal(report.ok, false);
  assert.equal(report.output.found, false);
  assert.equal(report.output.value, null);
});

test('json_transform maps an array through a select projection', () => {
  const engine = new ExecutionEngine();
  const report = engine.execute('xf', {
    tool: 'json_transform',
    args: {
      data: { rows: [{ id: 1, name: 'a', extra: 9 }, { id: 2, name: 'b' }] },
      path: 'rows',
      select: { key: 'id', label: 'name' },
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.output.mode, 'map');
  assert.equal(report.output.count, 2);
  assert.deepEqual(report.output.values, [
    { key: 1, label: 'a' },
    { key: 2, label: 'b' },
  ]);
});

test('json_transform is safe against prototype pollution paths', () => {
  const engine = new ExecutionEngine();
  const report = engine.execute('xf', {
    tool: 'json_transform',
    args: { data: { a: 1 }, path: '__proto__.polluted' },
  });
  assert.equal(report.output.found, false);
  assert.equal(report.output.value, null);
});

test('json_transform requires data and a path or select', () => {
  const engine = new ExecutionEngine();
  const noData = engine.execute('xf', { tool: 'json_transform', args: { path: 'a' } });
  assert.equal(noData.exitCode, 2);
  const noSpec = engine.execute('xf', { tool: 'json_transform', args: { data: { a: 1 } } });
  assert.equal(noSpec.exitCode, 2);
});

// ---------------------------------------------------------------------------
// ResourceMonitor — per-session usage + tool-invocation audit
// ---------------------------------------------------------------------------

test('estimateCpuSeconds applies the fractional cpu limit', () => {
  assert.equal(estimateCpuSeconds(2000, { cpu: 0.5, memMb: 128, timeoutMs: 5000 }), 1);
  assert.equal(estimateCpuSeconds(1000, { cpu: 2, memMb: 128, timeoutMs: 5000 }), 2);
});

test('ResourceMonitor tracks per-session usage and an audit trail', () => {
  const monitor = new ResourceMonitor();
  const session = createSandboxSession('gvisor', { cpu: 1, memMb: 256, timeoutMs: 5000 }, { monitor });
  session.start();
  session.run('t1', () => ({ exitCode: 0, durationMs: 100, memMb: 64 }));
  session.run('t2', () => ({ exitCode: 0, durationMs: 200, memMb: 128 }));
  session.stop();

  const usage = monitor.usage(session.id);
  assert.ok(usage);
  assert.equal(usage?.runs, 2);
  assert.equal(usage?.totalDurationMs, 300);
  assert.equal(usage?.peakMemMb, 128);
  assert.equal(usage?.timeouts, 0);
  assert.ok((usage?.endedAt ?? 0) >= (usage?.startedAt ?? 0));

  const audit = monitor.auditFor(session.id);
  assert.equal(audit.length, 2);
  assert.equal(audit[0].label, 't1');
  assert.equal(audit[1].label, 't2');

  const totals = monitor.totals();
  assert.equal(totals.sessions, 1);
  assert.equal(totals.runs, 2);
});

test('the engine exposes resource usage and a tool audit trail', () => {
  const engine = new ExecutionEngine();
  engine.execute('a', { tool: 'system_info' });
  engine.execute('b', { tool: 'json_transform', args: { data: { x: 1 }, path: 'x' } });
  assert.equal(engine.resourceUsage().length, 2);
  const audit = engine.toolAudit();
  assert.ok(audit.some((r) => r.label === 'system_info'));
  assert.ok(audit.some((r) => r.label === 'json_transform'));
});

test('an execution report carries cpu/mem billing metadata', () => {
  const engine = new ExecutionEngine();
  const report = engine.execute('info', { tool: 'system_info' });
  assert.equal(typeof report.billable.cpuSeconds, 'number');
  assert.ok(report.peakMemMb >= 0);
  assert.equal(report.timedOut, false);
});

// ---------------------------------------------------------------------------
// Timeout kill
// ---------------------------------------------------------------------------

test('a run that exceeds the timeout is force-killed with exit 124', () => {
  const monitor = new ResourceMonitor();
  const session = createSandboxSession('docker', { timeoutMs: 50 }, { monitor });
  session.start();
  const run = session.run('slow', () => ({ exitCode: 0, durationMs: 500 }));
  assert.equal(run.timedOut, true);
  assert.equal(run.exitCode, 124);
  // Timeout kill stops the session; a subsequent run must throw.
  assert.equal(session.status, 'stopped');
  assert.throws(() => session.run('again', () => ({ exitCode: 0 })), /killed after a timeout/);

  const usage = monitor.usage(session.id);
  assert.equal(usage?.timeouts, 1);
  assert.equal(usage?.killedByTimeout, true);
});

test('a normal fast run does not trip the timeout', () => {
  const session = createSandboxSession('gvisor', { timeoutMs: 5000 });
  session.start();
  const run = session.run('fast', () => ({ exitCode: 0, stdout: 'ok', durationMs: 5 }));
  assert.equal(run.timedOut, false);
  assert.equal(run.exitCode, 0);
  const summary = session.stop();
  assert.equal(summary.killedByTimeout, false);
  assert.equal(summary.timeouts, 0);
});

// ---------------------------------------------------------------------------
// SandboxManager — concurrent session limit
// ---------------------------------------------------------------------------

test('SandboxManager enforces the concurrent session limit', () => {
  const manager = new SandboxManager({ maxConcurrent: 2 });
  const a = manager.create('gvisor');
  const b = manager.create('gvisor');
  assert.equal(manager.activeCount(), 2);
  assert.throws(() => manager.create('gvisor'), /concurrent session limit reached/);

  // Stopping one frees a slot.
  a.stop();
  assert.equal(manager.activeCount(), 1);
  const c = manager.create('gvisor');
  assert.equal(manager.activeCount(), 2);

  b.stop();
  c.stop();
  assert.equal(manager.activeCount(), 0);

  const stats = manager.stats();
  assert.equal(stats.opened, 3);
  assert.equal(stats.rejected, 1);
  assert.equal(stats.maxConcurrent, 2);
});

test('SandboxManager rejects an invalid concurrency cap', () => {
  assert.throws(() => new SandboxManager({ maxConcurrent: 0 }), /maxConcurrent must be >= 1/);
});

test('SandboxManager shares a monitor across sessions', () => {
  const monitor = new ResourceMonitor();
  const manager = new SandboxManager({ maxConcurrent: 4, monitor });
  const s = manager.create('gvisor', { memMb: 128 });
  s.start();
  s.run('probe', () => ({ exitCode: 0, durationMs: 10, memMb: 32 }));
  s.stop();
  assert.equal(monitor.totals().sessions, 1);
  assert.equal(monitor.totals().runs, 1);
});

// ---------------------------------------------------------------------------
// Constraints preserved: VISION cannot govern; results return via APEX only
// ---------------------------------------------------------------------------

test('new tools do not let VISION create governance packets — results return via APEX only', () => {
  const orch = new ApexOrchestrator();
  const vision = new ExecutionEngine('gvisor', orch.sendViaApex);
  const hopeIntents: string[] = [];
  orch.wire({
    vision: vision.asHandler(),
    hope: (packet) => {
      hopeIntents.push(packet.payload.intent);
      return { acknowledged: true };
    },
  });

  const forwarded = orch.sendViaApex({
    source: AgentRole.APEX,
    destination: AgentRole.VISION,
    intent: 'run http_fetch',
    data: { tool: 'http_fetch', args: { url: 'https://api.example.com/ping' } },
  });
  assert.equal(forwarded.status, 'SUCCESS');
  assert.ok(hopeIntents.some((i) => i.startsWith('execution-result:')));
});

test('ToolRegistry with an explicit tool list can omit or include new tools', () => {
  const full = new ToolRegistry();
  assert.ok(full.has('http_fetch'));
  assert.ok(full.has('json_transform'));
  const empty = new ToolRegistry([]);
  assert.equal(empty.list().length, 0);
});
