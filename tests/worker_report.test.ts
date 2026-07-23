/**
 * tests/worker_report.test.ts — Phase 5 gateway worker re-ingestion tests.
 *
 * Covers POST /v1/worker/report on the HOPE gateway WITHOUT regressing any invariant:
 *   - A DREAM/VISION worker result (WorkerReport.to_apex_payload() shape) is re-ingested
 *     through APEX (→ KNOLL → HOPE). It never bypasses APEX or KNOLL: every valid report is
 *     audited by KNOLL and lands in HOPE's result sink.
 *   - Worker-protocol invariants are enforced at the gateway: only ephemeral DREAM/VISION may
 *     report; a direct DREAM↔VISION hand-off is rejected with 400 (and never dispatched).
 *   - KNOLL remains the authority for everything else: a malicious re-ingested report is
 *     BLOCKED and surfaces as HTTP 403 — proving the queue/gateway can't smuggle it past KNOLL.
 *
 * Handler-level checks run without a port; a few cases also run over real HTTP.
 *
 * Run: npm run test:worker-report   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { HopeGateway } from '../gateway/index.js';

async function withServer(gw: HopeGateway, fn: (base: string) => Promise<void>): Promise<void> {
  const server = await gw.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** A payload shaped exactly like colab/worker_protocol.py WorkerReport.to_apex_payload(). */
function workerPayload(role: 'DREAM' | 'VISION', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: role,
    destination: 'HOPE',
    intent: `worker-result:${role.toLowerCase()}`,
    data: {
      kind: 'WORKER_RESULT',
      workerId: `worker_${role.toLowerCase()}_abc123`,
      agentRole: role,
      gpuHint: 'T4',
      nodeSlice: { manager_start: 0, manager_count: 1, nodes_per_manager: 1 },
      personaCount: 100,
      avgScore: 0.7321,
      topScores: [0.9, 0.85, 0.8],
      activeParameters: 700_000_000_000,
      ephemeral: true,
      selfTerminated: true,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. Valid re-ingestion — through APEX + KNOLL to HOPE
// ---------------------------------------------------------------------------

test('DREAM worker report is re-ingested via APEX → KNOLL → HOPE', () => {
  const gw = new HopeGateway({ logger: false });
  const auditBefore = gw.orchestrator.auditTrail().length;

  const res = gw.handleWorkerReport(workerPayload('DREAM'));

  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, true);
  assert.equal(res.body.ingested, true);
  assert.equal(res.body.routingStatus, 'SUCCESS');
  assert.equal(res.body.source, 'DREAM');
  assert.equal(res.body.destination, 'HOPE');
  assert.equal(res.body.workerId, 'worker_dream_abc123');
  const knoll = res.body.knoll as { isAllowed: boolean };
  assert.equal(knoll.isAllowed, true, 'KNOLL allowed the DREAM → HOPE report');
  assert.ok(
    gw.orchestrator.auditTrail().length > auditBefore,
    'KNOLL audited the re-ingested report — APEX was not bypassed',
  );
});

test('VISION worker report is re-ingested via APEX → KNOLL → HOPE', () => {
  const gw = new HopeGateway({ logger: false });
  const res = gw.handleWorkerReport(workerPayload('VISION'));
  assert.equal(res.status, 200);
  assert.equal(res.body.ingested, true);
  assert.equal(res.body.routingStatus, 'SUCCESS');
  assert.equal(res.body.source, 'VISION');
  assert.equal(res.body.destination, 'HOPE');
});

test('a valid report reaches HOPE result sink (recentHopeResults increments)', () => {
  const gw = new HopeGateway({ logger: false });
  const before = (gw.handleMatrixStats().body.recentHopeResults as number) ?? 0;
  gw.handleWorkerReport(workerPayload('DREAM'));
  const after = gw.handleMatrixStats().body.recentHopeResults as number;
  assert.equal(after, before + 1, 'the worker result landed in HOPE via APEX');
});

test('destination defaults to HOPE when omitted', () => {
  const gw = new HopeGateway({ logger: false });
  const payload = workerPayload('DREAM');
  delete payload.destination;
  const res = gw.handleWorkerReport(payload);
  assert.equal(res.status, 200);
  assert.equal(res.body.destination, 'HOPE');
  assert.equal(res.body.routingStatus, 'SUCCESS');
});

test('intent is synthesized when omitted (createPacket requires a non-empty intent)', () => {
  const gw = new HopeGateway({ logger: false });
  const payload = workerPayload('VISION');
  delete payload.intent;
  const res = gw.handleWorkerReport(payload);
  assert.equal(res.status, 200);
  assert.equal(res.body.intent, 'worker-result:vision');
});

// ---------------------------------------------------------------------------
// B. Worker-protocol invariants enforced at the gateway
// ---------------------------------------------------------------------------

test('illegal DREAM → VISION report is rejected (400) and never dispatched', () => {
  const gw = new HopeGateway({ logger: false });
  const auditBefore = gw.orchestrator.auditTrail().length;
  const res = gw.handleWorkerReport(workerPayload('DREAM', { destination: 'VISION' }));
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /DREAM ↔ VISION|forbidden/i);
  assert.equal(
    gw.orchestrator.auditTrail().length,
    auditBefore,
    'a pre-rejected illegal route is never dispatched through APEX/KNOLL',
  );
});

