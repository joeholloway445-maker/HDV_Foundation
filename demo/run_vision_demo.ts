/**
 * demo/run_vision_demo.ts — VISION sandbox + tool library demo (Phase 4.2).
 *
 * Shows the hardened VISION Action Layer end to end WITHOUT weakening any constraint:
 *   1. TOOL LIBRARY — the expanded registry, including the new http_fetch + json_transform.
 *   2. http_fetch STUB — allowlisted host returns a mock; an off-allowlist host is BLOCKED.
 *      No real network is ever touched.
 *   3. json_transform — safe path extract + array map (pure traversal, never eval).
 *   4. TIMEOUT KILL — a run that exceeds the wall-clock timeout is force-killed (exit 124).
 *   5. CONCURRENT LIMIT — SandboxManager caps live sessions; the cap is enforced.
 *   6. RESOURCE + AUDIT — per-session CPU/mem usage and a tool-invocation audit trail.
 *   7. VIA APEX ONLY — a VISION execution routed through APEX reports back to HOPE (never DREAM).
 *
 * VISION cannot create or govern; results travel back to HOPE via APEX only.
 *
 * Run: npm run demo:vision
 */
import { ApexOrchestrator } from '../apex/index.js';
import { AgentRole } from '../config/routing_schema.js';
import {
  ExecutionEngine,
  ResourceMonitor,
  SandboxManager,
  createSandboxSession,
} from '../vision/index.js';

function hr(title: string): void {
  console.log('\n' + '='.repeat(76));
  console.log(title);
  console.log('='.repeat(76));
}

