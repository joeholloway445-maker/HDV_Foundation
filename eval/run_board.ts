/**
 * eval/run_board.ts — the PUBLIC eval board (Phase 7.4 scaffold).
 *
 * A small, honest quality gate that runs a set of labeled intents through the REAL
 * APEX → KNOLL transport and scores five headline metrics:
 *
 *   1. governance_violation_rate  — fraction of ALL traffic where an illegal packet was NOT
 *                                    blocked (an escaped violation). This is the safety metric;
 *                                    it MUST be 0. The constitution wins ties.
 *   2. knoll_block_rate           — fraction of traffic KNOLL blocked (allow/deny pressure).
 *   3. latency p50 / p95 (ms)     — gated-dispatch latency distribution.
 *   4. cost_per_active_param_second— total metered USD ÷ total active-parameter-seconds. Idle
 *                                    personas draw ≈0, so this reflects only lit-up compute.
 *   5. routing_success_rate       — fraction of LEGAL packets that routed successfully.
 *
 * It runs each case against a live `ApexRouter` + `Knoll` (not a mock), so a passing board is
 * evidence the real gate behaves. Inputs come from a fixture (`eval/fixtures/sample.json` by
 * default) that carries the scenario AND recorded per-case observations (latency / active
 * params) from a demo or test run — so the HTML report is reproducible offline.
 *
 * Usage:
 *   npm run eval:board                       # default fixture → eval/out/{board.html,board.json}
 *   tsx eval/run_board.ts --fixture path.json --out eval/out
 *
 * Exit code is 1 when the board fails its gate (any escaped governance violation, or any legal
 * packet blocked/failed), so it can wire into CI. This module is import-safe: nothing runs and
 * nothing exits unless the file is invoked directly.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ApexRouter, createPacket } from '../apex/index.js';
import { Knoll, LearnedBehavioralScorer, exportAuditTrainingSet } from '../knoll/index.js';
import type { LabeledPacketSample, LearnedMode } from '../knoll/index.js';
import { AgentRole, type PacketPriority, type RoutingStatus } from '../config/routing_schema.js';
import { loadPricingBook } from '../billing/index.js';
import type { PlanTier } from '../billing/index.js';
import { MODEL_PARAMS } from '../nodes/index.js';

// ---------------------------------------------------------------------------
// Fixture + result types
// ---------------------------------------------------------------------------

/** One labeled scenario. `expectBlocked` is the ground truth KNOLL should agree with. */
export interface EvalCase {
  id: string;
  description: string;
  source: string;
  destination: string;
  intent: string;
  data?: Record<string, unknown>;
  priority?: PacketPriority;
  /** Mutate the payload AFTER hashing to simulate tampering (→ HASH_INTEGRITY block). */
  tamper?: boolean;
  /** Ground truth: should the KNOLL gate block this packet? */
  expectBlocked: boolean;
  /**
   * Observations recorded from a real demo/test run. `latencyMs` seeds the latency
   * distribution; `activeParams` × `durationSec` seeds the active-parameter-seconds used for
   * cost. Absent fields fall back to the measured dispatch time and one 7B persona-second.
   */
  observed?: {
    latencyMs?: number;
    activeParams?: number;
    durationSec?: number;
  };
}

/** One labeled training packet for the learned scorer: a packet spec + its deny label. */
export interface LearnedTrainCase {
  source: string;
  destination: string;
  intent: string;
  data?: Record<string, unknown>;
  priority?: PacketPriority;
  /** 1 = the packet should be DENIED (BLOCKED); 0 = it is fine to ALLOW. */
  label: 0 | 1;
}

/**
 * Optional learned-scorer configuration. When `enable` is true, the board trains a
 * `LearnedBehavioralScorer` on `train` and wires it into KNOLL as an ADDITIVE gate — so the
 * board measures the real learned scorer, not a mock. It can only ADD denies (see
 * knoll/scoring_learned.ts); illegal traffic is still caught by the hard laws first.
 */
export interface LearnedBoardConfig {
  enable: boolean;
  /** shadow (log only, never denies) vs enforce (adds denies). Default 'enforce'. */
  mode?: LearnedMode;
  /** Run the hand-tuned heuristic scorer alongside the learned one. Default false (isolate learned). */
  withHeuristic?: boolean;
  /** Training epochs. Default 300. */
  epochs?: number;
  /** Deny threshold on the sigmoid probability. Default 0.6. */
  threshold?: number;
  /** Flag threshold. Default 0.4. */
  flagThreshold?: number;
  train: LearnedTrainCase[];
}

