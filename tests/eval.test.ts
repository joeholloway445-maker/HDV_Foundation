/**
 * tests/eval.test.ts — the public eval board + open-core constitution kit (node:test).
 *
 * Two concerns, both read-only over the constitution:
 *   A. eval/run_board.ts scores the five headline metrics against the REAL APEX -> KNOLL gate.
 *      The safety metric (governance_violation_rate) MUST be 0 and every legal packet MUST
 *      route — the board doubles as a constitution regression gate.
 *   B. packages/constitution keeps its published law names in sync with the real KNOLL laws.
 *
 * Run: npm run test:eval   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';

import {
  loadFixture,
  runBoard,
  computeMetrics,
  renderHtml,
  writeReport,
  type CaseResult,
} from '../eval/run_board.js';
import {
  AgentRole,
  KNOLL_LAW_NAMES,
  KNOLL_GUARD_NAMES,
  LEDGER_FIELDS,
  AGENT_LIFECYCLE,
  ALWAYS_ON_ROLES,
  EPHEMERAL_ROLES,
} from '../packages/constitution/index.js';
import { VIRTUAL_LAWS } from '../knoll/laws.js';
import { createPacket } from '../apex/index.js';
import type { LedgerEntry } from '../apex/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'eval', 'fixtures', 'sample.json');

// ---------------------------------------------------------------------------
// A. Eval board
// ---------------------------------------------------------------------------

test('sample fixture runs the real gate: no escaped violations, every legal packet routes', () => {
  const report = runBoard(loadFixture(FIXTURE), { now: () => 0 });
  const m = report.metrics;

  // The headline safety invariant: not a single illegal packet slipped through.
  assert.equal(m.governance_violation_rate, 0, 'a governance violation escaped the gate');
  // Every legal packet routed; none was wrongly blocked.
  assert.equal(m.routing_success_rate, 1);
  assert.equal(m.false_block_rate, 0);
  assert.equal(m.failed, 0);
  assert.equal(m.accuracy, 1, 'every verdict matched ground truth');
  assert.equal(report.passed, true, 'the board gate passes on the golden fixture');
});

test('each labeled case gets the expected KNOLL verdict + enforced constraint', () => {
  const report = runBoard(loadFixture(FIXTURE), { now: () => 0 });
  const byId = new Map<string, CaseResult>(report.results.map((r) => [r.id, r]));

  // Illegal cases block on the RIGHT law/guard (the public constraint vocabulary).
  const expectations: Record<string, string> = {
    'block-direct-dream-vision': 'NO_DIRECT_DREAM_VISION',
    'block-hope-commands-vision': 'HOPE_CANNOT_COMMAND',
    'block-knoll-forgery': 'NO_KNOLL_FORGERY',
    'block-tampered-hash': 'HASH_INTEGRITY',
    'block-malicious-intent': 'NO_MALICIOUS_INTENT',
    'block-self-addressed': 'VALID_ENDPOINTS',
  };
  for (const [id, constraint] of Object.entries(expectations)) {
    const r = byId.get(id);
    assert.ok(r, `missing case ${id}`);
    assert.equal(r!.status, 'BLOCKED', `${id} should be BLOCKED`);
    assert.ok(
      r!.enforcedConstraints.includes(constraint),
      `${id} should enforce ${constraint}, got [${r!.enforcedConstraints.join(', ')}]`,
    );
  }

  // Legal ephemeral executions light up active params and are billed; interpretation hops are free.
  const dream = byId.get('legal-apex-to-dream-simulate')!;
  assert.equal(dream.status, 'SUCCESS');
  assert.ok(dream.activeParamSeconds > 0, 'a DREAM execution lights up active params');
  assert.ok(dream.costUsd > 0, 'a DREAM execution is billed');

  const interp = byId.get('legal-hope-to-apex-intent')!;
  assert.equal(interp.status, 'SUCCESS');
  assert.equal(interp.activeParamSeconds, 0, 'an interpretation hop lights up no personas');
  assert.equal(interp.costUsd, 0, 'idle-cheap: interpretation is free of active-param cost');
});

test('metrics math: rates, percentiles, and cost/active-param-second', () => {
  const results: CaseResult[] = [
    mkResult({ id: 'a', expectBlocked: false, status: 'SUCCESS', latencyMs: 2, costUsd: 0.003, activeParamSeconds: 1e10 }),
    mkResult({ id: 'b', expectBlocked: false, status: 'SUCCESS', latencyMs: 4, costUsd: 0.003, activeParamSeconds: 1e10 }),
    mkResult({ id: 'c', expectBlocked: true, status: 'BLOCKED', latencyMs: 1 }),
    mkResult({ id: 'd', expectBlocked: true, status: 'BLOCKED', latencyMs: 1 }),
  ];
  const m = computeMetrics(results);
  assert.equal(m.totalCases, 4);
  assert.equal(m.routed, 2);
  assert.equal(m.blocked, 2);
  assert.equal(m.governance_violation_rate, 0);
  assert.equal(m.knoll_block_rate, 0.5);
  assert.equal(m.routing_success_rate, 1);
  // cost_per_active_param_second = total cost (0.006) / total active-param-seconds (2e10).
  assert.ok(Math.abs(m.cost_per_active_param_second - 0.006 / 2e10) < 1e-18);
  assert.ok(m.latency_p50_ms > 0 && m.latency_p95_ms >= m.latency_p50_ms);
});

test('an escaped violation is caught by the metrics (governance_violation_rate > 0)', () => {
  // Simulate a leak: an illegal packet that somehow routed SUCCESS.
  const results: CaseResult[] = [
    mkResult({ id: 'leak', expectBlocked: true, status: 'SUCCESS', latencyMs: 1 }),
    mkResult({ id: 'ok', expectBlocked: false, status: 'SUCCESS', latencyMs: 1 }),
  ];
  const m = computeMetrics(results);
  assert.equal(m.governance_violation_rate, 0.5, 'the board must surface an escaped violation');
});

test('the board renders a self-contained HTML report and writes both artifacts', () => {
  const report = runBoard(loadFixture(FIXTURE), { now: () => 0 });
  const html = renderHtml(report);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Public Eval Board/);
  assert.match(html, /GATE: PASS/);
  assert.match(html, /governance/i);
  // No external asset references (fully offline).
  assert.doesNotMatch(html, /https?:\/\//);

  const outDir = mkdtempSync(path.join(tmpdir(), 'eval-board-'));
  const { htmlPath, jsonPath } = writeReport(report, outDir);
  assert.ok(existsSync(htmlPath) && existsSync(jsonPath));
  const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as { passed: boolean; metrics: { totalCases: number } };
  assert.equal(parsed.passed, true);
  assert.equal(parsed.metrics.totalCases, report.results.length);
});

// ---------------------------------------------------------------------------
// B. Open-core constitution kit
// ---------------------------------------------------------------------------

test('KNOLL_LAW_NAMES stays in sync with the real virtual laws (kit cannot drift)', () => {
  // Drive each real law with a benign packet and read the `.law` name it reports.
  const packet = createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'hello' });
  const realNames = VIRTUAL_LAWS.map((law) => law(packet).law);
  assert.deepEqual([...KNOLL_LAW_NAMES], realNames, 'published law names must match knoll/laws.ts, in order');
});

test('LEDGER_FIELDS matches the shape of a real ledger entry', () => {
  const entry: LedgerEntry = {
    id: 'led_1',
    packetId: 'pkt_1',
    timestamp: 0,
    source: AgentRole.HOPE,
    destination: AgentRole.APEX,
    status: 'SUCCESS',
    cost_usd: 0,
    knollSignature: 'sig',
  };
  assert.deepEqual([...LEDGER_FIELDS].sort(), Object.keys(entry).sort());
});

test('lifecycle map encodes always-on trio tiny; workers to zero', () => {
  assert.deepEqual([...ALWAYS_ON_ROLES].sort(), [AgentRole.APEX, AgentRole.HOPE, AgentRole.KNOLL].sort());
  assert.deepEqual([...EPHEMERAL_ROLES].sort(), [AgentRole.DREAM, AgentRole.VISION].sort());
  assert.equal(AGENT_LIFECYCLE[AgentRole.HOPE], 'ALWAYS_ON');
  assert.equal(AGENT_LIFECYCLE[AgentRole.DREAM], 'EPHEMERAL');
  assert.equal(AGENT_LIFECYCLE[AgentRole.VISION], 'EPHEMERAL');
  // Every role has exactly one lifecycle; nothing is both resident and ephemeral.
  assert.equal(new Set([...ALWAYS_ON_ROLES, ...EPHEMERAL_ROLES]).size, Object.values(AgentRole).length);
});

test('KNOLL_GUARD_NAMES documents the structural guards around the six laws', () => {
  for (const g of ['STRUCTURE', 'HASH_INTEGRITY', 'RATE_LIMIT', 'BEHAVIORAL_SCORE']) {
    assert.ok(KNOLL_GUARD_NAMES.includes(g as (typeof KNOLL_GUARD_NAMES)[number]));
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkResult(partial: Partial<CaseResult> & Pick<CaseResult, 'id' | 'expectBlocked' | 'status'>): CaseResult {
  return {
    description: partial.id,
    route: 'HOPE → APEX',
    intent: 'x',
    latencyMs: 1,
    enforcedConstraints: [],
    costUsd: 0,
    activeParamSeconds: 0,
    passed: (partial.status === 'BLOCKED') === partial.expectBlocked,
    ...partial,
  };
}
