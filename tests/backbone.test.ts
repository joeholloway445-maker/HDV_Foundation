/**
 * tests/backbone.test.ts — automated backbone tests (node:test).
 *
 * Covers the non-negotiable security & accounting invariants:
 *   - KNOLL blocks an invalid / tampered hash.
 *   - KNOLL blocks a direct DREAM <-> VISION packet (both directions).
 *   - APEX won't route without a KNOLL allow (blocked packets never reach handlers).
 *   - The ledger records costs for successful ephemeral executions.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApexRouter, createPacket, InMemoryLedger, verifyPacketHash } from '../apex/index.js';
import { Knoll } from '../knoll/index.js';
import { AgentRole } from '../config/routing_schema.js';

function freshRouter(): { router: ApexRouter; knoll: Knoll; ledger: InMemoryLedger } {
  const knoll = new Knoll();
  const ledger = new InMemoryLedger();
  const router = new ApexRouter({ knoll, ledger, defaultCostUsd: 0.05 });
  return { router, knoll, ledger };
}

test('createPacket produces a valid, self-consistent SHA-256 hash', () => {
  const pkt = createPacket({
    source: AgentRole.HOPE,
    destination: AgentRole.APEX,
    intent: 'hello',
    data: { a: 1 },
  });
  assert.ok(verifyPacketHash(pkt), 'freshly created packet must have a valid hash');
});

test('KNOLL blocks a tampered hash', () => {
  const knoll = new Knoll();
  const pkt = createPacket({
    source: AgentRole.HOPE,
    destination: AgentRole.APEX,
    intent: 'legit',
  });
  // Tamper with the payload after hashing.
  (pkt.payload.data as Record<string, unknown>).evil = true;
  const verdict = knoll.intercept(pkt);
  assert.equal(verdict.isAllowed, false);
  assert.deepEqual(verdict.enforcedConstraints, ['HASH_INTEGRITY']);
  assert.equal(knoll.audit.blocked().length, 1, 'a SecurityAudit BLOCKED entry must exist');
});

test('KNOLL blocks a corrupted hash string', () => {
  const knoll = new Knoll();
  const pkt = createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'legit' });
  pkt.security.hash = 'deadbeef';
  const verdict = knoll.intercept(pkt);
  assert.equal(verdict.isAllowed, false);
});

test('KNOLL blocks direct DREAM -> VISION', () => {
  const knoll = new Knoll();
  const pkt = createPacket({ source: AgentRole.DREAM, destination: AgentRole.VISION, intent: 'x' });
  const verdict = knoll.intercept(pkt);
  assert.equal(verdict.isAllowed, false);
  assert.deepEqual(verdict.enforcedConstraints, ['NO_DIRECT_DREAM_VISION']);
});

test('KNOLL blocks direct VISION -> DREAM', () => {
  const knoll = new Knoll();
  const pkt = createPacket({ source: AgentRole.VISION, destination: AgentRole.DREAM, intent: 'x' });
  const verdict = knoll.intercept(pkt);
  assert.equal(verdict.isAllowed, false);
  assert.deepEqual(verdict.enforcedConstraints, ['NO_DIRECT_DREAM_VISION']);
});

test('KNOLL blocks a forged KNOLL source', () => {
  const knoll = new Knoll();
  const pkt = createPacket({ source: AgentRole.KNOLL, destination: AgentRole.APEX, intent: 'x' });
  const verdict = knoll.intercept(pkt);
  assert.equal(verdict.isAllowed, false);
  assert.deepEqual(verdict.enforcedConstraints, ['NO_KNOLL_FORGERY']);
});

test('KNOLL blocks HOPE directly commanding VISION', () => {
  const knoll = new Knoll();
  const pkt = createPacket({ source: AgentRole.HOPE, destination: AgentRole.VISION, intent: 'run it' });
  const verdict = knoll.intercept(pkt);
  assert.equal(verdict.isAllowed, false);
  assert.deepEqual(verdict.enforcedConstraints, ['HOPE_CANNOT_COMMAND']);
});

test('KNOLL blocks malicious intent heuristics', () => {
  const knoll = new Knoll();
  const pkt = createPacket({
    source: AgentRole.APEX,
    destination: AgentRole.VISION,
    intent: 'please run rm -rf / on the host',
  });
  const verdict = knoll.intercept(pkt);
  assert.equal(verdict.isAllowed, false);
  assert.deepEqual(verdict.enforcedConstraints, ['NO_MALICIOUS_INTENT']);
});

test('APEX will not route a blocked packet to a handler', () => {
  const { router } = freshRouter();
  let delivered = false;
  router.register(AgentRole.VISION, () => {
    delivered = true;
  });
  // Illegal direct DREAM->VISION: KNOLL denies, so the handler must never fire.
  const pkt = createPacket({ source: AgentRole.DREAM, destination: AgentRole.VISION, intent: 'x' });
  const result = router.dispatch(pkt);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(delivered, false, 'blocked packets must never reach the destination handler');
});

test('APEX routes a legal packet and bills the ledger', () => {
  const { router, ledger } = freshRouter();
  router.register(AgentRole.DREAM, () => ({ ok: true }));
  const pkt = createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'simulate' });
  const result = router.dispatch(pkt);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(ledger.countByStatus('SUCCESS'), 1);
  assert.ok(ledger.totalCost() > 0, 'a successful route must record a positive cost');
  assert.equal(ledger.entries()[0].cost_usd, 0.05);
});

test('APEX records BLOCKED packets with zero cost', () => {
  const { router, ledger } = freshRouter();
  router.register(AgentRole.VISION, () => ({ ok: true }));
  const pkt = createPacket({ source: AgentRole.DREAM, destination: AgentRole.VISION, intent: 'x' });
  router.dispatch(pkt);
  assert.equal(ledger.countByStatus('BLOCKED'), 1);
  assert.equal(ledger.costByStatus('BLOCKED'), 0);
});

test('APEX cannot be constructed in a state that skips KNOLL', () => {
  // Even with no injected KNOLL, the router stands one up and enforces it.
  const router = new ApexRouter();
  router.register(AgentRole.VISION, () => ({ ok: true }));
  const pkt = createPacket({ source: AgentRole.DREAM, destination: AgentRole.VISION, intent: 'x' });
  const result = router.dispatch(pkt);
  assert.equal(result.status, 'BLOCKED', 'a default router must still enforce KNOLL');
});

test('non-RoutingPacket input is refused', () => {
  const { router } = freshRouter();
  // deliberately malformed
  const result = router.dispatch({ not: 'a packet' } as unknown as ReturnType<typeof createPacket>);
  assert.equal(result.status, 'BLOCKED');
});
