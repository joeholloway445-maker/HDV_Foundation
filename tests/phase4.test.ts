/**
 * tests/phase4.test.ts — Phase 4 tests.
 *
 * Covers the new Phase 4 surface WITHOUT regressing any Phase 1–3 invariant:
 *   - Kafka-like task queue: publish / subscribe / ack / nack, partition by AgentRole,
 *     consumer-group fan-out, replay.
 *   - ApexOrchestrator async intake drains through the SAME KNOLL-gated dispatch path.
 *   - Parameter accounting math equals ~1.4336e16 (14.3 quadrillion).
 *   - HOPE HTTP gateway: intent/health/ledger/audit/matrix handlers (no port) + a bound
 *     ephemeral port; the gateway never bypasses APEX/KNOLL.
 *   - Colab worker-protocol manifest validation (Python twin, via child process).
 *   - DREAM ↔ VISION direct traffic is STILL blocked (invariant).
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { AgentRole } from '../config/routing_schema.js';
import { ApexOrchestrator, createPacket, type DispatchResult } from '../apex/index.js';
import { Knoll } from '../knoll/index.js';
import { InMemoryKafkaStub, type DeliveredMessage } from '../persistence/index.js';
import {
  computeParameterAccounting,
  computeActiveParameters,
  humanizeParameters,
  TOTAL_PERSONAS,
  PARAMETERS_PER_AGENT,
} from '../nodes/index.js';
import { HopeGateway } from '../gateway/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function dreamPacket(intent = 'simulate the plan') {
  return createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent });
}
function visionPacket(intent = 'run the tool') {
  return createPacket({ source: AgentRole.APEX, destination: AgentRole.VISION, intent });
}

// ---------------------------------------------------------------------------
// A. Task queue — Kafka-like partitioned queue with consumer groups
// ---------------------------------------------------------------------------

test('task queue publishes, delivers to a subscriber, and acks', () => {
  const q = new InMemoryKafkaStub();
  const received: DeliveredMessage[] = [];
  q.subscribe('g1', (m) => received.push(m), { partitions: [AgentRole.DREAM] });

  const published = q.publish(dreamPacket());
  assert.equal(published.partition, AgentRole.DREAM);
  assert.equal(received.length, 1, 'subscriber receives the published message');
  assert.equal(q.inFlight('g1'), 1, 'delivered-but-unacked message is in-flight');
  assert.equal(q.ack('g1', received[0].messageId), true);
  assert.equal(q.inFlight('g1'), 0, 'ack clears in-flight');
});

test('task queue partitions by destination AgentRole', () => {
  const q = new InMemoryKafkaStub();
  const dreamMsgs: DeliveredMessage[] = [];
  const visionMsgs: DeliveredMessage[] = [];
  q.subscribe('dream-workers', (m) => dreamMsgs.push(m), { partitions: [AgentRole.DREAM] });
  q.subscribe('vision-workers', (m) => visionMsgs.push(m), { partitions: [AgentRole.VISION] });

  q.publish(dreamPacket());
  q.publish(visionPacket());
  q.publish(dreamPacket('another sim'));

  assert.equal(dreamMsgs.length, 2, 'DREAM partition only sees DREAM-destined packets');
  assert.equal(visionMsgs.length, 1, 'VISION partition only sees VISION-destined packets');
  assert.ok(dreamMsgs.every((m) => m.partition === AgentRole.DREAM));
  assert.equal(q.highWaterMark(AgentRole.DREAM), 2);
  assert.equal(q.highWaterMark(AgentRole.VISION), 1);
});

test('task queue fans out to independent consumer groups', () => {
  const q = new InMemoryKafkaStub();
  const a: DeliveredMessage[] = [];
  const b: DeliveredMessage[] = [];
  q.subscribe('group-a', (m) => a.push(m), { partitions: [AgentRole.DREAM] });
  q.subscribe('group-b', (m) => b.push(m), { partitions: [AgentRole.DREAM] });

  q.publish(dreamPacket());
  // Each group gets its OWN copy of the stream (Kafka consumer-group semantics).
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(q.inFlight(), 2, 'one in-flight message per group');
});

test('task queue nack redelivers with an incremented delivery count', () => {
  const q = new InMemoryKafkaStub();
  const received: DeliveredMessage[] = [];
  q.subscribe('g', (m) => received.push(m), { partitions: [AgentRole.DREAM] });
  q.publish(dreamPacket());
  assert.equal(received[0].deliveryCount, 1);
  assert.equal(q.nack('g', received[0].messageId), true);
  assert.equal(received.length, 2, 'nack redelivers');
  assert.equal(received[1].deliveryCount, 2, 'redelivery increments the count');
});

test('task queue replays already-published messages to a late subscriber', () => {
  const q = new InMemoryKafkaStub();
  q.publish(dreamPacket('early-1'));
  q.publish(dreamPacket('early-2'));
  const received: DeliveredMessage[] = [];
  q.subscribe('late', (m) => received.push(m), { partitions: [AgentRole.DREAM], replayFromStart: true });
  assert.equal(received.length, 2, 'late subscriber replays the backlog from offset 0');
});

// ---------------------------------------------------------------------------
// B. ApexOrchestrator async intake — same KNOLL-gated dispatch path
// ---------------------------------------------------------------------------

test('ApexOrchestrator async intake drains through the KNOLL-gated dispatch path', () => {
  const queue = new InMemoryKafkaStub();
  const orch = new ApexOrchestrator({ defaultCostUsd: 0.02, queue });
  const dreamSeen: string[] = [];
  orch.wire({
    dream: (packet) => {
      dreamSeen.push(packet.payload.intent);
      return { ok: true };
    },
    hope: () => ({ acknowledged: true }),
  });

  const results: DispatchResult[] = [];
  orch.startQueueConsumer({ onResult: (r) => results.push(r) });

  // HOPE addresses APEX; the orchestrator forwards to DREAM (after KNOLL) via the payload.
  orch.intake({
    source: AgentRole.HOPE,
    destination: AgentRole.APEX,
    intent: 'simulate the launch',
    data: { kind: 'SIMULATE', suggestedDestination: AgentRole.DREAM },
  });

  assert.equal(results.length, 1, 'the intake was drained and dispatched');
  assert.equal(results[0].status, 'SUCCESS');
  assert.equal(dreamSeen.length, 1, 'DREAM handled the forwarded packet');
  assert.ok(orch.auditTrail().length >= 1, 'KNOLL audited the routed traffic');
});

test('intake and startQueueConsumer require a configured queue', () => {
  const orch = new ApexOrchestrator();
  assert.throws(() => orch.intake({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'x' }), /no queue/);
  assert.throws(() => orch.startQueueConsumer(), /no queue/);
});

// ---------------------------------------------------------------------------
// C. Parameter accounting — the 14.3 quadrillion math
// ---------------------------------------------------------------------------

test('parameter accounting equals ~1.4336e16 (14.3 quadrillion)', () => {
  const acc = computeParameterAccounting();
  assert.equal(acc.totalConceptualParameters, 14_336_000_000_000_000);
  assert.ok(Math.abs(acc.totalConceptualParameters - 1.4336e16) < 1, 'matches 1.4336e16');
  assert.equal(acc.totalPersonas, TOTAL_PERSONAS);
  assert.equal(acc.totalPersonas, 2_048_000);
});

test('per-agent parameter breakdown sums to the total and splits evenly', () => {
  const acc = computeParameterAccounting();
  assert.equal(acc.perAgent.length, 5);
  const sum = acc.perAgent.reduce((n, a) => n + a.parameters, 0);
  assert.equal(sum, acc.totalConceptualParameters);
  for (const a of acc.perAgent) {
    assert.equal(a.parameters, PARAMETERS_PER_AGENT);
    assert.ok(Math.abs(a.shareOfTotal - 0.2) < 1e-9, 'each Big AI is 20% of the fleet');
  }
  // Always-on vs ephemeral split matches the constitution.
  const alwaysOn = acc.perAgent.filter((a) => a.alwaysOn).map((a) => a.role);
  const ephemeral = acc.perAgent.filter((a) => a.ephemeral).map((a) => a.role);
  assert.deepEqual(new Set(alwaysOn), new Set([AgentRole.HOPE, AgentRole.KNOLL, AgentRole.APEX]));
  assert.deepEqual(new Set(ephemeral), new Set([AgentRole.DREAM, AgentRole.VISION]));
});

test('active parameters track live personas only (idle draws ~zero)', () => {
  const usage = computeActiveParameters({ activePersonas: 100 });
  assert.equal(usage.activeParameters, 100 * 7_000_000_000);
  assert.ok(usage.utilization > 0 && usage.utilization < 1);
  assert.equal(computeActiveParameters({ activePersonas: 0 }).activeParameters, 0);
  assert.match(humanizeParameters(1.4336e16), /quadrillion/);
});

// ---------------------------------------------------------------------------
// D. HOPE gateway handlers — testable without binding a port
// ---------------------------------------------------------------------------

test('gateway /v1/intent interprets, documents, and submits via APEX (KNOLL-gated)', async () => {
  const gw = new HopeGateway({ provider: false });
  const res = await gw.handleIntent({ utterance: 'simulate three outcomes for launching the product early' });
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, true);
  assert.equal(res.body.dispatched, true);
  assert.equal(res.body.routingStatus, 'SUCCESS');
  const knoll = res.body.knoll as { isAllowed: boolean } | null;
  assert.ok(knoll && knoll.isAllowed, 'KNOLL allowed the routed packet');
  assert.ok(typeof res.body.voice === 'string' && (res.body.voice as string).length > 0);
});

test('gateway /v1/intent rejects a missing utterance with 400', async () => {
  const gw = new HopeGateway({ provider: false });
  assert.equal((await gw.handleIntent({})).status, 400);
  assert.equal((await gw.handleIntent({ utterance: '   ' })).status, 400);
  assert.equal((await gw.handleIntent(null)).status, 400);
});

test('gateway /v1/intent holds a low-confidence utterance for clarification (no dispatch)', async () => {
  const gw = new HopeGateway({ provider: false });
  const res = await gw.handleIntent({ utterance: 'hmm' });
  assert.equal(res.status, 200);
  assert.equal(res.body.dispatched, false);
  assert.equal(res.body.clarificationNeeded, true);
});

test('gateway /v1/health reports always-on core + ephemeral idle flags', () => {
  const gw = new HopeGateway();
  const res = gw.handleHealth();
  const alwaysOn = res.body.alwaysOn as Array<{ role: string; status: string }>;
  const ephemeral = res.body.ephemeral as Array<{ role: string; idle: boolean }>;
  assert.deepEqual(new Set(alwaysOn.map((a) => a.role)), new Set(['HOPE', 'KNOLL', 'APEX']));
  assert.ok(alwaysOn.every((a) => a.status === 'online'));
  assert.deepEqual(new Set(ephemeral.map((e) => e.role)), new Set(['DREAM', 'VISION']));
  assert.ok(ephemeral.every((e) => e.idle === true));
});

test('gateway /v1/matrix/stats exposes topology + 14.3Q parameter accounting', () => {
  const gw = new HopeGateway();
  const res = gw.handleMatrixStats();
  const topology = res.body.topology as Record<string, number>;
  assert.equal(topology.totalNodes, 20480);
  assert.equal(topology.personasPerNode, 100);
  const params = res.body.parameters as { totalConceptual: number };
  assert.equal(params.totalConceptual, 14_336_000_000_000_000);
});

test('gateway /v1/ledger and /v1/audit are read-only projections that fill after routing', async () => {
  const gw = new HopeGateway({ provider: false });
  await gw.handleIntent({ utterance: 'simulate three outcomes for launching the product early' });
  const ledger = gw.handleLedger();
  const audit = gw.handleAudit();
  assert.ok((ledger.body.count as number) >= 1, 'ledger reflects routed traffic');
  assert.ok((ledger.body.totalBilled as number) > 0);
  assert.ok((audit.body.count as number) >= 1, 'audit reflects KNOLL verdicts');
});

test('gateway route() maps methods+paths and 404s the unknown', async () => {
  const gw = new HopeGateway();
  const q = new URLSearchParams();
  assert.equal((await gw.route('GET', '/v1/health', q, undefined)).status, 200);
  assert.equal((await gw.route('GET', '/v1/nope', q, undefined)).status, 404);
  assert.equal((await gw.route('DELETE', '/v1/intent', q, undefined)).status, 404);
});

// ---------------------------------------------------------------------------
// E. HOPE gateway bound to an ephemeral port (real HTTP)
// ---------------------------------------------------------------------------

test('gateway serves over HTTP on an ephemeral port', async () => {
  const gw = new HopeGateway();
  const server = await gw.listen(0);
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const intentRes = await fetch(`${base}/v1/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ utterance: 'simulate three outcomes for launching the product early' }),
    });
    assert.equal(intentRes.status, 200);
    const intentBody = (await intentRes.json()) as { dispatched: boolean; routingStatus: string };
    assert.equal(intentBody.dispatched, true);
    assert.equal(intentBody.routingStatus, 'SUCCESS');

    const healthRes = await fetch(`${base}/v1/health`);
    const healthBody = (await healthRes.json()) as { ok: boolean; knollGate: string };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.knollGate, 'enforced');

    const notFound = await fetch(`${base}/v1/nope`);
    assert.equal(notFound.status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// F. Colab worker-protocol manifest validation (Python twin, via child process)
// ---------------------------------------------------------------------------

test('colab worker protocol validates manifests (ephemeral roles only)', () => {
  const py = [
    'import sys, os',
    `sys.path.insert(0, os.path.join(${JSON.stringify(REPO_ROOT)}, 'colab'))`,
    `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
    'from worker_protocol import build_manifest, WorkerReport, WorkerProtocolError, NodeSlice, WorkerManifest',
    '',
    '# valid DREAM + VISION workers',
    'assert build_manifest("DREAM").is_valid()',
    'assert build_manifest("VISION", gpu_hint="A100").is_valid()',
    '',
    '# always-on roles must be rejected as workers',
    'for role in ("HOPE", "KNOLL", "APEX"):',
    '    try:',
    '        build_manifest(role)',
    '        raise SystemExit(f"{role} wrongly accepted as a worker")',
    '    except WorkerProtocolError:',
    '        pass',
    '',
    '# out-of-range node slice must be rejected',
    'try:',
    '    WorkerManifest(agent_role="DREAM", node_slice=NodeSlice(manager_start=99)).validate()',
    '    raise SystemExit("bad node slice wrongly accepted")',
    'except WorkerProtocolError:',
    '    pass',
    '',
    '# a DREAM worker reporting straight to VISION is illegal (DREAM<->VISION direct)',
    'try:',
    '    WorkerReport(manifest=build_manifest("DREAM"), persona_count=1, avg_score=0.5, top_scores=[0.5], active_parameters=7000000000, destination="VISION").to_apex_payload()',
    '    raise SystemExit("DREAM->VISION report wrongly accepted")',
    'except WorkerProtocolError:',
    '    pass',
    '',
    '# a valid report re-ingestion envelope targets HOPE via APEX',
    'p = WorkerReport(manifest=build_manifest("DREAM", task="sim"), persona_count=10, avg_score=0.5, top_scores=[0.9], active_parameters=70000000000, destination="HOPE").to_apex_payload()',
    'assert p["source"] == "DREAM" and p["destination"] == "HOPE", p',
    'assert p["data"]["personaCount"] == 10',
    'print("PY_WORKER_OK")',
  ].join('\n');

  const out = execFileSync('python3', ['-c', py], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.match(out, /PY_WORKER_OK/);
});

// ---------------------------------------------------------------------------
// G. Invariant — DREAM <-> VISION direct traffic is STILL blocked
// ---------------------------------------------------------------------------

test('DREAM <-> VISION direct traffic is still blocked (Phase 4 changes nothing)', () => {
  const knoll = new Knoll();
  assert.equal(
    knoll.intercept(createPacket({ source: AgentRole.DREAM, destination: AgentRole.VISION, intent: 'x' })).isAllowed,
    false,
  );
  assert.equal(
    knoll.intercept(createPacket({ source: AgentRole.VISION, destination: AgentRole.DREAM, intent: 'x' })).isAllowed,
    false,
  );

  // And through the queue+orchestrator path: a DREAM→VISION packet dispatched from the
  // consumer is still denied by KNOLL.
  const queue = new InMemoryKafkaStub();
  const orch = new ApexOrchestrator({ queue });
  let delivered = false;
  orch.wire({ vision: () => { delivered = true; } });
  const results: DispatchResult[] = [];
  // Consume the VISION partition directly to observe the dispatch verdict.
  queue.subscribe('vision-intake', (m) => {
    results.push(orch.router.dispatch(m.packet));
  }, { partitions: [AgentRole.VISION] });
  queue.publish(createPacket({ source: AgentRole.DREAM, destination: AgentRole.VISION, intent: 'sneak' }));
  assert.equal(results[0].status, 'BLOCKED');
  assert.equal(delivered, false, 'blocked packet never reaches the VISION handler');
});