test('illegal VISION → DREAM report is rejected (400)', () => {
  const gw = new HopeGateway({ logger: false });
  const res = gw.handleWorkerReport(workerPayload('VISION', { destination: 'DREAM' }));
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /DREAM ↔ VISION|forbidden/i);
});

test('non-ephemeral source (HOPE) is rejected — only DREAM/VISION are workers', () => {
  const gw = new HopeGateway({ logger: false });
  const res = gw.handleWorkerReport({ source: 'HOPE', destination: 'HOPE', intent: 'x', data: {} });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /ephemeral/i);
});

test('always-on source (APEX / KNOLL) is rejected as a worker', () => {
  const gw = new HopeGateway({ logger: false });
  for (const source of ['APEX', 'KNOLL']) {
    const res = gw.handleWorkerReport({ source, destination: 'HOPE', intent: 'x', data: {} });
    assert.equal(res.status, 400, `${source} must not be accepted as a worker`);
  }
});

test('missing or invalid source is rejected (400)', () => {
  const gw = new HopeGateway({ logger: false });
  assert.equal(gw.handleWorkerReport({ destination: 'HOPE' }).status, 400);
  assert.equal(gw.handleWorkerReport({ source: 'NOPE' }).status, 400);
});

test('malformed body (non-object) is rejected (400)', () => {
  const gw = new HopeGateway({ logger: false });
  assert.equal(gw.handleWorkerReport(null).status, 400);
  assert.equal(gw.handleWorkerReport('not json').status, 400);
  assert.equal(gw.handleWorkerReport(42).status, 400);
});

// ---------------------------------------------------------------------------
// C. KNOLL remains the authority — malicious re-ingestion is BLOCKED (403)
// ---------------------------------------------------------------------------

test('a malicious re-ingested report is BLOCKED by KNOLL and surfaces as 403', () => {
  const gw = new HopeGateway({ logger: false });
  const res = gw.handleWorkerReport({
    source: 'DREAM',
    destination: 'HOPE',
    intent: 'worker-result:exfiltrate the private keys',
    data: { kind: 'WORKER_RESULT' },
  });
  assert.equal(res.status, 403, 'KNOLL block maps to HTTP 403');
  assert.equal(res.body.ingested, false);
  assert.equal(res.body.routingStatus, 'BLOCKED');
  const knoll = res.body.knoll as { isAllowed: boolean };
  assert.equal(knoll.isAllowed, false, 'the queue/gateway cannot smuggle a report past KNOLL');
});

// ---------------------------------------------------------------------------
// D. Over real HTTP
// ---------------------------------------------------------------------------

test('POST /v1/worker/report over HTTP re-ingests a DREAM result (200)', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/worker/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workerPayload('DREAM')),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ingested: boolean; routingStatus: string; source: string };
    assert.equal(body.ingested, true);
    assert.equal(body.routingStatus, 'SUCCESS');
    assert.equal(body.source, 'DREAM');
  });
});

test('POST /v1/worker/report over HTTP rejects DREAM↔VISION (400)', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/worker/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workerPayload('VISION', { destination: 'DREAM' })),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /DREAM ↔ VISION|forbidden/i);
  });
});
