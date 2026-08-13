/**
 * tests/creator_gateway.test.ts — creator marketplace HTTP integration (gateway/server.ts).
 *
 * Coverage:
 *   A. Every /v1/creator/* route requires a valid X-HDV-Session (401 otherwise). Unlike the
 *      product routes gated by companion/chat's tenant-rate-limit posture, these ARE in
 *      AUTH_EXEMPT_PATHS (same reasoning as auth/signup) — a valid session is sufficient even
 *      when an operator API key is configured, since fucklike.me's whole premise is a member
 *      of the public (with no relationship to the operator) signing up as a creator.
 *   B. Happy-path flow: signup → apply → submit a persona → GET earnings (starts at 0).
 *   C. POST /v1/creator/persona 409s when personaId is already claimed by another creator.
 *   D. End-to-end usage attribution: a real-provider companion chat turn using a creator's
 *      personaId (as companionId) accrues earnings — proving the fire-and-forget wiring into
 *      companion/handlers.ts actually works over real HTTP, not just in isolation.
 *   E. POST /v1/creator/verification + POST /v1/creator/payout — payout ALWAYS 403s (THE safety
 *      gate), even after requesting verification and even with a large accrued balance.
 *   F. POST /v1/creator/webhooks/stripe wiring over REAL HTTP: reachable with NO
 *      X-HDV-Session/HDV_API_KEY even when an operator key is configured (it's auth-exempt, but
 *      gated by Stripe's signature instead); 503s when the gateway's payout provider is the
 *      default stub (Stripe not configured); and, with a live provider (fake stripeClient — no
 *      real network) injected, proves the RAW request body actually reaches
 *      stripe.webhooks.constructEvent unmodified end-to-end through node:http.
 *
 * Run: node --import tsx --test tests/creator_gateway.test.ts   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type Stripe from 'stripe';

import { CreatorPayoutStripeLive } from '../creator/index.js';
import { InMemoryCreatorProfileRepository } from '../persistence/index.js';

import { HopeGateway } from '../gateway/index.js';
import type { CompleteOptions, CompletionResult, LlmProvider } from '../providers/types.js';

async function withServer(gw: HopeGateway, fn: (base: string) => Promise<void>): Promise<void> {
  const server = await gw.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  async complete(_prompt: string, _opts?: CompleteOptions): Promise<CompletionResult> {
    return {
      text: 'a real, in-character reply',
      model: this.model,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
}

async function signupAndGetSession(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const body = (await res.json()) as { sessionToken: string };
  return body.sessionToken;
}

// ---------------------------------------------------------------------------
// A. Auth requirements
// ---------------------------------------------------------------------------

test('every POST/GET /v1/creator/* route 401s without a valid X-HDV-Session', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 1000, authRateLimit: 1000 }, logger: false });
  await withServer(gw, async (base) => {
    const noSession = await fetch(`${base}/v1/creator/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Jordyn' }),
    });
    assert.equal(noSession.status, 401);

    const badSession = await fetch(`${base}/v1/creator/earnings`, {
      headers: { 'X-HDV-Session': 'not-a-real-token' },
    });
    assert.equal(badSession.status, 401);

    const persona = await fetch(`${base}/v1/creator/persona`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personaId: 'jordyn', displayName: 'Jordyn' }),
    });
    assert.equal(persona.status, 401);

    const verification = await fetch(`${base}/v1/creator/verification`, { method: 'POST' });
    assert.equal(verification.status, 401);

    const payout = await fetch(`${base}/v1/creator/payout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountUsd: 5 }),
    });
    assert.equal(payout.status, 401);
  });
});

test('/v1/creator/* routes ARE auth-exempt: a valid session alone is enough even with an operator API key configured', async () => {
  const gw = new HopeGateway({
    security: { apiKey: 'operator-secret', rateLimit: 1000, authRateLimit: 1000 },
    logger: false,
  });
  await withServer(gw, async (base) => {
    // Signup/login themselves are auth-exempt from the API key, so this still works with no key.
    const sessionToken = await signupAndGetSession(base, 'creator.noKey@example.com');

    // Valid session, NO operator API key — succeeds. A member of the public signing up as a
    // creator has no way to ever know the operator's private key, and shouldn't need to.
    const noKey = await fetch(`${base}/v1/creator/earnings`, {
      headers: { 'X-HDV-Session': sessionToken },
    });
    assert.equal(noKey.status, 200);

    // The operator key is also accepted alongside the session (harmless, not required).
    const withKey = await fetch(`${base}/v1/creator/earnings`, {
      headers: { 'X-HDV-Session': sessionToken, 'X-HDV-Key': 'operator-secret' },
    });
    assert.equal(withKey.status, 200);

    // Still 401 with no session at all, key or not — the session check itself is unaffected.
    const noSession = await fetch(`${base}/v1/creator/earnings`, {
      headers: { 'X-HDV-Key': 'operator-secret' },
    });
    assert.equal(noSession.status, 401);
  });
});

// ---------------------------------------------------------------------------
// B. Happy-path flow
// ---------------------------------------------------------------------------

test('POST /v1/creator/apply → POST /v1/creator/persona → GET /v1/creator/earnings (starts at 0)', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 1000, authRateLimit: 1000 }, logger: false });
  await withServer(gw, async (base) => {
    const sessionToken = await signupAndGetSession(base, 'creator.happy@example.com');
    const headers = { 'content-type': 'application/json', 'X-HDV-Session': sessionToken };

    const apply = await fetch(`${base}/v1/creator/apply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ displayName: 'Jordyn', bio: 'I make content.' }),
    });
    assert.equal(apply.status, 200);
    const applyBody = (await apply.json()) as { profile: { displayName: string; verificationStatus: string } };
    assert.equal(applyBody.profile.displayName, 'Jordyn');
    assert.equal(applyBody.profile.verificationStatus, 'unverified');

    const persona = await fetch(`${base}/v1/creator/persona`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        personaId: 'jordyn-happy',
        displayName: 'Jordyn',
        referencePhotoUrls: ['https://cdn.example.com/a.jpg'],
      }),
    });
    assert.equal(persona.status, 200);
    const personaBody = (await persona.json()) as { persona: { personaId: string } };
    assert.equal(personaBody.persona.personaId, 'jordyn-happy');

    const earnings = await fetch(`${base}/v1/creator/earnings`, { headers });
    assert.equal(earnings.status, 200);
    const earningsBody = (await earnings.json()) as { accruedUsd: number; payoutAvailable: boolean };
    assert.equal(earningsBody.accruedUsd, 0);
    assert.equal(earningsBody.payoutAvailable, false);
  });
});

// ---------------------------------------------------------------------------
// C. personaId conflict
// ---------------------------------------------------------------------------

test('POST /v1/creator/persona 409s when personaId is already claimed by a different creator', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 1000, authRateLimit: 1000 }, logger: false });
  await withServer(gw, async (base) => {
    const sessionA = await signupAndGetSession(base, 'creator.a@example.com');
    const sessionB = await signupAndGetSession(base, 'creator.b@example.com');

    const first = await fetch(`${base}/v1/creator/persona`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HDV-Session': sessionA },
      body: JSON.stringify({ personaId: 'shared-id', displayName: 'Creator A' }),
    });
    assert.equal(first.status, 200);

    const conflict = await fetch(`${base}/v1/creator/persona`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HDV-Session': sessionB },
      body: JSON.stringify({ personaId: 'shared-id', displayName: 'Creator B' }),
    });
    assert.equal(conflict.status, 409);
    const body = (await conflict.json()) as { code: string };
    assert.equal(body.code, 'persona_id_taken');
  });
});

// ---------------------------------------------------------------------------
// D. End-to-end usage attribution
// ---------------------------------------------------------------------------

test('a real-provider companion chat turn using a creator persona accrues earnings end-to-end', async () => {
  const gw = new HopeGateway({
    security: { rateLimit: 1000, authRateLimit: 1000 },
    provider: new FakeProvider(),
    logger: false,
  });
  await withServer(gw, async (base) => {
    const sessionToken = await signupAndGetSession(base, 'creator.earner@example.com');
    const headers = { 'content-type': 'application/json', 'X-HDV-Session': sessionToken };

    await fetch(`${base}/v1/creator/apply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ displayName: 'Jordyn' }),
    });
    await fetch(`${base}/v1/creator/persona`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ personaId: 'jordyn-earns', displayName: 'Jordyn' }),
    });

    // companionId is the SAME id space as personaId (see creator/types.ts) — the client uses
    // the creator's persona slug as the chat companionId to attribute the turn.
    const chat = await fetch(`${base}/v1/companion/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        persona: { name: 'Jordyn', age: 24 },
        message: 'hey there',
        companionId: 'jordyn-earns',
      }),
    });
    assert.equal(chat.status, 200);
    const chatBody = (await chat.json()) as { source: string };
    assert.equal(chatBody.source, 'llm', 'must be a REAL provider reply for usage to accrue');

    // Fire-and-forget: give the event loop a tick before reading earnings back.
    await new Promise((r) => setImmediate(r));

    const earnings = await fetch(`${base}/v1/creator/earnings`, { headers });
    const earningsBody = (await earnings.json()) as { accruedUsd: number };
    assert.ok(earningsBody.accruedUsd > 0, 'a real chat turn against the creator persona must accrue earnings');
  });
});

test('a chat turn against a personaId that belongs to NO creator does not affect anyone\'s earnings', async () => {
  const gw = new HopeGateway({
    security: { rateLimit: 1000, authRateLimit: 1000 },
    provider: new FakeProvider(),
    logger: false,
  });
  await withServer(gw, async (base) => {
    const sessionToken = await signupAndGetSession(base, 'creator.unaffected@example.com');
    const headers = { 'content-type': 'application/json', 'X-HDV-Session': sessionToken };
    await fetch(`${base}/v1/creator/apply`, { method: 'POST', headers, body: JSON.stringify({ displayName: 'Jordyn' }) });

    // Plain fucklike.ai fictional companion — no matching CreatorPersona anywhere.
    const chat = await fetch(`${base}/v1/companion/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        persona: { name: 'Luna', age: 23 },
        message: 'hi',
        companionId: 'totally-unrelated-companion',
      }),
    });
    assert.equal(chat.status, 200);
    await new Promise((r) => setImmediate(r));

    const earnings = await fetch(`${base}/v1/creator/earnings`, { headers });
    const earningsBody = (await earnings.json()) as { accruedUsd: number };
    assert.equal(earningsBody.accruedUsd, 0);
  });
});

// ---------------------------------------------------------------------------
// E. Verification + payout (the safety gate)
// ---------------------------------------------------------------------------

test('POST /v1/creator/verification starts a stub session; POST /v1/creator/payout ALWAYS 403s', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 1000, authRateLimit: 1000 }, logger: false });
  await withServer(gw, async (base) => {
    const sessionToken = await signupAndGetSession(base, 'creator.payout@example.com');
    const headers = { 'content-type': 'application/json', 'X-HDV-Session': sessionToken };

    const verification = await fetch(`${base}/v1/creator/verification`, { method: 'POST', headers });
    assert.equal(verification.status, 200);
    const verificationBody = (await verification.json()) as { verification: { status: string } };
    assert.equal(verificationBody.verification.status, 'requires_input');

    const payout = await fetch(`${base}/v1/creator/payout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ amountUsd: 5 }),
    });
    assert.equal(payout.status, 403);
    const payoutBody = (await payout.json()) as { code: string; error: string };
    assert.equal(payoutBody.code, 'not_verified');
    assert.match(payoutBody.error, /not identity-verified/i);

    // Requesting verification AGAIN does not change the outcome — still unconditionally blocked.
    await fetch(`${base}/v1/creator/verification`, { method: 'POST', headers });
    const stillBlocked = await fetch(`${base}/v1/creator/payout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ amountUsd: 999999 }),
    });
    assert.equal(stillBlocked.status, 403);
  });
});

// ---------------------------------------------------------------------------
// F. POST /v1/creator/webhooks/stripe — gateway wiring over real HTTP
// ---------------------------------------------------------------------------

/** Minimal fake Stripe client — only `webhooks.constructEvent` is exercised by these tests. */
function makeFakeStripeForWebhook(constructEvent: (raw: unknown, sig: unknown, secret: unknown) => Stripe.Event): Stripe {
  return {
    webhooks: { constructEvent },
    accounts: { create: async () => ({ id: 'acct_x' }), retrieve: async (id: string) => ({ id, payouts_enabled: true }) },
    identity: {
      verificationSessions: {
        create: async () => ({ id: 'vs_x', status: 'requires_input', url: 'https://x' }),
        retrieve: async (id: string) => ({ id, status: 'verified' }),
      },
    },
    accountLinks: { create: async () => ({ url: 'https://x' }) },
    transfers: { create: async () => ({ id: 'tr_x' }) },
  } as unknown as Stripe;
}