export interface EvalFixture {
  name: string;
  description?: string;
  generatedFrom?: string;
  /** Pricing tier used to meter successful ephemeral executions. Default ENTERPRISE. */
  tier?: PlanTier;
  /** Optional learned-scorer config (Phase 7). Absent → the board runs the default gate. */
  learned?: LearnedBoardConfig;
  cases: EvalCase[];
}

export interface CaseResult {
  id: string;
  description: string;
  route: string;
  intent: string;
  expectBlocked: boolean;
  status: RoutingStatus;
  passed: boolean;
  latencyMs: number;
  enforcedConstraints: string[];
  costUsd: number;
  activeParamSeconds: number;
}

export interface BoardMetrics {
  totalCases: number;
  routed: number;
  blocked: number;
  failed: number;
  /** Escaped illegal packets ÷ total traffic. Safety metric — must be 0. */
  governance_violation_rate: number;
  /** Blocked ÷ total. */
  knoll_block_rate: number;
  /** Legal packets routed ÷ legal packets. */
  routing_success_rate: number;
  /** Legal packets wrongly blocked ÷ legal packets (supporting quality metric). */
  false_block_rate: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  cost_per_active_param_second: number;
  total_cost_usd: number;
  total_active_param_seconds: number;
  /** Cases whose verdict matched ground truth ÷ total. */
  accuracy: number;
}

