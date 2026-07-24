/**
 * tests/knoll_freeze.test.ts — KNOLL as an independent ACTIVE router (34% enforcement).
 *
 * Covers the active-router upgrade:
 *   A. 34% deny threshold (scoring.ts) + Shannon-entropy spike contributing to crossing it.
 *   B. SystemFreezeController (freeze.ts): freeze flag, isolated quarantine, Holloway/Prime
 *      override (legacy shape token + sovereign signed token via holloway_bridge).
 *   C. Knoll.intercept trips freeze + quarantine when a packet scores >= 0.34.
 *   D. ApexRouter.dispatch refuses new business routes while frozen (SYSTEM_FREEZE), except the
 *      Holloway/Prime override path; the freeze check sits AFTER the structural guard.
 *   E. KnollActiveRouter health-samples HOPE/VISION/DREAM/APEX surfaces and emits to the audit.
 *
 * Run: node --import tsx --test tests/knoll_freeze.test.ts   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentRole } from '../config/routing_schema.js';
import { ApexRouter, InMemoryLedger, createPacket } from '../apex/index.js';
import {
  Knoll,
  SecurityAuditLog,
  BehavioralScorer,
  SystemFreezeController,
  defaultIsHollowayToken,
  KnollActiveRouter,
} from '../knoll/index.js';

const HOLLOWAY_TOKEN = 'holloway_prime0verride12345';
const HIGH_ENTROPY =
  'aB9xQ2mZp7vLwR4tYbN8cJ3sdHfGaXeUoIiPq1zK5nMvW6rTyUcEoDlSgHjFkAqZxCvBnMwErTyUiOpAsDfGhJkLzXcVbNm';

/** APEX -> VISION CRITICAL packet whose HIGH-ENTROPY blob pushes the anomaly score over 34%. */
function entropySpikePacket() {
  return createPacket({
    source: AgentRole.APEX,
    destination: AgentRole.VISION,
    priority: 'CRITICAL',
    intent: 'stream telemetry ' + HIGH_ENTROPY,
    data: { blob: HIGH_ENTROPY.repeat(4) },
  });
}

// ---------------------------------------------------------------------------
// A. 34% threshold + entropy spike
// ---------------------------------------------------------------------------

test('behavioral deny threshold defaults to 0.34 (34%)', () => {
  const scorer = new BehavioralScorer();
  assert.equal(scorer.score(entropySpikePacket()).threshold, 0.34);
});

test('a Shannon-entropy spike can contribute to crossing the 34% threshold', () => {
  const scorer = new BehavioralScorer();

  // High-entropy blob on a risky endpoint crosses 34% and is anomalous.
  const hi = scorer.score(entropySpikePacket());
  assert.ok(hi.score >= 0.34, `high-entropy score ${hi.score} should reach 0.34`);
  assert.equal(hi.isAnomalous, true);
  assert.ok(hi.contributions.intentEntropy > 0, 'entropy contributes to the score');

  // Same shape but a LOW-entropy (repetitive) blob stays UNDER the threshold — proving the
  // entropy spike is the deciding contributor here.
  const lo = new BehavioralScorer().score(
    createPacket({
      source: AgentRole.APEX,
      destination: AgentRole.VISION,
      priority: 'CRITICAL',
      intent: 'stream telemetry now',
      data: { blob: 'a'.repeat(HIGH_ENTROPY.length * 4) },
    }),
  );
  assert.equal(lo.isAnomalous, false, 'low-entropy variant must stay below 0.34');
  assert.ok(hi.contributions.intentEntropy > lo.contributions.intentEntropy, 'entropy is the driver');
});

// ---------------------------------------------------------------------------
// B. SystemFreezeController
// ---------------------------------------------------------------------------

test('SystemFreezeController: triggerFreeze raises an absolute freeze flag', () => {
  const freeze = new SystemFreezeController({ now: () => 1000 });
  assert.equal(freeze.isFrozen(), false);
  const state = freeze.triggerFreeze('anomaly 0.4 >= 0.34', 0.4, 'pkt_1');
  assert.equal(freeze.isFrozen(), true);
  assert.equal(state.frozen, true);
  assert.equal(state.reason, 'anomaly 0.4 >= 0.34');
  assert.equal(state.score, 0.4);
  assert.equal(state.packetId, 'pkt_1');
  assert.equal(state.frozenAt, 1000);
});

