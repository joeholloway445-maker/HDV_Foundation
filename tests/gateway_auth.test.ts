/**
 * tests/gateway_auth.test.ts — Phase 4.1 gateway hardening tests (+ per-tenant rate limiting).
 *
 * Covers the HOPE gateway's HTTP front door WITHOUT regressing any earlier invariant:
 *   - API-key auth: missing/invalid key → 401 when HDV_API_KEY is set; valid key → 200.
 *   - Dev mode: no key configured → protected routes stay open (auth disabled).
 *   - Rate limiting: per-IP fixed window trips to 429 once the budget is spent.
 *   - Per-TENANT rate limiting (X-HDV-Tenant): a SECOND, additive budget on companion +
 *     billing/checkout routes — independent of the per-IP budget above.
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
  tenantFromHeaders,
  rawTenantId,
  DEFAULT_RATE_LIMIT,
  DEFAULT_TENANT_RATE_LIMIT,
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
// C2. Per-tenant rate limiting — additive to the per-IP limiter above.
// ---------------------------------------------------------------------------

test('per-tenant rate limit trips independently of the per-IP limit: one IP, two tenants', async () => {
  // Per-IP budget generous (10/min) so it never trips in this test; per-tenant budget tight (2/min)
  // is the one under test. All requests below come from the SAME client IP (one fetch client).
  const gw = new HopeGateway({
    security: { apiKey: undefined, rateLimit: 10, tenantRateLimit: 2 },
    provider: false,
    logger: false,
  });
  await withServer(gw, async (base) => {
    const chatFor = (tenant: string) =>
      fetch(`${base}/v1/companion/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-HDV-Tenant': tenant },
        body: JSON.stringify({ persona: { name: 'Luna', age: 23, personality: 'soft' }, message: 'hi' }),
      });

    // Tenant "alice" spends her budget (2) and trips on the 3rd request.
    assert.equal((await chatFor('alice')).status, 200);
    assert.equal((await chatFor('alice')).status, 200);
    const tripped = await chatFor('alice');
    assert.equal(tripped.status, 429);
    const body = (await tripped.json()) as { error: string; tenantId: string; limit: number };
    assert.equal(body.error, 'tenant rate limit exceeded');
    assert.equal(body.tenantId, 'alice');
    assert.equal(body.limit, 2);
    assert.ok(tripped.headers.get('retry-after'), 'sends Retry-After on tenant 429 too');

    // Tenant "bob", SAME client IP, has his own untouched budget — proves the bucket is keyed
    // by tenant, not by IP (the IP-level limiter would have already tripped both by now if it
    // were the one enforcing this).
    assert.equal((await chatFor('bob')).status, 200, "bob's own tenant budget is untouched");
  });
});

test('per-tenant rate limit only applies to companion + billing/checkout routes, not e.g. waitlist', async () => {
  const gw = new HopeGateway({
    security: { apiKey: undefined, rateLimit: 100, tenantRateLimit: 1 },
    provider: false,
    logger: false,
  });
  await withServer(gw, async (base) => {
    // Spend tenant "carol"'s single-request tenant budget on companion chat.
    const chat = await fetch(`${base}/v1/companion/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HDV-Tenant': 'carol' },
      body: JSON.stringify({ persona: { name: 'Luna', age: 23 }, message: 'hi' }),
    });
    assert.equal(chat.status, 200);
    const tripped = await fetch(`${base}/v1/companion/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HDV-Tenant': 'carol' },
      body: JSON.stringify({ persona: { name: 'Luna', age: 23 }, message: 'hi again' }),
    });
    assert.equal(tripped.status, 429);

    // Waitlist is public+IP-rate-limited but deliberately NOT in the tenant-limited path set —
    // the same tenant id is unaffected there even though its companion budget is spent.
    const waitlist = await fetch(`${base}/v1/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HDV-Tenant': 'carol' },
      body: JSON.stringify({ email: `carol-${Date.now()}@example.com` }),
    });
    assert.equal(waitlist.status, 201, 'waitlist is not tenant-rate-limited');
  });
});

test('per-tenant rate-limit metadata headers accompany allowed companion/billing responses', async () => {
  const gw = new HopeGateway({
    security: { apiKey: undefined, tenantRateLimit: 5 },
    provider: false,
    logger: false,
  });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/companion/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HDV-Tenant': 'dana' },
      body: JSON.stringify({ persona: { name: 'Luna', age: 23 }, message: 'hi' }),
    });
    assert.equal(res.headers.get('x-ratelimit-tenant-limit'), '5');
    assert.equal(res.headers.get('x-ratelimit-tenant-remaining'), '4');
    assert.ok(res.headers.get('x-ratelimit-tenant-reset'));
  });
});

test('the pre-existing per-IP rate limiter still trips on its own (regression guard)', async () => {
  // A high tenant budget so only the per-IP limiter can be the one tripping here.
  const gw = new HopeGateway({
    security: { apiKey: undefined, rateLimit: 2, tenantRateLimit: 1000 },
    provider: false,
    logger: false,
  });
  await withServer(gw, async (base) => {
    const chatFor = (tenant: string) =>
      fetch(`${base}/v1/companion/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-HDV-Tenant': tenant },
        body: JSON.stringify({ persona: { name: 'Luna', age: 23 }, message: 'hi' }),
      });
    // Different tenant ids, SAME client IP — the per-IP budget (2) is shared and trips
    // regardless of tenant diversity, proving it still runs unchanged as the first line of
    // defense against one client rotating through many fake tenant ids.
    assert.equal((await chatFor('t1')).status, 200);
    assert.equal((await chatFor('t2')).status, 200);
    const tripped = await chatFor('t3');
    assert.equal(tripped.status, 429);
    const body = (await tripped.json()) as { error: string };
    assert.equal(body.error, 'rate limit exceeded', 'this is the IP-level message, not the tenant one');
  });
});

test('RateLimiter (per-tenant bucket) trips then resets after the window elapses — unit level', () => {
  const rl = new RateLimiter(2, 1000);
  assert.equal(rl.hit('tenant:x', 0).allowed, true);
  assert.equal(rl.hit('tenant:x', 10).allowed, true);
  assert.equal(rl.hit('tenant:x', 20).allowed, false);
  assert.equal(rl.hit('tenant:y', 20).allowed, true, 'a different tenant key has its own budget');
});

test('resolveSecurityConfig reads HDV_TENANT_RATE_LIMIT with overrides taking precedence', () => {
  const env = { HDV_TENANT_RATE_LIMIT: '7' } as NodeJS.ProcessEnv;
  assert.equal(resolveSecurityConfig({}, env).tenantRateLimit, 7);
  assert.equal(resolveSecurityConfig({ tenantRateLimit: 3 }, env).tenantRateLimit, 3);
  assert.equal(resolveSecurityConfig({}, {} as NodeJS.ProcessEnv).tenantRateLimit, DEFAULT_TENANT_RATE_LIMIT);
});

test('tenantFromHeaders defaults to "demo"; rawTenantId is undefined when absent (used for logging)', () => {
  assert.equal(tenantFromHeaders({ 'x-hdv-tenant': 'acme' }), 'acme');
  assert.equal(tenantFromHeaders({}), 'demo');
  assert.equal(tenantFromHeaders(undefined), 'demo');
  assert.equal(rawTenantId({ 'x-hdv-tenant': 'acme' }), 'acme');
  assert.equal(rawTenantId({}), undefined, 'no default — logging omits the field entirely');
});

test('GatewayMiddleware.isTenantRateLimitedPath scopes exactly companion + billing/checkout', () => {
  const mw = new GatewayMiddleware(resolveSecurityConfig({ apiKey: undefined }, {} as NodeJS.ProcessEnv));
  for (const p of [
    '/v1/companion/chat',
    '/v1/companion/portrait',
    '/v1/companion/scene',
    '/v1/billing/checkout',
    '/v1/billing/checkout/settle',
  ]) {
    assert.equal(mw.isTenantRateLimitedPath(p), true, p);
  }
  for (const p of ['/v1/waitlist', '/v1/health', '/v1/matrix/stats', '/v1/billing/usage']) {
    assert.equal(mw.isTenantRateLimitedPath(p), false, p);
  }
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

test('log entries are single-line JSON with an ISO timestamp; tenant is present only when sent', async () => {
  const entries: LogEntry[] = [];
  const gw = new HopeGateway({
    security: { apiKey: undefined },
    provider: false,
    logger: (e) => entries.push(e),
  });
  await withServer(gw, async (base) => {
    // No X-HDV-Tenant sent.
    await fetch(`${base}/v1/health`);
    // X-HDV-Tenant sent.
    await fetch(`${base}/v1/companion/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-HDV-Tenant': 'acme-corp' },
      body: JSON.stringify({ persona: { name: 'Luna', age: 23 }, message: 'hi' }),
    });
  });
  assert.equal(entries.length, 2);

  const healthEntry = entries.find((e) => e.path === '/v1/health');
  assert.ok(healthEntry);
  assert.equal(healthEntry.tenant, undefined, 'no tenant header sent ⇒ field is omitted, not "demo"');

  const chatEntry = entries.find((e) => e.path === '/v1/companion/chat');
  assert.ok(chatEntry);
  assert.equal(chatEntry.tenant, 'acme-corp');

  for (const e of entries) {
    // ISO-8601, parseable, and — this is the whole point — greppable by a non-technical
    // operator via `docker logs ... | grep '"status":...'` / `grep '"tenant":"..."'` without a
    // JSON parser. defaultLogger emits exactly one JSON.stringify(...) call per request.
    assert.match(e.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
    const line = JSON.stringify(e);
    assert.equal(line.includes('\n'), false, 'must be a single line to stay grep-per-request-friendly');
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
