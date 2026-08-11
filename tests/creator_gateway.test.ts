/**
 * tests/creator_gateway.test.ts — creator marketplace HTTP integration (gateway/server.ts).
 *
 * Coverage:
 *   A. Every /v1/creator/* route requires a valid X-HDV-Session (401 otherwise) — UNLIKE
 *      companion/chat etc., these are NOT in AUTH_EXEMPT_PATHS, so with an operator API key
 *      configured they ALSO 401 without that key, even with a perfectly valid session.
 *   B. Happy-path flow: signup → apply → submit a persona → GET earnings (starts at 0).
 *   C. POST /v1/creator/persona 409s when personaId is already claimed by another creator.
 *   D. End-to-end usage attribution: a real-provider companion chat turn using a creator's
 *      personaId (as companionId) accrues earnings — proving the fire-and-forget wiring into
 *      companion/handlers.ts actually works over real HTTP, not just in isolation.
 *   E. POST /v1/creator/verification + POST /v1/creator/payout — payout ALWAYS 403s (THE safety
 *      gate), even after requesting verification and even with a large accrued balance.
 *
 * Run: node --import tsx --test tests/creator_gateway.test.ts   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

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

test('/v1/creator/* routes are NOT auth-exempt: with an operator API key configured, a valid session ALONE is not enough', async () => {
  const gw = new HopeGateway({
    security: { apiKey: 'operator-secret', rateLimit: 1000, authRateLimit: 1000 },
    logger: false,
  });
  await withServer(gw, async (base) => {
    // Signup/login themselves are auth-exempt from the API key, so this still works with no key.
    const sessionToken = await signupAndGetSession(base, 'creator.noKey@example.com');

    // Valid session, but NO operator API key on a route that requires one — 401 from the
    // FRONT-DOOR middleware guard, before the route handler's own session check ever runs.
    const res = await fetch(`${base}/v1/creator/earnings`, {
      headers: { 'X-HDV-Session': sessionToken },
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'unauthorized');

    // BOTH the operator key AND the session together succeed.
    const ok = await fetch(`${base}/v1/creator/earnings`, {
      headers: { 'X-HDV-Session': sessionToken, 'X-HDV-Key': 'operator-secret' },
    });
    assert.equal(ok.status, 200);
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
    assert.match(payoutBody.error, /identity verification required/i);

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