test('SystemFreezeController: freeze is idempotent — the first cause wins', () => {
  const freeze = new SystemFreezeController();
  freeze.triggerFreeze('first cause', 0.5, 'pkt_first');
  freeze.triggerFreeze('second cause', 0.9, 'pkt_second');
  const state = freeze.state();
  assert.equal(state.reason, 'first cause', 'the original freeze cause is preserved');
  assert.equal(state.packetId, 'pkt_first');
});

test('SystemFreezeController: quarantine stores an ISOLATED (deep) copy', () => {
  const freeze = new SystemFreezeController({ now: () => 42 });
  const packet = entropySpikePacket();
  const record = freeze.quarantinePacket(packet, { reason: 'r', score: 0.4 });

  assert.equal(record.packetId, packet.header.packetId);
  assert.equal(record.quarantinedAt, 42);
  assert.notEqual(record.packet, packet, 'quarantine holds a detached copy, not the live packet');

  // Mutating the live packet must NOT alter the quarantined copy.
  (packet.payload.data as Record<string, unknown>).blob = 'MUTATED';
  assert.notEqual(record.packet.payload.data.blob, 'MUTATED');
  assert.equal(freeze.quarantined().length, 1);
});

test('SystemFreezeController: only a Holloway/Prime override token can unfreeze', () => {
  const freeze = new SystemFreezeController();
  freeze.triggerFreeze('anomaly', 0.4, 'pkt_1');

  assert.equal(freeze.unfreeze('not-a-token'), false, 'a bad token must not lift the freeze');
  assert.equal(freeze.isFrozen(), true);

  assert.equal(freeze.unfreeze(HOLLOWAY_TOKEN), true, 'a valid Holloway/Prime token lifts the freeze');
  assert.equal(freeze.isFrozen(), false);

  // The override token recognizer (stub seam) accepts holloway_/prime_ shapes only.
  assert.equal(defaultIsHollowayToken(HOLLOWAY_TOKEN), true);
  assert.equal(defaultIsHollowayToken('prime_abcd1234'), true);
  assert.equal(defaultIsHollowayToken('knoll_deadbeef'), false);
  assert.equal(defaultIsHollowayToken(''), false);
});

// ---------------------------------------------------------------------------
// C. Knoll.intercept trips freeze + quarantine at >= 0.34
// ---------------------------------------------------------------------------

test('Knoll.intercept denies a >= 0.34 packet AND trips freeze + quarantine', () => {
  const knoll = new Knoll();
  assert.equal(knoll.freeze.isFrozen(), false);

  const verdict = knoll.intercept(entropySpikePacket());
  assert.equal(verdict.isAllowed, false);
  assert.deepEqual(verdict.enforcedConstraints, ['BEHAVIORAL_SCORE']);

  // The active-router side effect: system frozen + offending packet quarantined.
  assert.equal(knoll.freeze.isFrozen(), true);
  assert.equal(knoll.freeze.quarantined().length, 1);
  assert.ok((knoll.freeze.state().score ?? 0) >= 0.34);
});

test('Knoll.intercept leaves benign traffic un-frozen', () => {
  const knoll = new Knoll();
  const verdict = knoll.intercept(
    createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'simulate the plan' }),
  );
  assert.equal(verdict.isAllowed, true);
  assert.equal(knoll.freeze.isFrozen(), false);
  assert.equal(knoll.freeze.quarantined().length, 0);
});

// ---------------------------------------------------------------------------
// D. ApexRouter refuses routes while frozen (except the Holloway/Prime override)
// ---------------------------------------------------------------------------

test('ApexRouter.dispatch refuses new business routes while KNOLL is frozen', () => {
  const knoll = new Knoll();
  const router = new ApexRouter({ knoll, ledger: new InMemoryLedger(), defaultCostUsd: 0 });
  let delivered = 0;
  router.register(AgentRole.DREAM, () => {
    delivered += 1;
    return { ok: true };
  });
  router.register(AgentRole.VISION, () => ({ ok: true }));

  // Trip the freeze by routing the entropy-spike packet (denied by the behavioral gate).
  const anomalous = router.dispatch(entropySpikePacket());
  assert.equal(anomalous.status, 'BLOCKED');
  assert.equal(knoll.freeze.isFrozen(), true);

  // A subsequent, perfectly-legal business route is now refused with SYSTEM_FREEZE.
  const benign = createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'simulate the plan' });
  const blocked = router.dispatch(benign);
  assert.equal(blocked.status, 'BLOCKED');
  assert.deepEqual(blocked.knoll.enforcedConstraints, ['SYSTEM_FREEZE']);
  assert.equal(delivered, 0, 'no handler runs while frozen');
});