export interface BoardReport {
  name: string;
  description?: string;
  generatedFrom?: string;
  generatedAt: string;
  tier: PlanTier;
  metrics: BoardMetrics;
  results: CaseResult[];
  /** True when the board passes its gate (no escaped violations, no legal packet blocked). */
  passed: boolean;
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const ROLE_VALUES = new Set<string>(Object.values(AgentRole));

function asRole(value: string, field: string, caseId: string): AgentRole {
  if (!ROLE_VALUES.has(value)) {
    throw new Error(`eval fixture: case "${caseId}" has invalid ${field} role "${value}"`);
  }
  return value as AgentRole;
}

export function loadFixture(fixturePath: string): EvalFixture {
  const raw = readFileSync(fixturePath, 'utf8');
  const parsed = JSON.parse(raw) as EvalFixture;
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`eval fixture "${fixturePath}" has no cases`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Board execution — drives the REAL APEX → KNOLL transport
// ---------------------------------------------------------------------------

export interface RunBoardOptions {
  /** Injectable clock for deterministic tests (defaults to Date.now via the ISO stamp). */
  now?: () => number;
}

/**
 * Run every case through a live gate and score it. Uses a fresh `ApexRouter` + `Knoll` so the
 * board measures the real constitution, not a stub. A trivial handler is registered for every
 * role so a legal packet routes (SUCCESS) and only KNOLL can produce a BLOCK.
 */
export function runBoard(fixture: EvalFixture, options: RunBoardOptions = {}): BoardReport {
  const tier: PlanTier = fixture.tier ?? 'ENTERPRISE';
  const pricing = loadPricingBook();

  const knoll = fixture.learned?.enable
    ? new Knoll(undefined, buildLearnedKnollOptions(fixture.learned))
    : new Knoll();

  const router = new ApexRouter({ knoll, defaultCostUsd: 0 });
  for (const role of Object.values(AgentRole)) {
    router.register(role, () => ({ ok: true }));
  }

  const results: CaseResult[] = [];

  for (const c of fixture.cases) {
    const source = asRole(c.source, 'source', c.id);
    const destination = asRole(c.destination, 'destination', c.id);

    const packet = createPacket({
      source,
      destination,
      intent: c.intent,
      data: c.data ?? {},
      priority: c.priority,
    });
    if (c.tamper) {
      // Mutate the payload after the hash was computed — KNOLL must detect it.
      (packet.payload.data as Record<string, unknown>).injected = 'post-hash-tamper';
    }

    const start = performance.now();
    const dispatch = router.dispatch(packet);
    const measuredMs = performance.now() - start;

    const status = dispatch.status;
    const expected: RoutingStatus = c.expectBlocked ? 'BLOCKED' : 'SUCCESS';
    const passed = status === expected;

    const latencyMs = round3(c.observed?.latencyMs ?? measuredMs);

    // Cost model: only successfully-executed packets light up active parameters and bill.
    const activeParams = c.observed?.activeParams ?? (status === 'SUCCESS' ? MODEL_PARAMS : 0);
    const durationSec = c.observed?.durationSec ?? 1;
    const activeParamSeconds = status === 'SUCCESS' ? activeParams * durationSec : 0;
    const costUsd =
      status === 'SUCCESS' && activeParamSeconds > 0
        ? pricing.estimate({ tier, activeParams, durationSec, priorSpendUsd: 0 }).costUsd
        : 0;

    results.push({
      id: c.id,
      description: c.description,
      route: `${source} → ${destination}`,
      intent: c.intent,
      expectBlocked: c.expectBlocked,
      status,
      passed,
      latencyMs,
      enforcedConstraints: dispatch.knoll.enforcedConstraints ?? [],
      costUsd: round6(costUsd),
      activeParamSeconds,
    });
  }

  const metrics = computeMetrics(results);
  const generatedAt = new Date(options.now ? options.now() : Date.now()).toISOString();
  const passed = metrics.governance_violation_rate === 0 && metrics.false_block_rate === 0 && metrics.failed === 0;

  return {
    name: fixture.name,
    description: fixture.description,
    generatedFrom: fixture.generatedFrom,
    generatedAt,
    tier,
    metrics,
    results,
    passed,
  };
}

/**
 * Train a LearnedBehavioralScorer on the fixture's labeled packets and return the KNOLL options
 * that wire it in. Training uses the same feature extractor KNOLL uses live (via
 * `exportAuditTrainingSet`), so the board scores the REAL learned gate. By default the heuristic
 * scorer is turned off so the board isolates the learned scorer's additive denies.
 */
function buildLearnedKnollOptions(config: LearnedBoardConfig) {
  const samples: LabeledPacketSample[] = config.train.map((t) => {
    const source = asRole(t.source, 'source', `learned-train:${t.intent}`);
    const destination = asRole(t.destination, 'destination', `learned-train:${t.intent}`);
    const packet = createPacket({
      source,
      destination,
      intent: t.intent,
      data: t.data ?? {},
      priority: t.priority,
    });
    return { packet, outcome: t.label === 1 ? ('BLOCKED' as const) : ('ALLOWED' as const) };
  });

  const scorer = new LearnedBehavioralScorer({
    mode: config.mode ?? 'enforce',
    threshold: config.threshold,
    flagThreshold: config.flagThreshold,
  });
  scorer.train(exportAuditTrainingSet(samples), { epochs: config.epochs ?? 300 });

  return {
    enableScoring: config.withHeuristic ?? false,
    learnedScorer: scorer,
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function computeMetrics(results: CaseResult[]): BoardMetrics {
  const total = results.length;
  const routed = results.filter((r) => r.status === 'SUCCESS').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;
  const failed = results.filter((r) => r.status === 'FAILED').length;

  const legal = results.filter((r) => !r.expectBlocked);
  const illegal = results.filter((r) => r.expectBlocked);

  const escapedViolations = illegal.filter((r) => r.status !== 'BLOCKED').length;
  const legalRouted = legal.filter((r) => r.status === 'SUCCESS').length;
  const legalBlocked = legal.filter((r) => r.status === 'BLOCKED').length;
  const correct = results.filter((r) => r.passed).length;

  const latencies = results.map((r) => r.latencyMs);
  const totalCost = round6(results.reduce((s, r) => s + r.costUsd, 0));
  const totalAps = results.reduce((s, r) => s + r.activeParamSeconds, 0);

  return {
    totalCases: total,
    routed,
    blocked,
    failed,
    governance_violation_rate: rate(escapedViolations, total),
    knoll_block_rate: rate(blocked, total),
    routing_success_rate: legal.length === 0 ? 1 : rate(legalRouted, legal.length),
    false_block_rate: legal.length === 0 ? 0 : rate(legalBlocked, legal.length),
    latency_p50_ms: percentile(latencies, 50),
    latency_p95_ms: percentile(latencies, 95),
    cost_per_active_param_second: totalAps > 0 ? totalCost / totalAps : 0,
    total_cost_usd: totalCost,
    total_active_param_seconds: totalAps,
    accuracy: rate(correct, total),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderJson(report: BoardReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}

/** A self-contained (no external assets) HTML report card. */
export function renderHtml(report: BoardReport): string {
  const m = report.metrics;
  const gateClass = report.passed ? 'ok' : 'fail';
  const gateLabel = report.passed ? 'PASS' : 'FAIL';

  const cards = [
    metricCard('Governance violation rate', pct(m.governance_violation_rate), m.governance_violation_rate === 0 ? 'ok' : 'fail', 'Escaped illegal packets ÷ all traffic. Must be 0 — the constitution wins ties.'),
    metricCard('KNOLL block rate', pct(m.knoll_block_rate), 'neutral', `${m.blocked}/${m.totalCases} packets denied at the gate.`),
    metricCard('Routing success rate', pct(m.routing_success_rate), m.routing_success_rate >= 1 ? 'ok' : 'fail', 'Legal packets that routed SUCCESS ÷ legal packets.'),
    metricCard('Latency p50 / p95', `${fmt(m.latency_p50_ms)} / ${fmt(m.latency_p95_ms)} ms`, 'neutral', 'Gated-dispatch latency (KNOLL + handler).'),
    metricCard('Cost / active-param-second', `$${m.cost_per_active_param_second.toExponential(3)}`, 'neutral', `Total $${fmt6(m.total_cost_usd)} ÷ ${humanize(m.total_active_param_seconds)} active-param-seconds. Idle personas draw ≈0.`),
  ].join('\n');

  const rows = report.results
    .map((r) => {
      const verdict = r.passed ? 'ok' : 'fail';
      const constraints = r.enforcedConstraints.length ? r.enforcedConstraints.join(', ') : '—';
      return `        <tr class="${verdict}">
          <td><code>${esc(r.id)}</code></td>
          <td>${esc(r.route)}</td>
          <td>${r.expectBlocked ? 'BLOCK' : 'ROUTE'}</td>
          <td><span class="pill ${statusClass(r.status)}">${r.status}</span></td>
          <td>${r.passed ? '✓' : '✗'}</td>
          <td>${fmt(r.latencyMs)}</td>
          <td>${r.costUsd > 0 ? '$' + fmt6(r.costUsd) : '—'}</td>
          <td class="muted">${esc(constraints)}</td>
        </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Big 5 Matrix — Public Eval Board</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: radial-gradient(1200px 800px at 70% -10%, #16213e 0%, #0b1020 55%, #070a14 100%); color: #e6ebff; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 40px 24px 72px; }
  header .eyebrow { letter-spacing: .22em; text-transform: uppercase; font-size: 12px; color: #7f8cc0; margin: 0 0 6px; }
  h1 { margin: 0 0 4px; font-size: 30px; font-weight: 700; }
  .sub { color: #9aa4d6; margin: 0 0 22px; }
  .gate { display: inline-flex; align-items: center; gap: 10px; padding: 8px 16px; border-radius: 999px; font-weight: 700;
    letter-spacing: .06em; }
  .gate.ok { background: rgba(46,204,113,.14); color: #6ff0a6; border: 1px solid rgba(46,204,113,.4); }
  .gate.fail { background: rgba(231,76,60,.14); color: #ff9b8f; border: 1px solid rgba(231,76,60,.45); }
  .scale { margin: 22px 0 26px; padding: 16px 18px; border-radius: 14px; border: 1px solid rgba(122,140,255,.25);
    background: linear-gradient(90deg, rgba(80,120,255,.10), rgba(120,80,255,.04)); }
  .scale strong { color: #bcd0ff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin: 8px 0 30px; }
  .card { background: rgba(18,24,48,.7); border: 1px solid rgba(122,140,255,.16); border-radius: 14px; padding: 16px 16px 14px; }
  .card .label { font-size: 12px; letter-spacing: .04em; color: #97a2d8; margin: 0 0 8px; text-transform: uppercase; }
  .card .value { font-size: 24px; font-weight: 700; margin: 0 0 8px; }
  .card .hint { font-size: 12px; color: #8892bf; margin: 0; }
  .card.ok .value { color: #6ff0a6; }
  .card.fail .value { color: #ff9b8f; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid rgba(122,140,255,.10); }
  th { color: #97a2d8; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: .05em; }
  tr.fail td { background: rgba(231,76,60,.06); }
  code { background: rgba(122,140,255,.10); padding: 1px 6px; border-radius: 6px; font-size: 12px; }
  .muted { color: #8892bf; }
  .pill { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .pill.s { background: rgba(46,204,113,.16); color: #6ff0a6; }
  .pill.b { background: rgba(231,76,60,.16); color: #ff9b8f; }
  .pill.f { background: rgba(241,196,15,.16); color: #ffe08a; }
  footer { margin-top: 34px; color: #6f7aad; font-size: 12px; }
  footer code { font-size: 11px; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <p class="eyebrow">Big 5 Matrix · HDV Foundation</p>
      <h1>Public Eval Board</h1>
      <p class="sub">${esc(report.name)}</p>
      <span class="gate ${gateClass}">GATE: ${gateLabel}</span>
    </header>

    <div class="scale">
      <strong>Infinite-scale posture.</strong> The always-on trio — HOPE · KNOLL · APEX — stays
      tiny (three resident processes). DREAM &amp; VISION workers, and the full 20,480-node
      fleet, are ephemeral and scale to <strong>zero</strong> when idle. You are metered by
      <strong>active</strong>-parameter-seconds, so idle personas cost ≈ $0 and the board's
      cost/active-param-second reflects only lit-up compute.
    </div>

    <div class="grid">
${cards}
    </div>

    <table>
      <thead>
        <tr>
          <th>Case</th><th>Route</th><th>Expect</th><th>Verdict</th><th>Pass</th>
          <th>Latency (ms)</th><th>Cost</th><th>Enforced</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>

    <footer>
      <div>${report.results.length} cases · accuracy ${pct(m.accuracy)} · tier ${esc(report.tier)}${
        report.generatedFrom ? ' · source: ' + esc(report.generatedFrom) : ''
      }</div>
      <div>Generated ${esc(report.generatedAt)} · <code>npm run eval:board</code></div>
    </footer>
  </div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface WrittenReport {
  htmlPath: string;
  jsonPath: string;
}

export function writeReport(report: BoardReport, outDir: string): WrittenReport {
  mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'board.html');
  const jsonPath = path.join(outDir, 'board.json');
  writeFileSync(htmlPath, renderHtml(report), 'utf8');
  writeFileSync(jsonPath, renderJson(report), 'utf8');
  return { htmlPath, jsonPath };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rate(n: number, d: number): number {
  return d === 0 ? 0 : round6(n / d);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return round3(sorted[lo]);
  const frac = rank - lo;
  return round3(sorted[lo] * (1 - frac) + sorted[hi] * frac);
}

function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e3) / 1e3;
}

function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

function pct(n: number): string {
  return `${round3(n * 100)}%`;
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function fmt6(n: number): string {
  return n.toFixed(6);
}

function humanize(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  return String(n);
}

function statusClass(status: RoutingStatus): string {
  return status === 'SUCCESS' ? 's' : status === 'BLOCKED' ? 'b' : 'f';
}

function metricCard(label: string, value: string, tone: 'ok' | 'fail' | 'neutral', hint: string): string {
  const cls = tone === 'neutral' ? 'card' : `card ${tone}`;
  return `      <div class="${cls}">
        <p class="label">${esc(label)}</p>
        <p class="value">${esc(value)}</p>
        <p class="hint">${esc(hint)}</p>
      </div>`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// CLI entry (import-safe: only runs when invoked directly)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { fixture: string; out: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let fixture = path.join(here, 'fixtures', 'sample.json');
  let out = path.join(here, 'out');
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--fixture' || argv[i] === '-f') && argv[i + 1]) fixture = path.resolve(argv[++i]);
    else if ((argv[i] === '--out' || argv[i] === '-o') && argv[i + 1]) out = path.resolve(argv[++i]);
  }
  return { fixture, out };
}

function main(): void {
  const { fixture, out } = parseArgs(process.argv.slice(2));
  const report = runBoard(loadFixture(fixture));
  const { htmlPath, jsonPath } = writeReport(report, out);
  const m = report.metrics;

  const line = '─'.repeat(64);
  console.log(line);
  console.log('BIG 5 MATRIX — PUBLIC EVAL BOARD');
  console.log(line);
  console.log(`fixture:                       ${fixture}`);
  console.log(`cases:                         ${m.totalCases}  (routed ${m.routed} · blocked ${m.blocked} · failed ${m.failed})`);
  console.log(`governance_violation_rate:     ${pct(m.governance_violation_rate)}   ${m.governance_violation_rate === 0 ? '(safe)' : '(!!)'}`);
  console.log(`knoll_block_rate:              ${pct(m.knoll_block_rate)}`);
  console.log(`routing_success_rate:          ${pct(m.routing_success_rate)}`);
  console.log(`latency p50 / p95 (ms):        ${fmt(m.latency_p50_ms)} / ${fmt(m.latency_p95_ms)}`);
  console.log(`cost_per_active_param_second:  $${m.cost_per_active_param_second.toExponential(3)}`);
  console.log(`accuracy:                      ${pct(m.accuracy)}`);
  console.log(line);
  console.log(`report: ${htmlPath}`);
  console.log(`json:   ${jsonPath}`);
  console.log(`GATE:   ${report.passed ? 'PASS' : 'FAIL'}`);

  if (!report.passed) process.exitCode = 1;
}

// Run only when executed directly (e.g. `tsx eval/run_board.ts`), never on import.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main();
}
