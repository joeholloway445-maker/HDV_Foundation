/**
 * tests/auth.test.ts — account/auth layer tests (node:test).
 *
 * Covers auth/service.ts directly plus the gateway's /v1/auth/* HTTP surface:
 *   - AuthService: signup/login/logout/getUserBySession, duplicate-email rejection, the
 *     generic (non-enumerating) invalid-credentials message, session expiry, password
 *     hashing (scrypt, salt:hash encoding, constant-time verify).
 *   - Gateway /v1/auth/* over real HTTP: happy paths, 409/401/400 mappings, auth-exempt
 *     routing (works even with an API key configured), the signup/login-specific rate limit,
 *     and that passwordHash never leaks into any response body.
 *
 * Run: node --import tsx --test tests/auth.test.ts   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import {
  AuthService,
  AuthError,
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
} from '../auth/index.js';
import { InMemoryUserRepository, InMemorySessionRepository } from '../persistence/index.js';
import { HopeGateway } from '../gateway/index.js';

function newService(overrides: { now?: () => number; sessionTtlMs?: number } = {}): AuthService {
  return new AuthService({
    users: new InMemoryUserRepository(),
    sessions: new InMemorySessionRepository(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// A. Password hashing (crypto.scrypt, salt:hash encoding)
// ---------------------------------------------------------------------------

test('hashPassword produces a salt:hash encoding that verifyPassword accepts', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.match(stored, /^[0-9a-f]+:[0-9a-f]+$/);
  assert.ok(verifyPassword('correct horse battery staple', stored));
});

test('verifyPassword rejects a wrong password and never throws on garbage input', () => {
  const stored = hashPassword('the-real-password');
  assert.equal(verifyPassword('not-the-password', stored), false);
  assert.equal(verifyPassword('the-real-password', 'not-a-valid-encoding'), false);
  assert.equal(verifyPassword('the-real-password', ''), false);
  assert.equal(verifyPassword('the-real-password', ':'), false);
});

test('two hashes of the same password use different random salts', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a, b, 'salts must be per-user random, not deterministic');
  assert.ok(verifyPassword('same-password', a));
  assert.ok(verifyPassword('same-password', b));
});

// ---------------------------------------------------------------------------
// B. AuthService — signup / login / logout / getUserBySession
// ---------------------------------------------------------------------------

test('signup happy path returns a public user + session token, never the password', () => {
  const svc = newService();
  const { user, sessionToken } = svc.signup('new.user@example.com', 'hunter22');
  assert.equal(user.email, 'new.user@example.com');
  assert.ok(user.userId.length > 0);
  assert.equal(typeof user.createdAt, 'number');
  assert.ok(sessionToken.length >= 32, 'session token should be a long random string');
  assert.ok(!('passwordHash' in (user as unknown as Record<string, unknown>)));
});

test('signup normalizes email case for storage + duplicate detection', () => {
  const svc = newService();
  const { user } = svc.signup('Mixed.Case@Example.com', 'password123');
  assert.equal(user.email, 'mixed.case@example.com');
  assert.throws(() => svc.signup('mixed.case@example.com', 'anotherpass1'), (err: unknown) => {
    assert.ok(err instanceof AuthError);
    const e = err as AuthError;
    assert.equal(e.code, 'duplicate_email');
    return true;
  });
});

test('signup rejects a duplicate email with AuthError(duplicate_email)', () => {
  const svc = newService();
  svc.signup('dup@example.com', 'password123');
  assert.throws(() => svc.signup('dup@example.com', 'password456'), (err: unknown) => {
    assert.ok(err instanceof AuthError);
    const e = err as AuthError;
    assert.equal(e.code, 'duplicate_email');
    return true;
  });
});

test('signup rejects malformed email and short password with AuthError(invalid_input)', () => {
  const svc = newService();
  assert.throws(() => svc.signup('not-an-email', 'password123'), (err: unknown) => {
    assert.ok(err instanceof AuthError);
    const e = err as AuthError;
    assert.equal(e.code, 'invalid_input');
    return true;
  });
  assert.throws(() => svc.signup('valid@example.com', 'short'), (err: unknown) => {
    assert.ok(err instanceof AuthError);
    const e = err as AuthError;
    assert.equal(e.code, 'invalid_input');
    assert.match(e.message, new RegExp(`${MIN_PASSWORD_LENGTH}`));
    return true;
  });
  assert.throws(() => svc.signup(undefined, 'password123'), (err: unknown) => err instanceof AuthError);
  assert.throws(() => svc.signup('valid@example.com', undefined), (err: unknown) => err instanceof AuthError);
});

test('login happy path returns a fresh session token', () => {
  const svc = newService();
  svc.signup('alice@example.com', 'password123');
  const { user, sessionToken } = svc.login('alice@example.com', 'password123');
  assert.equal(user.email, 'alice@example.com');
  assert.ok(sessionToken.length >= 32);
});

test('login with a wrong password and login with an unknown email throw the IDENTICAL AuthError', () => {
  const svc = newService();
  svc.signup('bob@example.com', 'correct-password');

  let wrongPasswordErr: AuthError | undefined;
  try {
    svc.login('bob@example.com', 'wrong-password');
  } catch (err) {
    wrongPasswordErr = err as AuthError;
  }
  let unknownEmailErr: AuthError | undefined;
  try {
    svc.login('nobody@example.com', 'whatever-password');
  } catch (err) {
    unknownEmailErr = err as AuthError;
  }

  assert.ok(wrongPasswordErr instanceof AuthError);
  assert.ok(unknownEmailErr instanceof AuthError);
  assert.equal(wrongPasswordErr.code, 'invalid_credentials');
  assert.equal(unknownEmailErr.code, 'invalid_credentials');
  // Same message text both ways — an attacker can't enumerate registered emails from this.
  assert.equal(wrongPasswordErr.message, unknownEmailErr.message);
  assert.equal(wrongPasswordErr.message, 'invalid email or password');
});

test('logout invalidates the session — a subsequent getUserBySession returns null', () => {
  const svc = newService();
  svc.signup('carol@example.com', 'password123');
  const { sessionToken } = svc.login('carol@example.com', 'password123');
  assert.ok(svc.getUserBySession(sessionToken));
  svc.logout(sessionToken);
  assert.equal(svc.getUserBySession(sessionToken), null);
});

test('logout is idempotent for an unknown/missing token (never throws)', () => {
  const svc = newService();
  assert.doesNotThrow(() => svc.logout('not-a-real-token'));
  assert.doesNotThrow(() => svc.logout(undefined));
});

test('an expired session is rejected by getUserBySession', () => {
  let now = 1_000_000;
  const svc = newService({ now: () => now, sessionTtlMs: 1_000 });
  const { sessionToken } = svc.signup('dana@example.com', 'password123');
  assert.ok(svc.getUserBySession(sessionToken), 'fresh session is valid');
  now += 1_001; // just past expiry
  assert.equal(svc.getUserBySession(sessionToken), null, 'expired session is rejected');
});

test('getUserBySession returns null for a missing/empty/garbage token', () => {
  const svc = newService();
  assert.equal(svc.getUserBySession(undefined), null);
  assert.equal(svc.getUserBySession(''), null);
  assert.equal(svc.getUserBySession('does-not-exist'), null);
});

// ---------------------------------------------------------------------------
// C. Gateway /v1/auth/* over real HTTP
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

test('POST /v1/auth/signup is auth-exempt (works with an API key configured) and returns 200', async () => {
  const gw = new HopeGateway({ security: { apiKey: 'secret-key', rateLimit: 1000, authRateLimit: 1000 }, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'gateway.user@example.com', password: 'password123' }),
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes('passwordHash'), 'response must never include the password hash');
    const body = JSON.parse(raw) as { userId: string; email: string; sessionToken: string };
    assert.equal(body.email, 'gateway.user@example.com');
    assert.ok(body.userId.length > 0);
    assert.ok(body.sessionToken.length >= 32);

    // A protected route on the SAME gateway still requires the key — auth isn't globally off.
    const protectedRes = await fetch(`${base}/v1/matrix/stats`);
    assert.equal(protectedRes.status, 401);
  });
});

test('POST /v1/auth/signup rejects a duplicate email with 409', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 1000, authRateLimit: 1000 }, logger: false });
  await withServer(gw, async (base) => {
    const first = await fetch(`${base}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dup@example.com', password: 'password123' }),
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${base}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dup@example.com', password: 'password456' }),
    });
    assert.equal(second.status, 409);
    const body = (await second.json()) as { error: string };
    assert.ok(body.error.length > 0);
  });
});

test('malformed signup input (missing fields, bad email, short password) is rejected with 400', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 1000, authRateLimit: 1000 }, logger: false });
  await withServer(gw, async (base) => {
    const missingPassword = await fetch(`${base}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'missing.pw@example.com' }),
    });
    assert.equal(missingPassword.status, 400);

    const missingEmail = await fetch(`${base}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'password123' }),
    });
    assert.equal(missingEmail.status, 400);

    const badEmail = await fetch(`${base}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'password123' }),
    });
    assert.equal(badEmail.status, 400);

    const shortPassword = await fetch(`${base}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'shortpw@example.com', password: 'short' }),
    });
    assert.equal(shortPassword.status, 400);
  });
});

test('POST /v1/auth/login happy path returns 200; wrong password and unknown email both 401 with the SAME message', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 1000, authRateLimit: 1000 }, logger: false });
  await withServer(gw, async (base) => {
    await fetch(`${base}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'login.user@example.com', password: 'correct-password' }),
    });

    const ok = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'login.user@example.com', password: 'correct-password' }),
    });
    assert.equal(ok.status, 200);
    const okRaw = await ok.text();
    assert.ok(!okRaw.includes('passwordHash'));
    const okBody = JSON.parse(okRaw) as { sessionToken: string };
    assert.ok(okBody.sessionToken.length >= 32);

    const wrongPassword = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'login.user@example.com', password: 'wrong-password' }),
    });
    assert.equal(wrongPassword.status, 401);
    const wrongBody = (await wrongPassword.json()) as { error: string };

    const unknownEmail = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody-here@example.com', password: 'whatever' }),
    });
    assert.equal(unknownEmail.status, 401);
    const unknownBody = (await unknownEmail.json()) as { error: string };

    assert.equal(wrongBody.error, unknownBody.error, 'identical message: cannot enumerate emails');
    assert.equal(wrongBody.error, 'invalid email or password');
  });
});

test('GET /v1/auth/me returns the account for a valid X-HDV-Session, 401 otherwise', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 1000, authRateLimit: 1000 }, logger: false });
  await withServer(gw, async (base) => {
    const signup = await fetch(`${base}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'me.user@example.com', password: 'password123' }),
    });
    const { sessionToken } = (await signup.json()) as { sessionToken: string };

    const me = await fetch(`${base}/v1/auth/me`, { headers: { 'X-HDV-Session': sessionToken } });
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { userId: string; email: string };
    assert.equal(meBody.email, 'me.user@example.com');

    const noHeader = await fetch(`${base}/v1/auth/me`);
    assert.equal(noHeader.status, 401);

    const badToken = await fetch(`${base}/v1/auth/me`, { headers: { 'X-HDV-Session': 'not-a-real-token' } });
    assert.equal(badToken.status, 401);
  });
});

test('POST /v1/auth/logout invalidates the session — a subsequent /v1/auth/me is 401', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 1000, authRateLimit: 1000 }, logger: false });
  await withServer(gw, async (base) => {
    const signup = await fetch(`${base}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'logout.user@example.com', password: 'password123' }),
    });
    const { sessionToken } = (await signup.json()) as { sessionToken: string };

    const meBefore = await fetch(`${base}/v1/auth/me`, { headers: { 'X-HDV-Session': sessionToken } });
    assert.equal(meBefore.status, 200);

    const logout = await fetch(`${base}/v1/auth/logout`, {
      method: 'POST',
      headers: { 'X-HDV-Session': sessionToken },
    });
    assert.equal(logout.status, 200);
    const logoutBody = (await logout.json()) as { ok: boolean };
    assert.equal(logoutBody.ok, true);

    const meAfter = await fetch(`${base}/v1/auth/me`, { headers: { 'X-HDV-Session': sessionToken } });
    assert.equal(meAfter.status, 401);
  });
});

test('GET /v1/auth/me rejects an expired session (401)', async () => {
  let now = 1_000_000;
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const auth = new AuthService({ users, sessions, now: () => now, sessionTtlMs: 500 });
  const gw = new HopeGateway({ auth, security: { rateLimit: 1000, authRateLimit: 1000 }, logger: false });
  await withServer(gw, async (base) => {
    const { sessionToken } = auth.signup('expiring.user@example.com', 'password123');
    const meBefore = await fetch(`${base}/v1/auth/me`, { headers: { 'X-HDV-Session': sessionToken } });
    assert.equal(meBefore.status, 200);

    now += 501; // advance past the injected 500ms TTL

    const meAfter = await fetch(`${base}/v1/auth/me`, { headers: { 'X-HDV-Session': sessionToken } });
    assert.equal(meAfter.status, 401);
  });
});

test('POST /v1/auth/signup and /v1/auth/login are rate-limited more strictly than the generic limit', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 1000, authRateLimit: 2 }, logger: false });
  await withServer(gw, async (base) => {
    const attempt = (email: string) =>
      fetch(`${base}/v1/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'password123' }),
      });

    const first = await attempt('rl1@example.com');
    const second = await attempt('rl2@example.com');
    const third = await attempt('rl3@example.com');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429, 'the third signup within the window trips the stricter auth limit');
    const body = (await third.json()) as { error: string };
    assert.match(body.error, /rate limit/i);

    // A DIFFERENT route on the same gateway is unaffected by the auth-specific limiter.
    const pricing = await fetch(`${base}/v1/billing/pricing`);
    assert.equal(pricing.status, 200);
  });
});