test('ApexRouter allows the Holloway/Prime override path while frozen, then normal routing resumes after unfreeze', () => {
  const knoll = new Knoll();
  const router = new ApexRouter({ knoll });
  let delivered = 0;
  router.register(AgentRole.DREAM, () => {
    delivered += 1;
    return { ok: true };
  });

  knoll.freeze.triggerFreeze('manual freeze for test', 0.5, 'pkt_x');
  const benign = () =>
    createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'simulate the plan' });

  // Without an override → refused.
  assert.equal(router.dispatch(benign()).status, 'BLOCKED');
  // With a valid Holloway/Prime override token → the route proceeds even while frozen.
  const overridden = router.dispatch(benign(), undefined, HOLLOWAY_TOKEN);
  assert.equal(overridden.status, 'SUCCESS');
  assert.equal(delivered, 1);

  // After a Holloway/Prime unfreeze, ordinary routing resumes with no token needed.
  assert.equal(knoll.freeze.unfreeze(HOLLOWAY_TOKEN), true);
  assert.equal(router.dispatch(benign()).status, 'SUCCESS');
  assert.equal(delivered, 2);
});

test('the freeze check sits AFTER the structural guard (a non-packet is STRUCTURE, not SYSTEM_FREEZE)', () => {
  const knoll = new Knoll();
  const router = new ApexRouter({ knoll });
  knoll.freeze.triggerFreeze('frozen', 0.5, 'pkt_x');
  // A malformed value is refused by the structural guard first, never reaching the freeze gate.
  const result = router.dispatch({ not: 'a packet' } as never);
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.knoll.enforcedConstraints, ['STRUCTURE']);
});

// ---------------------------------------------------------------------------
// E. KnollActiveRouter — active health probing
// ---------------------------------------------------------------------------

test('KnollActiveRouter samples HOPE/VISION/DREAM/APEX surfaces and emits health to the audit', () => {
  const audit = new SecurityAuditLog();
  let ticks = 0;
  const active = new KnollActiveRouter(audit, { now: () => 7, monotonic: () => (ticks += 1) });

  active.registerProbe(AgentRole.HOPE, () => ({ status: 'healthy', detail: 'ok' }));
  active.registerProbe(AgentRole.VISION, () => ({ status: 'degraded', detail: 'slow sandbox' }));
  active.registerProbe(AgentRole.DREAM, () => undefined); // bare return == healthy
  active.registerProbe(AgentRole.APEX, () => ({ status: 'healthy' }));

  const samples = active.sampleAll();
  assert.deepEqual(
    samples.map((s) => s.role),
    [AgentRole.HOPE, AgentRole.VISION, AgentRole.DREAM, AgentRole.APEX],
  );
  assert.equal(active.latest(AgentRole.VISION)?.status, 'degraded');
  assert.equal(active.latest(AgentRole.DREAM)?.status, 'healthy');
  assert.ok(samples.every((s) => s.timestamp === 7 && s.latencyMs >= 0));

  // Every reading is emitted to the shared audit trail as a KNOLL_HEALTH_PROBE observation.
  const probeEntries = audit.all().filter((e) => (e.reasoning ?? '').startsWith('KNOLL_HEALTH_PROBE'));
  assert.equal(probeEntries.length, 4);
  assert.ok(probeEntries.every((e) => e.outcome === 'ALLOWED'), 'probes never pollute the BLOCKED stream');
});

test('KnollActiveRouter reports unreachable surfaces (missing or throwing probe) without breaking', () => {
  const audit = new SecurityAuditLog();
  const active = new KnollActiveRouter(audit);

  // No probe registered for HOPE → unreachable.
  assert.equal(active.sample(AgentRole.HOPE).status, 'unreachable');

  // A throwing probe is caught and reported as unreachable, not propagated.
  active.registerProbe(AgentRole.VISION, () => {
    throw new Error('boom');
  });
  const s = active.sample(AgentRole.VISION);
  assert.equal(s.status, 'unreachable');
  assert.equal(s.detail, 'boom');
});
