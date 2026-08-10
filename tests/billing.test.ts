/**
 * tests/billing.test.ts — PRODUCT metering layer tests (node:test).
 *
 * Covers the billing package WITHOUT regressing any constitutional invariant:
 *   - PricingBook loads config/pricing.json, prices active-param-seconds, and switches to the
 *     overage rate once the included allowance is spent; BYOK is $0 pass-through.
 *   - AllowanceAccount/Store: consume within the cap, REJECT over the hard cap, BYOK unlimited
 *     ($0 platform fee), occurrence-log shape, default `demo` tenant seeded offline.
 *   - MeterService attributes live APEX dispatch to a tenant (estimate + ledger fallback) and
 *     never throws into the transport.
 *   - Gateway /v1/billing/* over real HTTP: public pricing, usage, estimate, set-allowance,
 *     and that metered APEX traffic shows up on the `demo` tenant's balance.
 *
 * Run: npm run test:billing   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import {
  loadPricingBook,
  PricingBook,
  AllowanceStore,
  MeterService,
  PLAN_TIERS,
  isPlanTier,
} from '../billing/index.js';
import { ApexOrchestrator } from '../apex/index.js';
import { AgentRole } from '../config/routing_schema.js';
import { MODEL_PARAMS } from '../nodes/index.js';
import { HopeGateway } from '../gateway/index.js';

const ONE_PERSONA = MODEL_PARAMS; // 7e9 active params

function pricing(): PricingBook {
  return loadPricingBook();
}

// ---------------------------------------------------------------------------
// A. PricingBook
// ---------------------------------------------------------------------------

test('PricingBook loads config/pricing.json with all five tiers', () => {
  const book = pricing();
  assert.equal(book.currency, 'USD');
  for (const tier of PLAN_TIERS) {
    const p = book.tier(tier);
    assert.equal(p.tier, tier);
    assert.ok(p.displayName.length > 0);
    assert.ok(p.tagline.length > 0);
  }
});

test('estimate prices per-request + active-param-seconds at the included rate', () => {
  const book = pricing();
  const p = book.tier('STARTER');
  const est = book.estimate({ tier: 'STARTER', activeParams: ONE_PERSONA, durationSec: 1, priorSpendUsd: 0 });
  const expected = p.pricePerRequest + (ONE_PERSONA * 1) / 1_000_000 * p.pricePerMillionActiveParamSeconds;
  assert.equal(est.rate, 'included');
  assert.ok(Math.abs(est.costUsd - expected) < 1e-9, `cost ${est.costUsd} ≈ ${expected}`);
  assert.equal(est.activeParamSeconds, ONE_PERSONA);
  assert.equal(est.activePersonaSeconds, 1);
});

test('estimate switches to the overage rate once the included allowance is spent', () => {
  const book = pricing();
  const p = book.tier('STARTER');
  const over = book.estimate({ tier: 'STARTER', activeParams: ONE_PERSONA, durationSec: 1, priorSpendUsd: p.includedAllowanceUsd + 1 });
  assert.equal(over.rate, 'overage');
  assert.equal(over.ratePerMillionActiveParamSeconds, p.overageRatePerMillionActiveParamSeconds);
});

test('BYOK estimate is $0 platform fee (pass-through)', () => {
  const book = pricing();
  const est = book.estimate({ tier: 'BYOK', activeParams: ONE_PERSONA * 1000, durationSec: 60 });
  assert.equal(est.rate, 'byok');
  assert.equal(est.costUsd, 0);
});

test('publicTable exposes marketing rows with derived persona-hours', () => {
  const table = pricing().publicTable();
  assert.equal(table.tiers.length, PLAN_TIERS.length);
  const pro = table.tiers.find((t) => t.tier === 'PRO');
  assert.ok(pro);
  assert.ok((pro!.includedPersonaHours ?? 0) > 0, 'PRO advertises included persona-hours');
  const byok = table.tiers.find((t) => t.tier === 'BYOK');
  assert.equal(byok!.hardCapUsd, null, 'BYOK is uncapped');
  assert.equal(byok!.includedPersonaHours, null, 'BYOK has no metered inclusion');
});

// ---------------------------------------------------------------------------
// B. AllowanceAccount / AllowanceStore
// ---------------------------------------------------------------------------

test('store seeds an offline demo tenant that consumes in-memory', () => {
  const store = new AllowanceStore(pricing());
  assert.ok(store.has('demo'));
  const res = store.consume('demo', { activeParams: ONE_PERSONA, durationSec: 1, kind: 'SIMULATION', model: '7B' });
  assert.equal(res.accepted, true);
  assert.ok(res.costUsd > 0);
  assert.equal(res.balance.spentUsd, res.costUsd);
  assert.equal(res.balance.acceptedCount, 1);
});

test('occurrence log carries the required cost + occurrence fields', () => {
  const store = new AllowanceStore(pricing());
  store.consume('acme', { activeParams: ONE_PERSONA, durationSec: 2, kind: 'EXECUTION', provider: 'big5-matrix', model: '7B' });
  const [occ] = store.recentOccurrences('acme', 1);
  assert.ok(occ);
  assert.equal(typeof occ.at, 'number');
  assert.equal(occ.kind, 'EXECUTION');
  assert.equal(occ.activeParams, ONE_PERSONA);
  assert.equal(occ.durationSec, 2);
  assert.equal(occ.activeParamSeconds, ONE_PERSONA * 2);
  assert.ok(occ.costUsd > 0);
  assert.equal(occ.provider, 'big5-matrix');
  assert.equal(occ.model, '7B');
  assert.equal(occ.accepted, true);
});

test('consume REJECTS work that would breach the hard cap (logged, not billed)', () => {
  const store = new AllowanceStore(pricing());
  store.setAllowance('tight', { tier: 'STARTER', includedAllowanceUsd: 0.001, hardCapUsd: 0.001 });
  const res = store.consume('tight', { activeParams: ONE_PERSONA, durationSec: 1 });
  assert.equal(res.accepted, false);
  assert.match(res.reason ?? '', /hard cap/i);
  const bal = store.balance('tight');
  assert.equal(bal.spentUsd, 0, 'rejected occurrence never adds to spend');
  assert.equal(bal.rejectedCount, 1);
  assert.equal(bal.occurrenceCount, 1, 'rejection is still logged for visibility');
});

test('BYOK tenant is unlimited with a $0 platform fee and is never rejected', () => {
  const store = new AllowanceStore(pricing());
  store.setAllowance('byok-co', { tier: 'BYOK' });
  const res = store.consume('byok-co', { activeParams: ONE_PERSONA * 100000, durationSec: 3600 });
  assert.equal(res.accepted, true);
  assert.equal(res.costUsd, 0, 'BYOK platform fee is $0');
  const bal = store.balance('byok-co');
  assert.equal(bal.byok, true);
  assert.equal(bal.hardCapUsd, null, 'BYOK is uncapped');
  assert.equal(bal.remainingUsd, null);
  assert.equal(bal.spentUsd, 0);
});

test('setAllowance can raise the hard cap to unlock previously-blocked usage', () => {
  const store = new AllowanceStore(pricing());
  store.setAllowance('grow', { tier: 'STARTER', hardCapUsd: 0.001 });
  assert.equal(store.consume('grow', { activeParams: ONE_PERSONA, durationSec: 1 }).accepted, false);
  store.setAllowance('grow', { hardCapUsd: 100 });
  assert.equal(store.consume('grow', { activeParams: ONE_PERSONA, durationSec: 1 }).accepted, true);
});

test('isPlanTier guards the tier vocabulary', () => {
  assert.ok(isPlanTier('PRO'));
  assert.ok(!isPlanTier('pro'));
  assert.ok(!isPlanTier('PLATINUM'));
});

// ---------------------------------------------------------------------------
// C. MeterService (APEX dispatch observer)
// ---------------------------------------------------------------------------

test('MeterService attributes successful APEX dispatch to a tenant', () => {
  const store = new AllowanceStore(pricing(), { seedDemo: true, demoTier: 'PRO' });
  const meter = new MeterService({ store, tenantId: 'demo', personasPerDispatch: 1 });

  const orchestrator = new ApexOrchestrator({ defaultCostUsd: 0.02, observer: meter.observer() });
  orchestrator.wire({
    dream: () => ({ outcome: 'scenarios rendered' }),
    vision: () => ({ executed: true }),
  });

  // HOPE → APEX → DREAM (two SUCCESS dispatches: the APEX forward + the DREAM execution).
  orchestrator.submit({
    source: AgentRole.HOPE,
    destination: AgentRole.APEX,
    intent: 'simulate outcomes',
    data: { suggestedDestination: AgentRole.DREAM },
  });

  const stats = meter.stats();
  assert.ok(stats.metered >= 2, `metered ${stats.metered} dispatches`);
  assert.ok(stats.estimated >= 1, 'at least the DREAM execution priced via persona estimate');
  assert.ok(stats.fallback >= 1, 'non-ephemeral APEX forward priced via ledger fallback');
  assert.ok(store.balance('demo').spentUsd > 0);
});

test('MeterService only meters SUCCESS and never throws into the transport', () => {
  const store = new AllowanceStore(pricing());
  const meter = new MeterService({ store, tenantId: 'demo' });
  const orchestrator = new ApexOrchestrator({ observer: meter.observer() });
  // Illegal direct DREAM → VISION: KNOLL BLOCKS it. Routing must be unaffected by metering.
  const res = orchestrator.sendViaApex({ source: AgentRole.DREAM, destination: AgentRole.VISION, intent: 'sneaky' });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(meter.stats().skipped, 1, 'a blocked dispatch is skipped, not billed');
  assert.equal(meter.stats().metered, 0);
});

test('a throwing allowance store cannot break routing via the meter observer', () => {
  const store = pricing();
  const brokenStore = new AllowanceStore(store);
  // Monkey-patch consume to throw; the observer must swallow it.
  (brokenStore as unknown as { consume: () => never }).consume = () => {
    throw new Error('boom');
  };
  const meter = new MeterService({ store: brokenStore, tenantId: 'demo' });
  const orchestrator = new ApexOrchestrator({ observer: meter.observer() });
  orchestrator.wire({ dream: () => ({ ok: true }) });
  const res = orchestrator.sendViaApex({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'render' });
  assert.equal(res.status, 'SUCCESS', 'routing succeeds even though metering threw');
});

// ---------------------------------------------------------------------------
// D. Gateway /v1/billing/* over real HTTP
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

test('GET /v1/billing/pricing is public (no key required) and returns the table', async () => {
  const gw = new HopeGateway({ security: { apiKey: 'k' }, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/billing/pricing`);
    assert.equal(res.status, 200, 'pricing is auth-exempt');
    const body = (await res.json()) as { tiers: Array<{ tier: string }> };
    assert.equal(body.tiers.length, PLAN_TIERS.length);
  });
});

test('GET /v1/billing/usage reflects metered APEX traffic for the demo tenant', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    const submit = await fetch(`${base}/v1/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ utterance: 'simulate three outcomes for launching the product early' }),
    });
    assert.equal(submit.status, 200);

    const usage = await fetch(`${base}/v1/billing/usage`, { headers: { 'X-HDV-Tenant': 'demo' } });
    assert.equal(usage.status, 200);
    const body = (await usage.json()) as {
      tenantId: string;
      balance: { spentUsd: number; occurrenceCount: number };
      meter: { metered: number };
      occurrences: unknown[];
    };
    assert.equal(body.tenantId, 'demo');
    assert.ok(body.meter.metered > 0, 'gateway meter saw APEX traffic');
    assert.ok(body.balance.spentUsd > 0, 'demo tenant was billed');
    assert.ok(body.occurrences.length > 0);
  });
});

test('GET /v1/billing/estimate accepts a JSON body and returns a per-tier comparison', async () => {
  // node's fetch refuses to send a GET body, so exercise the body path through route() directly
  // (the server DOES read a GET body when a client is able to send one — see serve()).
  const gw = new HopeGateway({ logger: false });
  const res = await gw.route(
    'GET',
    '/v1/billing/estimate',
    new URLSearchParams(),
    { activeParams: ONE_PERSONA, durationSec: 10, model: '7B' },
    { 'x-hdv-tenant': 'demo' },
  );
  assert.equal(res.status, 200);
  const body = res.body as unknown as { model: string; estimate: { costUsd: number }; perTier: Array<{ tier: string; costUsd: number }> };
  assert.equal(body.model, '7B');
  assert.equal(body.perTier.length, PLAN_TIERS.length);
  const byok = body.perTier.find((t) => t.tier === 'BYOK');
  assert.equal(byok!.costUsd, 0);
});

test('GET /v1/billing/estimate also accepts query params (GET-body-averse clients)', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/billing/estimate?activeParams=${ONE_PERSONA}&durationSec=5&tier=PRO`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tier: string; estimate: { costUsd: number } };
    assert.equal(body.tier, 'PRO');
    assert.ok(body.estimate.costUsd > 0);
  });

  const gw2 = new HopeGateway({ logger: false });
  await withServer(gw2, async (base) => {
    const bad = await fetch(`${base}/v1/billing/estimate?durationSec=5`);
    assert.equal(bad.status, 400, 'missing activeParams → 400');
  });
});

test('POST /v1/billing/allowance sets a tenant plan; over-cap consume is then blocked', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    const set = await fetch(`${base}/v1/billing/allowance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HDV-Tenant': 'startup' },
      body: JSON.stringify({ tier: 'STARTER', hardCapUsd: 0.001 }),
    });
    assert.equal(set.status, 200);
    const setBody = (await set.json()) as { ok: boolean; balance: { tier: string; hardCapUsd: number } };
    assert.equal(setBody.ok, true);
    assert.equal(setBody.balance.tier, 'STARTER');
    assert.equal(setBody.balance.hardCapUsd, 0.001);

    // Directly exercise the store-backed enforcement for this tenant.
    const res = gw.billing.store.consume('startup', { activeParams: ONE_PERSONA, durationSec: 1 });
    assert.equal(res.accepted, false);

    const bad = await fetch(`${base}/v1/billing/allowance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HDV-Tenant': 'startup' },
      body: JSON.stringify({ tier: 'PLATINUM' }),
    });
    assert.equal(bad.status, 400, 'unknown tier rejected');
  });
});

// ---------------------------------------------------------------------------
// D. Checkout (billing/stripe_stub.ts + gateway wiring)
// ---------------------------------------------------------------------------

test('POST /v1/billing/checkout is public (no key needed) and returns a test-mode session', async () => {
  const gw = new HopeGateway({ security: { apiKey: 'secret-key', rateLimit: 20 }, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/billing/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HDV-Tenant': 'browser-abc' },
      body: JSON.stringify({ tier: 'STARTER' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessionId: string; url: string; livemode: boolean };
    assert.ok(body.sessionId.startsWith('cs_test_'));
    assert.ok(body.url.includes(body.sessionId));
    assert.equal(body.livemode, false);

    // A protected route on the SAME gateway still requires the key, proving auth isn't globally off.
    const protectedRes = await fetch(`${base}/v1/matrix/stats`);
    assert.equal(protectedRes.status, 401);
  });
});

test('POST /v1/billing/checkout rejects an unknown tier with 400', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/billing/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'PLATINUM' }),
    });
    assert.equal(res.status, 400);
  });
});

test('GET /v1/billing/checkout looks up a session by id; unknown id is 404', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    const created = await fetch(`${base}/v1/billing/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'PRO' }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };

    const found = await fetch(`${base}/v1/billing/checkout?session_id=${sessionId}`);
    assert.equal(found.status, 200);
    const foundBody = (await found.json()) as { session: { status: string; tier: string } };
    assert.equal(foundBody.session.status, 'open');
    assert.equal(foundBody.session.tier, 'PRO');

    const missing = await fetch(`${base}/v1/billing/checkout?session_id=cs_test_does_not_exist`);
    assert.equal(missing.status, 404);
  });
});

test('POST /v1/billing/checkout/settle marks the session paid and upgrades the tenant allowance', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    const created = await fetch(`${base}/v1/billing/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HDV-Tenant': 'browser-xyz' },
      body: JSON.stringify({ tier: 'PRO' }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };

    const settled = await fetch(`${base}/v1/billing/checkout/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    assert.equal(settled.status, 200);
    const settledBody = (await settled.json()) as { ok: boolean; tenantId: string; balance: { tier: string } };
    assert.equal(settledBody.ok, true);
    assert.equal(settledBody.tenantId, 'browser-xyz');
    assert.equal(settledBody.balance.tier, 'PRO');

    // The tenant's balance is really upgraded, independently readable via /v1/billing/usage.
    const usage = await fetch(`${base}/v1/billing/usage`, { headers: { 'X-HDV-Tenant': 'browser-xyz' } });
    const usageBody = (await usage.json()) as { balance: { tier: string } };
    assert.equal(usageBody.balance.tier, 'PRO');
  });
});

test('POST /v1/billing/checkout/settle 404s for an unknown session id', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/billing/checkout/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cs_test_does_not_exist' }),
    });
    assert.equal(res.status, 404);
  });
});
