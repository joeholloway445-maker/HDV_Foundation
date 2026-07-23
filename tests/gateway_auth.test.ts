/**
 * tests/gateway_auth.test.ts — Phase 4.1 gateway hardening tests.
 *
 * Covers the HOPE gateway's HTTP front door WITHOUT regressing any earlier invariant:
 *   - API-key auth: missing/invalid key → 401 when HDV_API_KEY is set; valid key → 200.
 *   - Dev mode: no key configured → protected routes stay open (auth disabled).
 *   - Rate limiting: per-IP fixed window trips to 429 once the budget is spent.
 *   - /v1/health is ALWAYS public (auth- and rate-limit-exempt) for probes.
 *   - CORS headers + preflight; the logger never receives secrets.
 *
 * These run over real HTTP (ephemeral port) for the end-to-end guards plus a few direct
 * unit checks on the middleware. Loggers are silenced with `logger: false`.
 *
 * Run: npm run test:gateway-auth   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { HopeGateway } from '../gateway/index.js';
import {
  GatewayMiddleware,
  RateLimiter,
  resolveSecurityConfig,
  extractKey,
  keysMatch,
  clientIp,
  DEFAULT_RATE_LIMIT,
  type LogEntry,
} from '../gateway/index.js';

const KEY = 'super-secret-key-123';

async function withServer(
  gw: HopeGateway,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = await gw.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// ---------------------------------------------------------------------------
// A. API-key auth over real HTTP
// ---------------------------------------------------------------------------

test('missing key → 401 when HDV_API_KEY is configured', async () => {
  const gw = new HopeGateway({ security: { apiKey: KEY }, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/matrix/stats`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'unauthorized');
  });
});

test('invalid key → 401 (X-HDV-Key and Bearer both rejected)', async () => {
  const gw = new HopeGateway({ security: { apiKey: KEY }, logger: false });
  await withServer(gw, async (base) => {
    const viaHeader = await fetch(`${base}/v1/matrix/stats`, { headers: { 'X-HDV-Key': 'wrong' } });
    assert.equal(viaHeader.status, 401);
    const viaBearer = await fetch(`${base}/v1/matrix/stats`, { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(viaBearer.status, 401);
  });
});

test('valid key → 200 via X-HDV-Key header', async () => {
  const gw = new HopeGateway({ security: { apiKey: KEY }, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/matrix/stats`, { headers: { 'X-HDV-Key': KEY } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { parameters: { totalConceptual: number } };
    assert.equal(body.parameters.totalConceptual, 14_336_000_000_000_000);
  });
});

test('valid key → 200 via Authorization: Bearer', async () => {
  const gw = new HopeGateway({ security: { apiKey: KEY }, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/matrix/stats`, { headers: { Authorization: `Bearer ${KEY}` } });
    assert.equal(res.status, 200);
  });
});

test('valid key unlocks POST /v1/intent (still routed via APEX + KNOLL)', async () => {
  const gw = new HopeGateway({ security: { apiKey: KEY }, logger: false });
  await withServer(gw, async (base) => {
    const unauth = await fetch(`${base}/v1/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ utterance: 'simulate three outcomes for launching the product early' }),
    });
    assert.equal(unauth.status, 401);

    const res = await fetch(`${base}/v1/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HDV-Key': KEY },
      body: JSON.stringify({ utterance: 'simulate three outcomes for launching the product early' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dispatched: boolean; routingStatus: string };
    assert.equal(body.dispatched, true);
    assert.equal(body.routingStatus, 'SUCCESS');
  });
});

test('dev mode (no key) leaves protected routes open', async () => {
  const gw = new HopeGateway({ security: { apiKey: undefined }, logger: false });
  assert.equal(gw.middleware.authDisabled, true);
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/matrix/stats`);
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// B. /v1/health stays public regardless of auth / rate limit
// ---------------------------------------------------------------------------

test('/v1/health is reachable without a key even when auth is enabled', async () => {
  const gw = new HopeGateway({ security: { apiKey: KEY }, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; knollGate: string };
    assert.equal(body.ok, true);
    assert.equal(body.knollGate, 'enforced');
  });
});

test('/v1/health survives a burst that would otherwise trip the rate limit', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 2 }, logger: false });
  await withServer(gw, async (base) => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/v1/health`);
      assert.equal(res.status, 200, `health probe #${i + 1} should stay open`);
    }
  });
});

// ---------------------------------------------------------------------------
// C. Rate limiting trips to 429
// ---------------------------------------------------------------------------

test('rate limit trips to 429 once the per-IP budget is spent', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 3 }, logger: false });
  await withServer(gw, async (base) => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/v1/matrix/stats`);
      statuses.push(res.status);
      if (res.status === 429) {
        const body = (await res.json()) as { error: string; limit: number };
        assert.equal(body.error, 'rate limit exceeded');
        assert.equal(body.limit, 3);
        assert.ok(res.headers.get('retry-after'), 'sends a Retry-After header');
      }
    }
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200], 'first 3 within budget');
    assert.deepEqual(statuses.slice(3), [429, 429], 'subsequent requests are limited');
  });
});

test('rate-limit metadata headers accompany allowed responses', async () => {
  const gw = new HopeGateway({ security: { rateLimit: 10 }, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/matrix/stats`);
    assert.equal(res.headers.get('x-ratelimit-limit'), '10');
    assert.equal(res.headers.get('x-ratelimit-remaining'), '9');
    assert.ok(res.headers.get('x-ratelimit-reset'));
  });
});

// ---------------------------------------------------------------------------
// D. CORS
// ---------------------------------------------------------------------------

test('CORS headers are present and OPTIONS preflight short-circuits with 204', async () => {
  const gw = new HopeGateway({ security: { apiKey: KEY, corsOrigin: 'https://hope.example' }, logger: false });
  await withServer(gw, async (base) => {
    const preflight = await fetch(`${base}/v1/intent`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://hope.example');
    assert.ok(preflight.headers.get('access-control-allow-methods'));

    // Preflight must NOT require auth.
    const health = await fetch(`${base}/v1/health`);
    assert.equal(health.headers.get('access-control-allow-origin'), 'https://hope.example');
  });
});

// ---------------------------------------------------------------------------
// E. Logging never leaks secrets
// ---------------------------------------------------------------------------

test('request logger records method/path/status/duration and never the key', async () => {
  const entries: LogEntry[] = [];
  const gw = new HopeGateway({ security: { apiKey: KEY }, logger: (e) => entries.push(e) });
  await withServer(gw, async (base) => {
    await fetch(`${base}/v1/matrix/stats`, { headers: { 'X-HDV-Key': KEY } });
    await fetch(`${base}/v1/matrix/stats`, { headers: { 'X-HDV-Key': 'nope' } });
  });
  assert.ok(entries.length >= 2);
  const authorized = entries.find((e) => e.authState === 'authorized');
  const rejected = entries.find((e) => e.authState === 'rejected');
  assert.ok(authorized, 'logs an authorized request');
  assert.ok(rejected, 'logs a rejected request');
  for (const e of entries) {
    assert.equal(typeof e.durationMs, 'number');
    assert.ok(e.durationMs >= 0);
    // No field of the log entry may contain the secret key.
    assert.ok(!JSON.stringify(e).includes(KEY), 'log entry must not contain the API key');
  }
});

// ---------------------------------------------------------------------------
// F. Middleware unit checks (no port)
// ---------------------------------------------------------------------------

test('resolveSecurityConfig reads env with overrides taking precedence', () => {
  const env = { HDV_API_KEY: 'envkey', HDV_RATE_LIMIT: '25', HDV_CORS_ORIGIN: 'https://a' } as NodeJS.ProcessEnv;
  const fromEnv = resolveSecurityConfig({}, env);
  assert.equal(fromEnv.apiKey, 'envkey');
  assert.equal(fromEnv.rateLimit, 25);
  assert.equal(fromEnv.corsOrigin, 'https://a');

  const overridden = resolveSecurityConfig({ apiKey: 'ovr', rateLimit: 5, corsOrigin: '*' }, env);
  assert.equal(overridden.apiKey, 'ovr');
  assert.equal(overridden.rateLimit, 5);
  assert.equal(overridden.corsOrigin, '*');

  const defaults = resolveSecurityConfig({}, {} as NodeJS.ProcessEnv);
  assert.equal(defaults.apiKey, undefined, 'unset key ⇒ dev mode');
  assert.equal(defaults.rateLimit, DEFAULT_RATE_LIMIT);
  assert.equal(defaults.corsOrigin, '*');
});

test('extractKey parses X-HDV-Key and Bearer; keysMatch is length-safe', () => {
  assert.equal(extractKey({ 'x-hdv-key': 'abc' }), 'abc');
  assert.equal(extractKey({ authorization: 'Bearer xyz' }), 'xyz');
  assert.equal(extractKey({ authorization: 'bearer  spaced ' }), 'spaced');
  assert.equal(extractKey({}), undefined);
  assert.equal(keysMatch('abc', 'abc'), true);
  assert.equal(keysMatch('abc', 'abd'), false);
  assert.equal(keysMatch('abc', 'abcd'), false, 'different lengths never match');
});

test('clientIp prefers x-forwarded-for first hop then socket address', () => {
  assert.equal(clientIp({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, '9.9.9.9'), '1.2.3.4');
  assert.equal(clientIp({}, '9.9.9.9'), '9.9.9.9');
  assert.equal(clientIp({}, undefined), 'unknown');
});

test('RateLimiter fixed window: trips then resets after the window elapses', () => {
  const rl = new RateLimiter(2, 1000);
  assert.equal(rl.hit('ip', 0).allowed, true);
  assert.equal(rl.hit('ip', 10).allowed, true);
  assert.equal(rl.hit('ip', 20).allowed, false, 'third hit in window is blocked');
  // A different IP has its own budget.
  assert.equal(rl.hit('other', 20).allowed, true);
  // After the window elapses the bucket resets.
  assert.equal(rl.hit('ip', 1001).allowed, true);
});

test('RateLimiter with limit<=0 disables limiting', () => {
  const rl = new RateLimiter(0, 1000);
  for (let i = 0; i < 100; i++) assert.equal(rl.hit('ip', i).allowed, true);
});

test('GatewayMiddleware.guard short-circuits health as public', () => {
  const mw = new GatewayMiddleware(resolveSecurityConfig({ apiKey: KEY, rateLimit: 1 }, {} as NodeJS.ProcessEnv));
  const healthReq = { method: 'GET', pathname: '/v1/health', headers: {}, ip: 'x' };
  // Repeated health hits never rate-limit and never require auth.
  for (let i = 0; i < 5; i++) {
    const out = mw.guard(healthReq, i);
    assert.equal(out.response, undefined, 'health is never short-circuited');
  }
  // A protected path with no key is rejected.
  const protectedOut = mw.guard({ method: 'GET', pathname: '/v1/matrix/stats', headers: {}, ip: 'y' }, 0);
  assert.equal(protectedOut.response?.status, 401);
});
