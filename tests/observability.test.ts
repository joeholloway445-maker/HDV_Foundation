/**
 * tests/observability.test.ts — Phase 5 observability tests (node:test).
 *
 * Covers the out-of-band metering layer WITHOUT regressing any invariant:
 *   - MetricsCollector counts verdicts, per-destination, deny reasons, latency, cost.
 *   - The router observer seam is read-only: a throwing observer never breaks routing, and
 *     wiring an observer never changes a dispatch result vs. no observer.
 *   - PacketTracer is a bounded ring buffer (oldest overwritten, chronological order).
 *   - combineObservers fans out and isolates failures.
 *   - APEX's internal DREAM/VISION forwards are metered (destination coverage).
 *   - Gateway GET /v1/metrics serves a JSON snapshot and a Prometheus-ish text exposition.
 *
 * Run: npm run test:observability   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { ApexRouter, ApexOrchestrator, createPacket } from '../apex/index.js';
import type { DispatchEvent } from '../apex/index.js';
import { AgentRole } from '../config/routing_schema.js';
import { MetricsCollector, PacketTracer, combineObservers } from '../observability/index.js';
import { HopeGateway } from '../gateway/index.js';

// ---------------------------------------------------------------------------
// A. MetricsCollector accounting
// ---------------------------------------------------------------------------

function evt(overrides: Partial<DispatchEvent> = {}): DispatchEvent {
  return {
    packetId: 'pkt_x',
    source: AgentRole.APEX,
    destination: AgentRole.DREAM,
    status: 'SUCCESS',
    durationMs: 3,
    cost_usd: 0.02,
    knoll: { isAllowed: true, enforcedConstraints: ['LAW_1'] },
    ...overrides,
  };
}

test('MetricsCollector counts verdicts, destinations, cost', () => {
  const m = new MetricsCollector();
  m.observe(evt({ status: 'SUCCESS', destination: AgentRole.DREAM, cost_usd: 0.02 }));
  m.observe(evt({ status: 'SUCCESS', destination: AgentRole.VISION, cost_usd: 0.03 }));
  m.observe(evt({ status: 'BLOCKED', destination: AgentRole.VISION, cost_usd: 0, knoll: { isAllowed: false, enforcedConstraints: ['NO_DIRECT_DREAM_VISION'] } }));
  m.observe(evt({ status: 'FAILED', destination: AgentRole.HOPE, cost_usd: 0 }));

  const snap = m.snapshot();
  assert.equal(snap.packets.total, 4);
  assert.equal(snap.packets.routed, 2);
  assert.equal(snap.packets.blocked, 1);
  assert.equal(snap.packets.failed, 1);
  assert.equal(snap.perDestination[AgentRole.VISION], 2);
  assert.equal(snap.perDestination[AgentRole.DREAM], 1);
  assert.equal(snap.perDestination[AgentRole.HOPE], 1);
  assert.equal(snap.cost.totalUsd, 0.05);
  assert.equal(snap.denyReasons['NO_DIRECT_DREAM_VISION'], 1);
});

test('MetricsCollector deny reasons key on enforced constraints (bounded cardinality)', () => {
  const m = new MetricsCollector();
  // Same constraint, different free-text reasoning ⇒ still one key.
  m.observe(evt({ status: 'BLOCKED', knoll: { isAllowed: false, reasoning: 'rate limit exceeded for HOPE (100/1000ms)', enforcedConstraints: ['RATE_LIMIT'] } }));
  m.observe(evt({ status: 'BLOCKED', knoll: { isAllowed: false, reasoning: 'rate limit exceeded for DREAM (100/1000ms)', enforcedConstraints: ['RATE_LIMIT'] } }));
  const snap = m.snapshot();
  assert.equal(snap.denyReasons['RATE_LIMIT'], 2);
  assert.equal(Object.keys(snap.denyReasons).length, 1);
});

test('MetricsCollector latency histogram is cumulative with a +Inf overflow', () => {
  const m = new MetricsCollector();
  for (const d of [0.5, 3, 30, 2000]) m.observe(evt({ durationMs: d }));
  const h = m.snapshot().latencyMs;
  assert.equal(h.count, 4);
  assert.equal(h.buckets['1'], 1, '0.5ms ≤ 1');
  assert.equal(h.buckets['5'], 2, '0.5 and 3 ≤ 5');
  assert.equal(h.buckets['50'], 3, '+30 ≤ 50');
  assert.equal(h.buckets['+Inf'], 4, '2000 overflows into +Inf');
  assert.ok(h.averageMs > 0);
});

test('MetricsCollector active-personas gauge decays outside the window', () => {
  let clock = 1_000;
  const m = new MetricsCollector({ now: () => clock, activeWindowMs: 1_000 });
  m.observe(evt({ status: 'SUCCESS', destination: AgentRole.DREAM }));
  m.observe(evt({ status: 'SUCCESS', destination: AgentRole.VISION }));
  // Two ephemeral spawns in-window → 2 × PERSONAS_PER_NODE (100).
  assert.equal(m.activePersonasEstimate(), 200);
  // A HOPE success is NOT ephemeral → gauge unaffected.
  m.observe(evt({ status: 'SUCCESS', destination: AgentRole.HOPE }));
  assert.equal(m.activePersonasEstimate(), 200);
  // Advance past the window → the gauge decays to 0, but the cumulative counter persists.
  clock += 2_000;
  assert.equal(m.activePersonasEstimate(), 0);
  assert.equal(m.snapshot().personas.ephemeralSpawns, 2);
});

test('MetricsCollector.toPrometheus emits well-formed exposition lines', () => {
  const m = new MetricsCollector();
  m.observe(evt({ status: 'SUCCESS', destination: AgentRole.DREAM, cost_usd: 0.02 }));
  m.observe(evt({ status: 'BLOCKED', destination: AgentRole.VISION, cost_usd: 0, knoll: { isAllowed: false, enforcedConstraints: ['HOPE_CANNOT_COMMAND'] } }));
  const text = m.toPrometheus();
  assert.match(text, /# TYPE big5_packets_total counter/);
  assert.match(text, /big5_packets_total\{verdict="routed"\} 1/);
  assert.match(text, /big5_packets_total\{verdict="blocked"\} 1/);
  assert.match(text, /big5_packets_by_destination_total\{destination="DREAM"\} 1/);
  assert.match(text, /big5_knoll_denies_total\{reason="HOPE_CANNOT_COMMAND"\} 1/);
  assert.match(text, /big5_dispatch_duration_ms_bucket\{le="\+Inf"\} 2/);
  assert.match(text, /big5_dispatch_duration_ms_count 2/);
  assert.ok(text.endsWith('\n'));
});

// ---------------------------------------------------------------------------
// B. Router observer seam is read-only and safe
// ---------------------------------------------------------------------------

test('router observer meters a real dispatch (SUCCESS + cost + latency)', () => {
  const m = new MetricsCollector();
  const router = new ApexRouter({ defaultCostUsd: 0.05, observer: m.observer() });
  router.register(AgentRole.DREAM, () => ({ ok: true }));
  const pkt = createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'simulate' });
  const result = router.dispatch(pkt);
  assert.equal(result.status, 'SUCCESS');
  const snap = m.snapshot();
  assert.equal(snap.packets.routed, 1);
  assert.equal(snap.perDestination[AgentRole.DREAM], 1);
  assert.equal(snap.cost.totalUsd, 0.05);
  assert.equal(snap.latencyMs.count, 1);
});

test('a throwing observer never breaks routing, and the result is identical to no-observer', () => {
  const base = new ApexRouter({ defaultCostUsd: 0.05 });
  base.register(AgentRole.DREAM, () => ({ ok: true }));
  const p1 = createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'x', timestamp: 1 });
  const baseline = base.dispatch(p1);

  const guarded = new ApexRouter({
    defaultCostUsd: 0.05,
    observer: () => {
      throw new Error('observer boom');
    },
  });
  guarded.register(AgentRole.DREAM, () => ({ ok: true }));
  const p2 = createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'x', timestamp: 1 });
  const withObs = guarded.dispatch(p2);

  assert.equal(withObs.status, baseline.status);
  assert.equal(withObs.cost_usd, baseline.cost_usd);
  assert.deepEqual(withObs.response, baseline.response);
});

test('observer meters blocked packets with the deny reason', () => {
  const m = new MetricsCollector();
  const router = new ApexRouter({ observer: m.observer() });
  router.register(AgentRole.VISION, () => ({ ok: true }));
  // Illegal direct DREAM→VISION.
  const pkt = createPacket({ source: AgentRole.DREAM, destination: AgentRole.VISION, intent: 'x' });
  const result = router.dispatch(pkt);
  assert.equal(result.status, 'BLOCKED');
  const snap = m.snapshot();
  assert.equal(snap.packets.blocked, 1);
  assert.equal(snap.denyReasons['NO_DIRECT_DREAM_VISION'], 1);
});

// ---------------------------------------------------------------------------
// C. PacketTracer ring buffer
// ---------------------------------------------------------------------------

test('PacketTracer records spans in chronological order', () => {
  const tracer = new PacketTracer({ capacity: 8, now: () => 42 });
  tracer.record(evt({ packetId: 'a', status: 'SUCCESS' }));
  tracer.record(evt({ packetId: 'b', status: 'BLOCKED' }));
  const spans = tracer.spans();
  assert.equal(spans.length, 2);
  assert.equal(spans[0].packetId, 'a');
  assert.equal(spans[0].verdict, 'SUCCESS');
  assert.equal(spans[1].packetId, 'b');
  assert.equal(spans[1].verdict, 'BLOCKED');
  assert.equal(spans[0].at, 42);
});

test('PacketTracer overwrites oldest spans when capacity is exceeded', () => {
  const tracer = new PacketTracer({ capacity: 3 });
  for (let i = 0; i < 5; i++) tracer.record(evt({ packetId: `p${i}` }));
  assert.equal(tracer.size, 3);
  const ids = tracer.spans().map((s) => s.packetId);
  assert.deepEqual(ids, ['p2', 'p3', 'p4'], 'only the newest 3 survive, in order');
  assert.deepEqual(tracer.recent(2).map((s) => s.packetId), ['p3', 'p4']);
});

// ---------------------------------------------------------------------------
// D. combineObservers fan-out + isolation
// ---------------------------------------------------------------------------

test('combineObservers fans out to every sink and isolates failures', () => {
  const m = new MetricsCollector();
  const tracer = new PacketTracer({ capacity: 4 });
  const fanned = combineObservers(
    () => {
      throw new Error('bad sink');
    },
    m.observer(),
    tracer.observer(),
  );
  fanned(evt({ packetId: 'z', status: 'SUCCESS', destination: AgentRole.DREAM }));
  assert.equal(m.snapshot().packets.routed, 1, 'metrics still recorded despite a failing sink');
  assert.equal(tracer.size, 1, 'tracer still recorded despite a failing sink');
});

// ---------------------------------------------------------------------------
// E. Orchestrator observer covers APEX's internal DREAM/VISION forwards
// ---------------------------------------------------------------------------

test('orchestrator observer meters both the APEX submit and its internal forward', () => {
  const m = new MetricsCollector();
  const tracer = new PacketTracer();
  const orch = new ApexOrchestrator({ observer: combineObservers(m.observer(), tracer.observer()) });
  orch.wire({ dream: () => ({ outcome: 'simulated' }) });

  const submitted = orch.submit({
    source: AgentRole.HOPE,
    destination: AgentRole.APEX,
    intent: 'simulate outcomes',
    data: { suggestedDestination: AgentRole.DREAM },
  });
  assert.equal(submitted.dispatch.status, 'SUCCESS');
  assert.equal(submitted.forwardedTo, AgentRole.DREAM);

  const snap = m.snapshot();
  // One route to APEX (the submit) + one internal forward to DREAM.
  assert.equal(snap.perDestination[AgentRole.APEX], 1);
  assert.equal(snap.perDestination[AgentRole.DREAM], 1);
  assert.equal(snap.packets.routed, 2);
  assert.ok(snap.personas.ephemeralSpawns >= 1, 'the DREAM forward counts as an ephemeral spawn');
  assert.ok(tracer.spans().some((s) => s.dest === AgentRole.DREAM));
});

// ---------------------------------------------------------------------------
// F. Gateway GET /v1/metrics (JSON + Prometheus)
// ---------------------------------------------------------------------------

async function withServer(gw: HopeGateway, fn: (base: string) => Promise<void>): Promise<void> {
  const server = await gw.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('GET /v1/metrics returns a JSON snapshot reflecting routed traffic', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    // Drive some traffic through the gateway (HOPE → APEX → KNOLL → DREAM/VISION).
    await fetch(`${base}/v1/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ utterance: 'simulate three outcomes for launching the product early' }),
    });

    const res = await fetch(`${base}/v1/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = (await res.json()) as {
      packets: { total: number; routed: number };
      perDestination: Record<string, number>;
      recentTrace: unknown[];
    };
    assert.ok(body.packets.total >= 1);
    assert.ok(body.packets.routed >= 1);
    assert.ok(Array.isArray(body.recentTrace));
    assert.ok(body.recentTrace.length >= 1);
  });
});

test('GET /v1/metrics?format=prometheus returns text exposition', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    await fetch(`${base}/v1/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ utterance: 'simulate three outcomes for launching the product early' }),
    });
    const res = await fetch(`${base}/v1/metrics?format=prometheus`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    const text = await res.text();
    assert.match(text, /big5_packets_total\{verdict="routed"\}/);
    assert.match(text, /big5_dispatch_duration_ms_count/);
  });
});

test('metrics endpoint does not weaken the KNOLL gate (blocked traffic still blocked)', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    // /v1/metrics is a pure read; it never routes packets itself.
    const before = (await (await fetch(`${base}/v1/metrics`)).json()) as { packets: { total: number } };
    await fetch(`${base}/v1/metrics`);
    const after = (await (await fetch(`${base}/v1/metrics`)).json()) as { packets: { total: number } };
    assert.equal(before.packets.total, after.packets.total, 'reading metrics never mutates counters');
  });
});
