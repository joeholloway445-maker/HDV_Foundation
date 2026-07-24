/**
 * tests/triad_duty.test.ts — LAW 8 PRIMARY_TRIAD_DUTY (node:test).
 *
 * The audited HDV constitution gives the Primary Triad ABSOLUTE separation of duty:
 *   HOPE   = 100% GOVERNANCE  (cannot execute, cannot create)
 *   VISION = 100% EXECUTION   (cannot govern,  cannot create)
 *   DREAM  = 100% CREATION    (cannot govern,  cannot execute)
 *
 * These tests lock in the pure law verdict AND its enforcement through the real KNOLL gate.
 * Scoring is disabled in the gate cases so the assertions isolate the duty law from the
 * (separately owned) behavioral scorer.
 *
 * Run: node --import tsx --test tests/triad_duty.test.ts   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lawPrimaryTriadDuty, Knoll } from '../knoll/index.js';
import { createPacket } from '../apex/index.js';
import { AgentRole } from '../config/routing_schema.js';
import {
  PRIMARY_TRIAD,
  AUTHORITY_FLOW,
  ROLE_DUTY,
  ROLE_DUTY_PERCENT,
  FORBIDDEN,
} from '../packages/constitution/index.js';

// ---------------------------------------------------------------------------
// A. The duty vocabulary (constitution kit)
// ---------------------------------------------------------------------------

test('the Primary Triad is exactly HOPE, VISION, DREAM (KNOLL/APEX are outside it)', () => {
  assert.deepEqual([...PRIMARY_TRIAD], [AgentRole.HOPE, AgentRole.VISION, AgentRole.DREAM]);
  assert.ok(!PRIMARY_TRIAD.includes(AgentRole.KNOLL as never));
  assert.ok(!PRIMARY_TRIAD.includes(AgentRole.APEX as never));
});

test('authority flows Hope -> Vision -> Dream; memory returns upward to Hope', () => {
  assert.deepEqual([...AUTHORITY_FLOW.downward], [AgentRole.HOPE, AgentRole.VISION, AgentRole.DREAM]);
  assert.equal(AUTHORITY_FLOW.memoryReturnsTo, AgentRole.HOPE);
});

test('each triad role owns one duty at 100% and forbids the other two', () => {
  assert.equal(ROLE_DUTY[AgentRole.HOPE], 'GOVERNANCE');
  assert.equal(ROLE_DUTY[AgentRole.VISION], 'EXECUTION');
  assert.equal(ROLE_DUTY[AgentRole.DREAM], 'CREATION');
  for (const role of PRIMARY_TRIAD) {
    const pct = ROLE_DUTY_PERCENT[role];
    const total = pct.GOVERNANCE + pct.EXECUTION + pct.CREATION;
    assert.equal(total, 100, `${role} duty percentages must sum to 100`);
    assert.equal(pct[ROLE_DUTY[role]], 100, `${role} owns its duty at 100%`);
    assert.deepEqual([...FORBIDDEN[role]].sort(), Object.keys(pct).filter((d) => pct[d as keyof typeof pct] === 0).sort());
  }
});

// ---------------------------------------------------------------------------
// B. The pure law — every forbidden duty is a violation
// ---------------------------------------------------------------------------

test('lawPrimaryTriadDuty blocks each forbidden duty (explicit data.duty)', () => {
  const violations: Array<[AgentRole, 'GOVERNANCE' | 'EXECUTION' | 'CREATION']> = [
    [AgentRole.HOPE, 'EXECUTION'],
    [AgentRole.HOPE, 'CREATION'],
    [AgentRole.VISION, 'GOVERNANCE'],
    [AgentRole.VISION, 'CREATION'],
    [AgentRole.DREAM, 'GOVERNANCE'],
    [AgentRole.DREAM, 'EXECUTION'],
  ];
  for (const [dest, duty] of violations) {
    const packet = createPacket({ source: AgentRole.APEX, destination: dest, intent: 'x', data: { duty } });
    const verdict = lawPrimaryTriadDuty(packet);
    assert.equal(verdict.passed, false, `${dest} asked to ${duty} must be a duty violation`);
    assert.equal(verdict.law, 'PRIMARY_TRIAD_DUTY');
  }
});

test('lawPrimaryTriadDuty allows each role its own 100% duty', () => {
  const allowed: Array<[AgentRole, 'GOVERNANCE' | 'EXECUTION' | 'CREATION']> = [
    [AgentRole.HOPE, 'GOVERNANCE'],
    [AgentRole.VISION, 'EXECUTION'],
    [AgentRole.DREAM, 'CREATION'],
  ];
  for (const [dest, duty] of allowed) {
    const packet = createPacket({ source: AgentRole.APEX, destination: dest, intent: 'x', data: { duty } });
    assert.equal(lawPrimaryTriadDuty(packet).passed, true, `${dest} performing ${duty} is legal`);
  }
});

test('lawPrimaryTriadDuty infers duty from a HOPE IntentKind when no explicit duty is given', () => {
  const executeToHope = createPacket({ source: AgentRole.APEX, destination: AgentRole.HOPE, intent: 'x', data: { kind: 'EXECUTE' } });
  assert.equal(lawPrimaryTriadDuty(executeToHope).passed, false, 'EXECUTE asked of HOPE is a violation');

  const simulateToVision = createPacket({ source: AgentRole.APEX, destination: AgentRole.VISION, intent: 'x', data: { kind: 'SIMULATE' } });
  assert.equal(lawPrimaryTriadDuty(simulateToVision).passed, false, 'SIMULATE (creation) asked of VISION is a violation');
});

test('lawPrimaryTriadDuty is additive: no declared duty, or APEX/KNOLL destinations, pass', () => {
  const noDuty = createPacket({ source: AgentRole.APEX, destination: AgentRole.VISION, intent: 'execute the plan' });
  assert.equal(lawPrimaryTriadDuty(noDuty).passed, true, 'legacy packets without a duty declaration stay legal');

  const toApex = createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'x', data: { duty: 'EXECUTION' } });
  assert.equal(lawPrimaryTriadDuty(toApex).passed, true, 'APEX is outside the triad and is not duty-bound');
});

// ---------------------------------------------------------------------------
// C. Enforcement through the real KNOLL gate (scoring disabled to isolate the law)
// ---------------------------------------------------------------------------

test('KNOLL blocks a duty-violating packet with the PRIMARY_TRIAD_DUTY constraint', () => {
  const knoll = new Knoll(undefined, { enableScoring: false });
  const packet = createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'run the deployment', data: { duty: 'EXECUTION' } });
  const verdict = knoll.intercept(packet);
  assert.equal(verdict.isAllowed, false, 'DREAM cannot be asked to execute');
  assert.deepEqual(verdict.enforcedConstraints, ['PRIMARY_TRIAD_DUTY']);
});

test('KNOLL allows a duty-respecting packet through the gate', () => {
  const knoll = new Knoll(undefined, { enableScoring: false });
  const packet = createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'render three variations', data: { duty: 'CREATION' } });
  assert.equal(knoll.intercept(packet).isAllowed, true, 'DREAM performing creation is legal');
});
