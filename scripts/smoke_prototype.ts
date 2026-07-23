/**
 * scripts/smoke_prototype.ts — programmatic smoke test of the HOPE gateway handlers.
 *
 * This drives the gateway's request handlers DIRECTLY (via `HopeGateway.route`), so it exercises
 * the exact code path a real HTTP request takes — HOPE → APEX → KNOLL → (DREAM|VISION) — WITHOUT
 * binding a port or spinning up a long-lived server. It is the fast, deterministic, offline half
 * of the prototype boot: `scripts/prototype.sh` still starts a real server and curls it over the
 * wire, but this file proves every handler is wired and returns the shape the marketing surfaces
 * (pricing page, waitlist form, MCP tools) depend on.
 *
 * Run:
 *   npm run smoke            # tsx scripts/smoke_prototype.ts
 *   tsx scripts/smoke_prototype.ts
 *
 * Exit code 0 = all checks passed; 1 = at least one check failed (CI-friendly).
 *
 * INVARIANT: this is a client of the gateway's public surface only. It imports no peer agent
 * directly and never bypasses APEX/KNOLL — it just asserts the front door behaves.
 */
import { HopeGateway, type GatewayResponse } from '../gateway/index.js';

// ---------------------------------------------------------------------------
// tiny assertion harness (no test framework — keep the smoke dependency-free)
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  // Single-line, greppable output.
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Assert an HTTP-ish status and run extra field checks; records one line either way. */
function expect(
  name: string,
  res: GatewayResponse,
  wantStatus: number,
  checks: Array<[string, boolean]> = [],
): void {
  if (res.status !== wantStatus) {
    record(name, false, `status ${res.status} (wanted ${wantStatus}): ${JSON.stringify(res.body).slice(0, 160)}`);
    return;
  }
  for (const [label, pass] of checks) {
    if (!pass) {
      record(name, false, `status ok but check failed: ${label}`);
      return;
    }
  }
  record(name, true, `status ${res.status}`);
}

