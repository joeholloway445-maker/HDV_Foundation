/**
 * tests/phase3.test.ts — Phase 3 tests (VISION tool registry + sandbox isolation).
 * Results flow back only via APEX. Never regresses Phase 1/2.
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
  createSandboxSession,
} from '../vision/index.js';

// ---------------------------------------------------------------------------
// Sandbox session lifecycle
// ---------------------------------------------------------------------------

test('sandbox session enforces start -> run -> stop lifecycle', () => {
  const session = createSandboxSession('docker', { timeoutMs: 1000 });
  assert.ok(session.id.startsWith('sbx_docker_'), 'realistic session id');
  assert.equal(session.status, 'created');
  assert.throws(() => session.run('early', () => ({ exitCode: 0 })), /must be started/);

  session.start();
  assert.equal(session.status, 'running');
  const run = session.run('echo', () => ({ exitCode: 0, stdout: 'hi' }));
  assert.equal(run.exitCode, 0);
  assert.equal(run.stdout, 'hi');

  const summary = session.stop();
  assert.equal(session.status, 'stopped');
  assert.equal(summary.runs, 1);
  assert.throws(() => session.start(), /stopped and cannot be restarted/);
  assert.ok(session.logs().length >= 1, 'sandbox emits logs');
});

// ---------------------------------------------------------------------------
// Tool registry — code_exec / data_ingest / system_info / file_plan
// ---------------------------------------------------------------------------

test('VISION tool registry exposes the default tool library', () => {
  const engine = new ExecutionEngine();
  const tools = engine.availableTools();
  for (const t of ['code_exec', 'data_ingest', 'system_info', 'file_plan']) {
    assert.ok(tools.includes(t), `tool ${t} registered`);
  }
});

test('code_exec safely evaluates arithmetic and blocks disallowed tokens', () => {
  const engine = new ExecutionEngine();
  const ok = engine.execute('calc', { tool: 'code_exec', args: { code: '2 + 3 * 4' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.output.value, 14);
  assert.equal(ok.output.evaluated, true);

  const blocked = engine.execute('evil', { tool: 'code_exec', args: { code: 'require("fs").readFileSync("/etc/passwd")' } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.exitCode, 126);
  assert.equal(blocked.output.blocked, true);
});

test('data_ingest validates records against a schema and summarizes', () => {
  const engine = new ExecutionEngine();
  const report = engine.execute('ingest', {
    tool: 'data_ingest',
    args: {
      records: [
        { name: 'a', age: 1 },
        { name: 'b' },
        'not-an-object',
      ],
      schema: { name: 'string', age: 'number' },
    },
  });
  assert.equal(report.output.total, 3);
  assert.equal(report.output.valid, 1);
  assert.equal(report.output.invalid, 2);
});

test('system_info returns safe read-only metadata only', () => {
  const engine = new ExecutionEngine('gvisor');
  const report = engine.execute('info', { tool: 'system_info' });
  assert.equal(report.ok, true);
  assert.equal(report.output.readOnly, true);
  assert.equal(report.output.sandboxKind, 'gvisor');
});

test('file_plan plans without writing to real disk and applies only to memory FS', () => {
  const engine = new ExecutionEngine();
  const planOnly = engine.execute('plan', {
    tool: 'file_plan',
    args: { operations: [{ op: 'write', path: '/tmp/report.txt', contents: 'hello' }] },
  });
  assert.equal(planOnly.output.applied, false);
  assert.deepEqual(planOnly.output.memfsKeys, []);

  const applied = engine.execute('plan', {
    tool: 'file_plan',
    args: { apply: true, operations: [{ op: 'write', path: '/tmp/report.txt', contents: 'hello' }] },
  });
  assert.equal(applied.output.applied, true);
  assert.deepEqual(applied.output.memfsKeys, ['/tmp/report.txt']);
});

test('unknown tool yields a non-zero exit and does not throw', () => {
  const engine = new ExecutionEngine();
  const report = engine.execute('x', { tool: 'does_not_exist' });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 127);
});

test('ToolRegistry.run throws for an unregistered tool name', () => {
  const registry = new ToolRegistry();
  const session = createSandboxSession();
  session.start();
  assert.throws(() => registry.run('nope', {}, { sandbox: session }), /unknown tool/);
  session.stop();
});

// ---------------------------------------------------------------------------
// Execution report is billable + returns via APEX only
// ---------------------------------------------------------------------------

test('ExecutionReport carries billable accounting fields', () => {
  const engine = new ExecutionEngine();
  const report = engine.execute('info', { tool: 'system_info' });
  assert.equal(report.personaCount, 1);
  assert.equal(report.billable.personas, 1);
  assert.ok(report.billable.sandboxSeconds >= 0);
  assert.ok(report.sessionId.length > 0);
  assert.ok(report.logs.length >= 1);
});

test('VISION results return to HOPE only via APEX (never DREAM)', () => {
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
    intent: 'run system_info',
    data: { tool: 'system_info' },
  });
  assert.equal(forwarded.status, 'SUCCESS');
  assert.ok(hopeIntents.some((i) => i.startsWith('execution-result:')), 'VISION reported back to HOPE via APEX');
});
