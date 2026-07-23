/**
 * tests/market.test.ts — launch GTM surfaces: waitlist (market/) + Stripe checkout stub.
 *
 * Coverage:
 *   A. WaitlistStore — validation, email normalisation, dedup/idempotency, caps, stats.
 *   B. Waitlist handlers — request shaping, status codes (201 new / 200 duplicate / 400 bad).
 *   C. Gateway integration (real HTTP) — POST /v1/waitlist is PUBLIC (auth-exempt) but still
 *      rate-limited; GET /v1/waitlist/stats is PROTECTED (401 without key, 200 with key); stats
 *      never leak individual emails.
 *   D. StripeCheckoutStub — test/live modes, amounts (monthly/annual), settle, invalid input.
 *
 * Run: npm run test:market   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import {
  WaitlistStore,
  handleWaitlistSignup,
  handleWaitlistStats,
  normaliseEmail,
  WaitlistValidationError,
} from '../market/index.js';
import { HopeGateway } from '../gateway/index.js';
import {
  StripeCheckoutStub,
  StripeStubError,
  DEFAULT_MONTHLY_PRICE_USD,
} from '../billing/stripe_stub.js';

const KEY = 'launch-secret-key-xyz';

async function withServer(gw: HopeGateway, fn: (base: string) => Promise<void>): Promise<void> {
  const server = await gw.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// ---------------------------------------------------------------------------
// A. WaitlistStore
// ---------------------------------------------------------------------------

test('normaliseEmail trims + lower-cases and rejects garbage', () => {
  assert.equal(normaliseEmail('  Founder@Example.COM '), 'founder@example.com');
  assert.throws(() => normaliseEmail('not-an-email'), WaitlistValidationError);
  assert.throws(() => normaliseEmail(''), WaitlistValidationError);
  assert.throws(() => normaliseEmail(42 as unknown), WaitlistValidationError);
});

test('WaitlistStore records a new signup with a public entry (no ip leaked)', () => {
  const store = new WaitlistStore();
  const res = store.add({ email: 'A@B.com', name: 'Ada', source: 'marketing', ip: '203.0.113.7' });
  assert.equal(res.created, true);
  assert.equal(res.duplicate, false);
  assert.equal(res.position, 1);
  assert.equal(res.entry.email, 'a@b.com');
  assert.equal(res.entry.source, 'marketing');
  assert.ok(res.entry.id.startsWith('wl_'));
  assert.equal((res.entry as unknown as Record<string, unknown>).ip, undefined);
  assert.equal(store.size(), 1);
  assert.equal(store.has('a@b.com'), true);
});

test('WaitlistStore dedups by normalised email (idempotent re-signup enriches)', () => {
  const store = new WaitlistStore();
  const first = store.add({ email: 'dup@x.com', source: 'marketing' });
  const second = store.add({ email: 'DUP@X.com', company: 'Acme', interestedTier: 'pro' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.size(), 1);
  // Enrichment filled the previously-empty company + tier without a second row.
  assert.equal(second.entry.company, 'Acme');
  assert.equal(second.entry.interestedTier, 'PRO');
});

test('WaitlistStore normalises unknown source to "other" and caps text length', () => {
  const store = new WaitlistStore();
  const res = store.add({ email: 'z@z.com', source: 'twitter-ads' });
  assert.equal(res.entry.source, 'other');
  assert.throws(() => store.add({ email: 'long@z.com', useCase: 'x'.repeat(600) }), WaitlistValidationError);
});

test('WaitlistStore enforces maxEntries for NEW emails only', () => {
  const store = new WaitlistStore({ maxEntries: 2 });
  store.add({ email: 'one@x.com' });
  store.add({ email: 'two@x.com' });
  // Existing supporter still succeeds (idempotent) even when full…
  assert.equal(store.add({ email: 'one@x.com' }).duplicate, true);
  // …but a brand-new email is rejected.
  assert.throws(() => store.add({ email: 'three@x.com' }), /full/);
});

test('WaitlistStore.stats is aggregate + time-bucketed and privacy-safe', () => {
  const store = new WaitlistStore();
  const now = 1_000_000_000_000;
  store.add({ email: 'a@x.com', source: 'marketing', interestedTier: 'PRO', at: now });
  store.add({ email: 'b@x.com', source: 'marketing', interestedTier: 'PRO', at: now - 2 * 24 * 60 * 60 * 1000 });
  store.add({ email: 'c@x.com', source: 'referral', at: now - 30 * 24 * 60 * 60 * 1000 });
  const stats = store.stats(now);
  assert.equal(stats.total, 3);
  assert.equal(stats.bySource.marketing, 2);
  assert.equal(stats.bySource.referral, 1);
  assert.equal(stats.byTier.PRO, 2);
  assert.equal(stats.last24h, 1);
  assert.equal(stats.last7d, 2);
  assert.equal(stats.firstAt, now - 30 * 24 * 60 * 60 * 1000);
  assert.equal(stats.lastAt, now);
  // No field in stats should carry a raw email.
  assert.equal(JSON.stringify(stats).includes('@'), false);
});

// ---------------------------------------------------------------------------
// B. Handlers
// ---------------------------------------------------------------------------

test('handleWaitlistSignup returns 201 for new, 200 for duplicate, 400 for bad input', () => {
  const store = new WaitlistStore();
  const created = handleWaitlistSignup(store, { email: 'new@x.com' });
  assert.equal(created.status, 201);
  assert.equal(created.body.created, true);

  const dup = handleWaitlistSignup(store, { email: 'new@x.com' });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);

  const bad = handleWaitlistSignup(store, { email: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'invalid_signup');

  const notObject = handleWaitlistSignup(store, 'oops');
  assert.equal(notObject.status, 400);
});

test('handleWaitlistStats returns aggregate counts only', () => {
  const store = new WaitlistStore();
  store.add({ email: 'a@x.com', source: 'marketing' });
  const res = handleWaitlistStats(store);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
});

// ---------------------------------------------------------------------------
// C. Gateway integration (real HTTP)
// ---------------------------------------------------------------------------

test('POST /v1/waitlist is PUBLIC even when an API key is configured', async () => {
  const gw = new HopeGateway({ security: { apiKey: KEY }, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'founder@example.com', source: 'marketing' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { ok: boolean; created: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.created, true);
    assert.equal(gw.waitlist.size(), 1);
  });
});

test('GET /v1/waitlist/stats is PROTECTED (401 without key, 200 with key)', async () => {
  const gw = new HopeGateway({ security: { apiKey: KEY }, logger: false });
  await withServer(gw, async (base) => {
    await fetch(`${base}/v1/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@x.com' }),
    });

    const noKey = await fetch(`${base}/v1/waitlist/stats`);
    assert.equal(noKey.status, 401);

    const withKey = await fetch(`${base}/v1/waitlist/stats`, { headers: { 'X-HDV-Key': KEY } });
    assert.equal(withKey.status, 200);
    const stats = (await withKey.json()) as { total: number };
    assert.equal(stats.total, 1);
  });
});

test('POST /v1/waitlist is still RATE-LIMITED (public ≠ unlimited)', async () => {
  const gw = new HopeGateway({ security: { apiKey: KEY, rateLimit: 3 }, logger: false });
  await withServer(gw, async (base) => {
    const post = (email: string) =>
      fetch(`${base}/v1/waitlist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    assert.equal((await post('r1@x.com')).status, 201);
    assert.equal((await post('r2@x.com')).status, 201);
    assert.equal((await post('r3@x.com')).status, 201);
    const limited = await post('r4@x.com');
    assert.equal(limited.status, 429);
  });
});

test('POST /v1/waitlist rejects a malformed email with 400', async () => {
  const gw = new HopeGateway({ logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'invalid_signup');
  });
});

// ---------------------------------------------------------------------------
// D. Stripe checkout stub
// ---------------------------------------------------------------------------

test('StripeCheckoutStub defaults to TEST mode with no key (cs_test_ ids)', () => {
  const stripe = new StripeCheckoutStub({ env: {} });
  assert.equal(stripe.livemode, false);
  assert.equal(stripe.configured, false);
  const session = stripe.createCheckoutSession({ tier: 'PRO', tenantId: 'acme', customerEmail: 'a@acme.com' });
  assert.ok(session.id.startsWith('cs_test_'));
  assert.ok(session.url.includes(session.id));
  assert.equal(session.livemode, false);
  assert.equal(session.tier, 'PRO');
  assert.equal(session.amountTotalUsd, DEFAULT_MONTHLY_PRICE_USD.PRO);
  assert.equal(session.amountTotal, DEFAULT_MONTHLY_PRICE_USD.PRO * 100);
  assert.equal(session.metadata.tenantId, 'acme');
  assert.equal(session.paymentStatus, 'unpaid');
});

test('StripeCheckoutStub reflects LIVE shape with an sk_live_ key (cs_live_ ids)', () => {
  const stripe = new StripeCheckoutStub({ secretKey: 'sk_live_abc123' });
  assert.equal(stripe.livemode, true);
  assert.equal(stripe.configured, true);
  const session = stripe.createCheckoutSession({ tier: 'STARTER' });
  assert.ok(session.id.startsWith('cs_live_'));
  assert.equal(session.livemode, true);
});

test('StripeCheckoutStub: FREE tier needs no payment; annual applies the 10-month convention', () => {
  const stripe = new StripeCheckoutStub({ env: {} });
  const free = stripe.createCheckoutSession({ tier: 'FREE' });
  assert.equal(free.amountTotal, 0);
  assert.equal(free.paymentStatus, 'no_payment_required');

  const annual = stripe.createCheckoutSession({ tier: 'PRO', interval: 'year', quantity: 2 });
  assert.equal(annual.interval, 'year');
  assert.equal(annual.quantity, 2);
  assert.equal(annual.amountTotalUsd, DEFAULT_MONTHLY_PRICE_USD.PRO * 10 * 2);
});

test('StripeCheckoutStub: retrieve + settle a session, and honor custom redirect URLs', () => {
  const stripe = new StripeCheckoutStub({ env: {}, baseUrl: 'https://hdv.test/' });
  const session = stripe.createCheckoutSession({
    tier: 'STARTER',
    successUrl: 'https://app.example.com/ok',
    cancelUrl: 'https://app.example.com/no',
  });
  assert.equal(session.successUrl, 'https://app.example.com/ok');
  assert.equal(session.cancelUrl, 'https://app.example.com/no');

  assert.equal(stripe.retrieveSession(session.id)?.id, session.id);
  const paid = stripe.markSessionPaid(session.id);
  assert.equal(paid?.status, 'complete');
  assert.equal(paid?.paymentStatus, 'paid');
  assert.equal(stripe.markSessionPaid('cs_test_unknown'), undefined);
});

test('StripeCheckoutStub synthesizes redirect URLs from baseUrl when omitted', () => {
  const stripe = new StripeCheckoutStub({ env: {}, baseUrl: 'https://hdv.test' });
  const session = stripe.createCheckoutSession({ tier: 'PRO' });
  assert.ok(session.successUrl.startsWith('https://hdv.test/billing/success?session_id=cs_test_'));
  assert.equal(session.cancelUrl, 'https://hdv.test/billing/cancel');
});

test('StripeCheckoutStub rejects unknown tiers and bad quantities', () => {
  const stripe = new StripeCheckoutStub({ env: {} });
  assert.throws(() => stripe.createCheckoutSession({ tier: 'PLATINUM' }), StripeStubError);
  assert.throws(() => stripe.createCheckoutSession({ tier: 'PRO', quantity: 0 }), StripeStubError);
});
