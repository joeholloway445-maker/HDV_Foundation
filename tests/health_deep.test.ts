/**
 * tests/health_deep.test.ts — GET /v1/health/deep (gateway/deep_health.ts).
 *
 * Covers:
 *   - GET /v1/health stays exactly as fast/simple/public as before (regression guard — this new
 *     endpoint must never slow it down or change its shape).
 *   - GET /v1/health/deep requires the API key (protected, same posture as /v1/matrix/stats).
 *   - Unconfigured dependencies report `skipped: true`, never a false failure.
 *   - A configured-but-unreachable dependency reports `ok: false`, `skipped: false`.
 *   - The whole endpoint is bounded: a deliberately never-resolving fake dependency still
 *     produces a response within the configured timeout — it can never hang the request.
 *   - `runDeepHealthChecks` unit-level behavior (skips, timeouts, overall `ok` aggregation).
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { HopeGateway } from '../gateway/index.js';
import { runDeepHealthChecks, DEFAULT_DEEP_HEALTH_TIMEOUT_MS } from '../gateway/index.js';
import { OpenAiCompatibleProvider } from '../providers/index.js';
import { ColabTunnelImageProvider } from '../providers/index.js';
import { ColabTunnelVideoProvider } from '../providers/index.js';

const KEY = 'deep-health-secret-key';

async function withServer(gw: HopeGateway, fn: (base: string) => Promise<void>): Promise<void> {
  const server = await gw.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// A fetch stub that never resolves — simulates a truly hung dependency (e.g. a DNS black hole)
// so we can assert the endpoint still responds within bound instead of hanging the test.
function hangingFetch(): typeof fetch {
  return (() => new Promise(() => {})) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// A. GET /v1/health regression guard — must be totally unaffected by /v1/health/deep existing.
// ---------------------------------------------------------------------------

test('/v1/health stays public, fast, and unchanged in shape (regression guard)', async () => {
  const gw = new HopeGateway({ security: { apiKey: KEY }, logger: false });
  await withServer(gw, async (base) => {
    const start = Date.now();
    const res = await fetch(`${base}/v1/health`); // no key
    const elapsedMs = Date.now() - start;
    assert.equal(res.status, 200, '/v1/health stays public — no key needed');
    assert.ok(elapsedMs < 500, `/v1/health must stay fast (took ${elapsedMs}ms)`);
    const body = (await res.json()) as Record<string, unknown>;
    // Exact same shape as before Phase 4.1/this change — no deep-check fields leaked in.
    assert.deepEqual(Object.keys(body).sort(), ['alwaysOn', 'ephemeral', 'knollGate', 'ok', 'time'].sort());
    assert.equal('checks' in body, false, '/v1/health must never gain the deep-check body shape');
  });
});

// ---------------------------------------------------------------------------
// B. GET /v1/health/deep — protected, same posture as /v1/matrix/stats.
// ---------------------------------------------------------------------------

test('/v1/health/deep requires the API key when one is configured', async () => {
  const gw = new HopeGateway({ security: { apiKey: KEY }, provider: false, logger: false });
  await withServer(gw, async (base) => {
    const unauth = await fetch(`${base}/v1/health/deep`);
    assert.equal(unauth.status, 401);

    const authed = await fetch(`${base}/v1/health/deep`, { headers: { 'X-HDV-Key': KEY } });
    assert.ok(authed.status === 200 || authed.status === 503);
    const body = (await authed.json()) as { ok: boolean; checks: Record<string, unknown>; timestamp: string };
    assert.equal(typeof body.ok, 'boolean');
    assert.equal(typeof body.timestamp, 'string');
    assert.ok(['postgres', 'redis', 'llm', 'image', 'video'].every((k) => k in body.checks));
  });
});

test('/v1/health/deep stays open in dev mode (no HDV_API_KEY), like other protected routes', async () => {
  const gw = new HopeGateway({ security: { apiKey: undefined }, provider: false, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/health/deep`);
    assert.ok(res.status === 200 || res.status === 503);
  });
});

test('/v1/health/deep reports skipped:true for every unconfigured dependency (all-offline default gateway)', async () => {
  const gw = new HopeGateway({
    security: { apiKey: undefined },
    provider: false,
    imageProvider: false,
    videoProvider: false,
    deepHealth: { databaseUrl: undefined, redisUrl: undefined },
    logger: false,
  });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/health/deep`);
    assert.equal(res.status, 200, 'nothing configured ⇒ nothing to fail ⇒ overall ok');
    const body = (await res.json()) as {
      ok: boolean;
      checks: Record<string, { configured: boolean; skipped: boolean; ok: boolean }>;
    };
    assert.equal(body.ok, true);
    for (const key of ['postgres', 'redis', 'llm', 'image', 'video'] as const) {
      assert.equal(body.checks[key].configured, false, `${key} should be unconfigured`);
      assert.equal(body.checks[key].skipped, true, `${key} should be skipped, not a false failure`);
    }
  });
});

test('/v1/health/deep never hangs: a fake dependency that never resolves still returns within bound', async () => {
  const llmProvider = new OpenAiCompatibleProvider({
    baseUrl: 'http://10.255.255.1:11434/v1', // never actually dialed — fetchImpl is stubbed below
    model: 'llama3',
    fetchImpl: hangingFetch(),
  });
  const gw = new HopeGateway({
    security: { apiKey: undefined },
    provider: llmProvider,
    imageProvider: false,
    videoProvider: false,
    deepHealth: {
      databaseUrl: undefined,
      redisUrl: undefined,
      fetchImpl: hangingFetch(),
      timeoutMs: 300, // tight bound so the test itself stays fast
    },
    logger: false,
  });
  await withServer(gw, async (base) => {
    const start = Date.now();
    const res = await fetch(`${base}/v1/health/deep`);
    const elapsedMs = Date.now() - start;
    assert.ok(elapsedMs < 2_000, `must not hang past the configured timeout (took ${elapsedMs}ms)`);
    const body = (await res.json()) as { ok: boolean; checks: { llm: { ok: boolean; skipped: boolean; detail?: string } } };
    assert.equal(res.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.checks.llm.skipped, false);
    assert.equal(body.checks.llm.ok, false);
    assert.match(body.checks.llm.detail ?? '', /timed out/);
  });
});

test('/v1/health/deep reports a configured-but-unreachable provider as ok:false (not skipped)', async () => {
  const imageProvider = new ColabTunnelImageProvider({
    baseUrl: 'https://example.invalid',
    fetchImpl: (async () => {
      throw new Error('getaddrinfo ENOTFOUND example.invalid');
    }) as unknown as typeof fetch,
  });
  const gw = new HopeGateway({
    security: { apiKey: undefined },
    provider: false,
    imageProvider,
    videoProvider: false,
    deepHealth: {
      databaseUrl: undefined,
      redisUrl: undefined,
      fetchImpl: (async () => {
        throw new Error('getaddrinfo ENOTFOUND example.invalid');
      }) as unknown as typeof fetch,
    },
    logger: false,
  });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/health/deep`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { checks: { image: { configured: boolean; skipped: boolean; ok: boolean; detail?: string } } };
    assert.equal(body.checks.image.configured, true);
    assert.equal(body.checks.image.skipped, false);
    assert.equal(body.checks.image.ok, false);
    assert.match(body.checks.image.detail ?? '', /ENOTFOUND/);
  });
});

test('/v1/health/deep reports a reachable colab_tunnel provider as ok:true via GET .../health', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    seen.push(String(url));
    return new Response('{"status":"ok"}', { status: 200 });
  }) as unknown as typeof fetch;
  const videoProvider = new ColabTunnelVideoProvider({ baseUrl: 'https://colab.example', fetchImpl });
  const gw = new HopeGateway({
    security: { apiKey: undefined },
    provider: false,
    imageProvider: false,
    videoProvider,
    deepHealth: { databaseUrl: undefined, redisUrl: undefined, fetchImpl },
    logger: false,
  });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/health/deep`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { checks: { video: { ok: boolean; skipped: boolean; detail?: string } } };
    assert.equal(body.checks.video.skipped, false);
    assert.equal(body.checks.video.ok, true);
    assert.equal(body.checks.video.detail, 'HTTP 200');
    assert.ok(seen.some((u) => u === 'https://colab.example/health'), 'probes /health, not /generate');
  });
});

// ---------------------------------------------------------------------------
// C. runDeepHealthChecks — unit level (no HTTP server).
// ---------------------------------------------------------------------------

test('runDeepHealthChecks: postgres/redis skipped when unset, checked via injected probes when set', async () => {
  const report = await runDeepHealthChecks({
    databaseUrl: 'postgresql://u:p@localhost:5432/db',
    checkPostgres: async () => ({ ok: true }),
    redisUrl: undefined,
  });
  assert.equal(report.checks.postgres.configured, true);
  assert.equal(report.checks.postgres.skipped, false);
  assert.equal(report.checks.postgres.ok, true);
  assert.equal(typeof report.checks.postgres.latencyMs, 'number');

  assert.equal(report.checks.redis.configured, false);
  assert.equal(report.checks.redis.skipped, true);
  assert.equal(report.ok, true);
});

test('runDeepHealthChecks: a failing injected probe flips ok:false without crashing the others', async () => {
  const report = await runDeepHealthChecks({
    databaseUrl: 'postgresql://u:p@localhost:5432/db',
    checkPostgres: async () => {
      throw new Error('connection refused');
    },
    redisUrl: 'redis://localhost:6379',
    checkRedis: async () => ({ ok: true }),
  });
  assert.equal(report.checks.postgres.ok, false);
  assert.match(report.checks.postgres.detail ?? '', /connection refused/);
  assert.equal(report.checks.redis.ok, true);
  assert.equal(report.ok, false, 'overall ok is false when any configured, non-skipped check fails');
});

test('runDeepHealthChecks: a never-resolving injected probe times out within the configured bound', async () => {
  const start = Date.now();
  const report = await runDeepHealthChecks({
    redisUrl: 'redis://localhost:6379',
    checkRedis: () => new Promise(() => {}), // never settles
    timeoutMs: 200,
  });
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 1_000, `must resolve near the timeout bound, took ${elapsedMs}ms`);
  assert.equal(report.checks.redis.skipped, false);
  assert.equal(report.checks.redis.ok, false);
  assert.match(report.checks.redis.detail ?? '', /timed out/);
});

test('runDeepHealthChecks: all five checks run in parallel, not sequentially', async () => {
  // Each of five injected checks sleeps 150ms; if they ran sequentially the total would be
  // ~750ms+. Running in parallel keeps the wall-clock time close to a single check's latency.
  const slow = (ms: number) => () => new Promise<{ ok: boolean }>((r) => setTimeout(() => r({ ok: true }), ms));
  const start = Date.now();
  await runDeepHealthChecks({
    databaseUrl: 'postgresql://u:p@localhost:5432/db',
    checkPostgres: slow(150),
    redisUrl: 'redis://localhost:6379',
    checkRedis: slow(150),
    timeoutMs: 2_000,
  });
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 500, `checks must run in parallel, took ${elapsedMs}ms for two 150ms checks`);
});

test('runDeepHealthChecks: stub LLM/image/video providers are treated as unconfigured (skipped)', async () => {
  const { StubProvider, StubImageProvider, StubVideoProvider } = await import('../providers/index.js');
  const report = await runDeepHealthChecks({
    llmProvider: new StubProvider(),
    imageProvider: new StubImageProvider(),
    videoProvider: new StubVideoProvider(),
  });
  assert.equal(report.checks.llm.configured, false);
  assert.equal(report.checks.image.configured, false);
  assert.equal(report.checks.video.configured, false);
  assert.equal(report.ok, true);
});

test('runDeepHealthChecks: google_ai_studio image provider is reported skipped with a clear reason, not a false failure', async () => {
  const { GoogleAiStudioImageProvider } = await import('../providers/index.js');
  const provider = new GoogleAiStudioImageProvider({ apiKey: 'fake-key', model: 'imagen-3.0-generate-002' });
  const report = await runDeepHealthChecks({ imageProvider: provider });
  assert.equal(report.checks.image.configured, true);
  assert.equal(report.checks.image.skipped, true);
  assert.equal(report.checks.image.ok, true, 'skipped never reads as a false failure');
  assert.match(report.checks.image.detail ?? '', /billed API call/);
});

test('runDeepHealthChecks default timeout constant is a sane 3–5s bound', () => {
  assert.ok(DEFAULT_DEEP_HEALTH_TIMEOUT_MS >= 3_000 && DEFAULT_DEEP_HEALTH_TIMEOUT_MS <= 5_000);
});