test('POST /v1/creator/webhooks/stripe is reachable with NO X-HDV-Session/HDV_API_KEY even when an operator key IS configured — but 503s because the default gateway has no live Stripe provider', async () => {
  const gw = new HopeGateway({
    security: { apiKey: 'operator-secret', rateLimit: 1000, authRateLimit: 1000 },
    logger: false,
  });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/creator/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'whatever' },
      body: JSON.stringify({ type: 'account.updated' }),
    });
    // NOT 401 — this route is auth-exempt from X-HDV-Key/X-HDV-Session (see
    // gateway/middleware.ts's AUTH_EXEMPT_PATHS). 503 because Stripe isn't configured on this
    // gateway (the default CreatorPayoutStub is wired, not a CreatorPayoutStripeLive).
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /not configured/i);
  });
});

test('POST /v1/creator/webhooks/stripe threads the RAW request body through to stripe.webhooks.constructEvent unmodified, over real HTTP, with no auth headers at all', async () => {
  const repo = new InMemoryCreatorProfileRepository();
  let receivedRaw: Buffer | string | undefined;
  let receivedSig: unknown;
  const stripeClient = makeFakeStripeForWebhook((raw, sig) => {
    receivedRaw = raw as Buffer;
    receivedSig = sig;
    return {
      id: 'evt_1',
      type: 'identity.verification_session.verified',
      data: { object: { id: 'vs_1', metadata: { creatorUserId: 'gateway-creator' } } },
    } as unknown as Stripe.Event;
  });
  const live = new CreatorPayoutStripeLive({
    secretKey: 'sk_test_fake',
    webhookSecret: 'whsec_fake',
    stripeClient,
    creatorProfileRepository: repo,
  });

  const gw = new HopeGateway({
    security: { apiKey: 'operator-secret', rateLimit: 1000, authRateLimit: 1000 },
    creatorPayoutProvider: live,
    logger: false,
  });

  await withServer(gw, async (base) => {
    const payload = JSON.stringify({ type: 'identity.verification_session.verified' });
    const res = await fetch(`${base}/v1/creator/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'test-signature-abc' },
      body: payload,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { received: boolean; type: string };
    assert.equal(body.received, true);
    assert.equal(body.type, 'identity.verification_session.verified');

    // The exact bytes sent must be what constructEvent saw — no JSON re-parsing/re-serialization.
    assert.equal(receivedRaw?.toString('utf8'), payload);
    assert.equal(receivedSig, 'test-signature-abc');

    assert.equal(live.checkVerificationStatus('gateway-creator'), 'verified');
  });
});

test('POST /v1/creator/webhooks/stripe with a bad signature (constructEvent throws) returns 400 over real HTTP, no auth headers needed', async () => {
  const repo = new InMemoryCreatorProfileRepository();
  const stripeClient = makeFakeStripeForWebhook(() => {
    throw new Error('No signatures found matching the expected signature for payload');
  });
  const live = new CreatorPayoutStripeLive({
    secretKey: 'sk_test_fake',
    webhookSecret: 'whsec_fake',
    stripeClient,
    creatorProfileRepository: repo,
  });
  const gw = new HopeGateway({ creatorPayoutProvider: live, security: { rateLimit: 1000 }, logger: false });

  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/creator/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'forged' },
      body: JSON.stringify({ type: 'identity.verification_session.verified' }),
    });
    assert.equal(res.status, 400);
  });
});
