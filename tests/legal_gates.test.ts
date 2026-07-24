/**
 * tests/legal_gates.test.ts — Manual Progression Gate (node:test).
 *
 * Structural expansion requires human verification: register → approve/reject → guard.
 *
 * Run: node --import tsx --test tests/legal_gates.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ManualProgressionGate,
  THIRD_PARTY_INTEGRATIONS_BOUND_BY_NDA,
  LEGAL_DOCS,
} from '../legal/index.js';

test('a change starts PENDING and blocks expansion until approved', () => {
  const gate = new ManualProgressionGate();
  const decision = gate.requireHumanVerification('expand-matrix-64');
  assert.equal(decision.status, 'PENDING');
  assert.equal(gate.isApproved('expand-matrix-64'), false);
  assert.throws(() => gate.assertApprovedForExpansion('expand-matrix-64'));
});

test('approve(changeId, humanId) unlocks structural expansion', () => {
  const gate = new ManualProgressionGate();
  gate.requireHumanVerification('add-integration-x');
  const approved = gate.approve('add-integration-x', 'human-42');
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.humanId, 'human-42');
  assert.equal(gate.isApproved('add-integration-x'), true);
  assert.doesNotThrow(() => gate.assertApprovedForExpansion('add-integration-x'));
});

test('reject records a refusal and keeps expansion blocked', () => {
  const gate = new ManualProgressionGate();
  gate.requireHumanVerification('risky-change');
  const rejected = gate.reject('risky-change', 'human-7', 'insufficient review');
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.reason, 'insufficient review');
  assert.throws(() => gate.assertApprovedForExpansion('risky-change'));
});

test('an unregistered change cannot be decided or expanded', () => {
  const gate = new ManualProgressionGate();
  assert.throws(() => gate.approve('ghost', 'human-1'));
  assert.throws(() => gate.assertApprovedForExpansion('ghost'));
  assert.equal(gate.status('ghost'), undefined);
});

test('a decided change cannot be silently re-decided', () => {
  const gate = new ManualProgressionGate();
  gate.requireHumanVerification('c1');
  gate.approve('c1', 'human-1');
  assert.throws(() => gate.reject('c1', 'human-2', 'changed my mind'));
  assert.throws(() => gate.approve('c1', 'human-3'));
});

test('requireHumanVerification is idempotent and does not reset a decision', () => {
  const gate = new ManualProgressionGate();
  gate.requireHumanVerification('c2');
  gate.approve('c2', 'human-1');
  const again = gate.requireHumanVerification('c2');
  assert.equal(again.status, 'APPROVED');
});

test('approve/reject require a humanId; changeId must be non-empty', () => {
  const gate = new ManualProgressionGate();
  gate.requireHumanVerification('c3');
  assert.throws(() => gate.approve('c3', ''));
  assert.throws(() => gate.requireHumanVerification(''));
});

test('governance constants document the third-party NDA binding and docs', () => {
  assert.equal(THIRD_PARTY_INTEGRATIONS_BOUND_BY_NDA, true);
  assert.equal(LEGAL_DOCS.termsOfService, 'legal/TOS.md');
  assert.equal(LEGAL_DOCS.governanceNda, 'legal/GOVERNANCE_NDA.md');
});