// ---------------------------------------------------------------------------
// smoke
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log('='.repeat(72));
  console.log('BIG 5 MATRIX — gateway smoke (handlers only, no port)');
  console.log('KNOLL gate: enforced · APEX: sole router · every check flows through APEX');
  console.log('-'.repeat(72));

  // Silence the request logger so smoke output stays clean and greppable.
  const gw = new HopeGateway({ logger: false });
  const q = (s = ''): URLSearchParams => new URLSearchParams(s);

  // 1. Health — always-on trio online, ephemeral idle flags, KNOLL gate enforced.
  {
    const res = await gw.route('GET', '/v1/health', q(), undefined);
    const body = res.body as { ok?: boolean; knollGate?: string; alwaysOn?: unknown[] };
    expect('health', res, 200, [
      ['ok=true', body.ok === true],
      ['knollGate=enforced', body.knollGate === 'enforced'],
      ['alwaysOn has 3 agents', Array.isArray(body.alwaysOn) && body.alwaysOn.length === 3],
    ]);
  }

  // 2. Intent — a confident utterance is interpreted by HOPE and dispatched via APEX.
  {
    const res = await gw.route('POST', '/v1/intent', q(), {
      utterance: 'Please simulate three growth strategies for a new SaaS product.',
    });
    const body = res.body as { accepted?: boolean; voice?: unknown; intent?: unknown };
    expect('intent (confident → dispatched via APEX)', res, 200, [
      ['accepted=true', body.accepted === true],
      ['has voice', body.voice !== undefined],
      ['has intent classification', body.intent !== undefined],
    ]);
  }

  // 2b. Intent — empty utterance is a clean 400 (input validation at the door).
  {
    const res = await gw.route('POST', '/v1/intent', q(), { utterance: '   ' });
    expect('intent (empty → 400)', res, 400);
  }

  // 3. Billing pricing — the public, marketing-ready pricing table (no key, no tenant).
  {
    const res = await gw.route('GET', '/v1/billing/pricing', q(), undefined);
    const body = res.body as { currency?: string; tiers?: unknown[] };
    expect('billing/pricing (public table)', res, 200, [
      ['currency=USD', body.currency === 'USD'],
      ['has tiers', Array.isArray(body.tiers) && body.tiers.length >= 5],
    ]);
  }

  // 3b. Billing estimate — deterministic cost for a hypothetical unit of work.
  {
    const res = await gw.route('GET', '/v1/billing/estimate', q('activeParams=7000000000&durationSec=1'), undefined, {
      'x-hdv-tenant': 'demo',
    });
    const body = res.body as { estimate?: { costUsd?: number }; perTier?: unknown[] };
    expect('billing/estimate (demo tenant)', res, 200, [
      ['has estimate.costUsd', typeof body.estimate?.costUsd === 'number'],
      ['has per-tier comparison', Array.isArray(body.perTier) && body.perTier.length >= 5],
    ]);
  }

  // 4. Waitlist POST — the public launch form target (auth-exempt, rate-limited).
  {
    const email = `smoke+${Date.now()}@hdv.example`;
    const res = await gw.route('POST', '/v1/waitlist', q(), {
      email,
      name: 'Smoke Test',
      company: 'HDV',
      interestedTier: 'PRO',
      useCase: 'prototype smoke',
    }, { 'x-forwarded-for': '203.0.113.9' });
    const body = res.body as { ok?: boolean; created?: boolean; accepted?: boolean; duplicate?: boolean };
    // A brand-new signup is 201 Created; the handler returns 200 for a duplicate (asserted below).
    expect('waitlist POST (public signup)', res, 201, [
      ['created', body.ok === true || body.created === true || body.accepted === true],
    ]);

    // 4b. Idempotent by email — re-signing is a safe 200 (form can be double-submitted).
    const dup = await gw.route('POST', '/v1/waitlist', q(), { email }, { 'x-forwarded-for': '203.0.113.9' });
    const dupBody = dup.body as { duplicate?: boolean };
    expect('waitlist POST (idempotent by email)', dup, 200, [
      ['duplicate=true', dupBody.duplicate === true],
    ]);
  }

  // 5. Worker report — re-ingest a DREAM worker result through APEX (→ KNOLL → HOPE).
  {
    const res = await gw.route('POST', '/v1/worker/report', q(), {
      source: 'DREAM',
      intent: 'growth-simulation-batch',
      data: { workerId: 'smoke-worker-1', scenarios: 3 },
    });
    const body = res.body as { ingested?: boolean; routingStatus?: string };
    expect('worker/report (DREAM → APEX → HOPE)', res, 200, [
      ['ingested=true', body.ingested === true],
      ['routingStatus=SUCCESS', body.routingStatus === 'SUCCESS'],
    ]);

    // 5b. The forbidden DREAM↔VISION direct hand-off is rejected (fail-fast 400; KNOLL also blocks).
    const illegal = await gw.route('POST', '/v1/worker/report', q(), {
      source: 'DREAM',
      destination: 'VISION',
      intent: 'illegal-direct',
    });
    expect('worker/report (DREAM↔VISION forbidden → 400)', illegal, 400);
  }

  // 6. Metrics — observability snapshot reflecting the traffic we just routed via APEX.
  {
    const res = await gw.route('GET', '/v1/metrics', q(), undefined);
    const body = res.body as Record<string, unknown>;
    expect('metrics (JSON snapshot)', res, 200, [
      ['non-empty snapshot', Object.keys(body).length > 0],
    ]);

    // 6b. Prometheus exposition variant (text body).
    const prom = await gw.route('GET', '/v1/metrics', q('format=prometheus'), undefined);
    expect('metrics (prometheus text)', prom, 200, [
      ['has text body', typeof prom.text === 'string' && prom.text.length > 0],
    ]);
  }

  // 7. Matrix stats — node/persona topology + parameter accounting.
  {
    const res = await gw.route('GET', '/v1/matrix/stats', q(), undefined);
    const body = res.body as { topology?: { totalNodes?: number }; parameters?: unknown };
    expect('matrix/stats (topology + params)', res, 200, [
      ['totalNodes=20480', body.topology?.totalNodes === 20480],
      ['has parameter accounting', body.parameters !== undefined],
    ]);
  }

  // 8. Ledger + audit — read-only projections of billing and KNOLL verdicts.
  {
    const ledger = await gw.route('GET', '/v1/ledger', q(), undefined);
    expect('ledger (read-only)', ledger, 200, [
      ['has entries array', Array.isArray((ledger.body as { entries?: unknown[] }).entries)],
    ]);
    const audit = await gw.route('GET', '/v1/audit', q(), undefined);
    const auditBody = audit.body as { allowed?: number; entries?: unknown[] };
    expect('audit (KNOLL verdicts, read-only)', audit, 200, [
      ['has entries array', Array.isArray(auditBody.entries)],
      ['recorded ≥1 ALLOWED verdict', (auditBody.allowed ?? 0) >= 1],
    ]);
  }

  // 9. Unknown route is a clean 404 (front door doesn't leak).
  {
    const res = await gw.route('GET', '/v1/does-not-exist', q(), undefined);
    expect('unknown route → 404', res, 404);
  }

  console.log('-'.repeat(72));
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`smoke: ${passed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);
  console.log('='.repeat(72));
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('smoke crashed:', err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