function main(): void {
  hr('BIG 5 MATRIX — VISION DEMO (tools · http_fetch stub · timeout kill · limits · audit)');

  const monitor = new ResourceMonitor();
  const engine = new ExecutionEngine('gvisor', undefined, { monitor });

  // -------------------------------------------------------------------------
  // 1. TOOL LIBRARY
  // -------------------------------------------------------------------------
  hr('1 — VISION TOOL LIBRARY');
  console.log(`Registered tools: ${engine.availableTools().join(', ')}`);

  // -------------------------------------------------------------------------
  // 2. http_fetch STUB — allowlisted vs blocked. No real network is opened.
  // -------------------------------------------------------------------------
  hr('2 — http_fetch (allowlisted-domain STUB · no real network)');
  const okFetch = engine.execute('fetch allowlisted', {
    tool: 'http_fetch',
    args: { url: 'https://api.example.com/v1/items?limit=2', method: 'GET' },
  });
  const okResp = okFetch.output.response as Record<string, unknown>;
  console.log(`   allowlisted -> ok=${okFetch.ok} status=${okResp.status} (mock=${okFetch.output.mock})`);

  const blockedFetch = engine.execute('fetch off-allowlist', {
    tool: 'http_fetch',
    args: { url: 'https://evil.example.io/steal' },
  });
  console.log(`   off-allowlist -> ok=${blockedFetch.ok} exit=${blockedFetch.exitCode} reason=${blockedFetch.output.reason}`);

  const blockedScheme = engine.execute('fetch bad scheme', {
    tool: 'http_fetch',
    args: { url: 'file:///etc/passwd' },
  });
  console.log(`   file:// scheme -> ok=${blockedScheme.ok} exit=${blockedScheme.exitCode} reason=${blockedScheme.output.reason}`);

  // -------------------------------------------------------------------------
  // 3. json_transform — safe extract + map
  // -------------------------------------------------------------------------
  hr('3 — json_transform (safe path extract + array map)');
  const extract = engine.execute('extract', {
    tool: 'json_transform',
    args: { data: { a: { b: [{ c: 42 }] } }, path: 'a.b[0].c' },
  });
  console.log(`   extract a.b[0].c -> ${JSON.stringify(extract.output.value)}`);

  const mapped = engine.execute('map', {
    tool: 'json_transform',
    args: {
      data: { rows: [{ id: 1, name: 'a', secret: 'x' }, { id: 2, name: 'b' }] },
      path: 'rows',
      select: { key: 'id', label: 'name' },
    },
  });
  console.log(`   map rows -> ${JSON.stringify(mapped.output.values)}`);

  // -------------------------------------------------------------------------
  // 4. TIMEOUT KILL — a slow run over the wall-clock timeout is force-killed.
  // -------------------------------------------------------------------------
  hr('4 — TIMEOUT KILL (run exceeds wall-clock timeout -> exit 124, session stopped)');
  const killSession = createSandboxSession('docker', { timeoutMs: 50 }, { monitor });
  killSession.start();
  const slow = killSession.run('slow-task', () => ({ exitCode: 0, durationMs: 500 }));
  console.log(`   slow run -> timedOut=${slow.timedOut} exit=${slow.exitCode} status=${killSession.status}`);
  try {
    killSession.run('after-kill', () => ({ exitCode: 0 }));
  } catch (err) {
    console.log(`   subsequent run rejected: ${(err as Error).message}`);
  }

  // -------------------------------------------------------------------------
  // 5. CONCURRENT SESSION LIMIT
  // -------------------------------------------------------------------------
  hr('5 — CONCURRENT SESSION LIMIT (SandboxManager cap)');
  const manager = new SandboxManager({ maxConcurrent: 2, monitor });
  const s1 = manager.create('gvisor');
  const s2 = manager.create('gvisor');
  console.log(`   opened 2 sessions -> active=${manager.activeCount()}/${manager.maxConcurrent}`);
  try {
    manager.create('gvisor');
  } catch (err) {
    console.log(`   third session rejected: ${(err as Error).message}`);
  }
  s1.stop();
  console.log(`   after stopping one -> active=${manager.activeCount()}; slot freed`);
  const s3 = manager.create('gvisor');
  s2.stop();
  s3.stop();
  console.log(`   manager stats: ${JSON.stringify(manager.stats())}`);

  // -------------------------------------------------------------------------
  // 6. RESOURCE + AUDIT ROLLUP
  // -------------------------------------------------------------------------
  hr('6 — RESOURCE USAGE + TOOL-INVOCATION AUDIT');
  const totals = monitor.totals();
  console.log(`   sessions=${totals.sessions} runs=${totals.runs} cpuSeconds=${totals.cpuSeconds} timeouts=${totals.timeouts}`);
  console.log('   audit trail:');
  for (const rec of monitor.auditLog()) {
    console.log(
      `     ${rec.sessionId.slice(0, 20)}… ${rec.label.padEnd(14)} exit=${rec.exitCode} ` +
        `dur=${rec.durationMs}ms cpu=${rec.cpuSeconds}s${rec.timedOut ? ' [TIMEOUT]' : ''}`,
    );
  }

  // -------------------------------------------------------------------------
  // 7. RESULTS RETURN VIA APEX ONLY (never DREAM)
  // -------------------------------------------------------------------------
  hr('7 — RESULTS RETURN TO HOPE VIA APEX ONLY');
  const orch = new ApexOrchestrator();
  const routedVision = new ExecutionEngine('gvisor', orch.sendViaApex);
  const hopeIntents: string[] = [];
  orch.wire({
    vision: routedVision.asHandler(),
    hope: (packet) => {
      hopeIntents.push(packet.payload.intent);
      return { acknowledged: true };
    },
  });
  const dispatched = orch.sendViaApex({
    source: AgentRole.APEX,
    destination: AgentRole.VISION,
    intent: 'run http_fetch',
    data: { tool: 'http_fetch', args: { url: 'https://api.example.com/ping' } },
  });
  console.log(`   dispatch status: ${dispatched.status}`);
  console.log(`   HOPE received via APEX: ${hopeIntents.filter((i) => i.startsWith('execution-result:')).length} result(s)`);

  hr('VISION DEMO COMPLETE — http_fetch is a hermetic stub; timeouts kill; limits enforced; results via APEX only.');
}

main();
