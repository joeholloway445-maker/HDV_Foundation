/**
 * tests/phase6.test.ts — Phase 6 foundations (offline, no infrastructure).
 *
 * Covers the code seams added for "scale the fleet":
 *   A. nodes/lease.ts   — NodeSliceLease: claim/renew/release, no double-claim, TTL expiry,
 *                         fencing tokens; RedisLeaseStub against a tiny in-memory fake RedisLike.
 *   B. apex/cost.ts     — GpuCostModel formula + optional wire into the ledger LogRequestInput
 *                         path WITHOUT breaking the ledger's defaults.
 *   C. nodes/parameters — base-vs-delta accounting (sharedBaseParams, deltaParamsPerPersona,
 *                         activeCostParams) reconciles and amortizes the naive figure.
 *   D. serving/         — VllmClient against offlineVllmFetch() (/v1/completions) + persona
 *                         adapters render/route/account with cheap per-persona deltas.
 *
 * Run: npm run test:phase6   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryNodeSliceLease,
  RedisLeaseStub,
  sliceKey,
  type RedisLike,
} from '../nodes/lease.js';
import { GpuCostModel, priceLogRequest } from '../apex/cost.js';
import { InMemoryLedger } from '../apex/ledger.js';
import { AgentRole } from '../config/routing_schema.js';
import {
  sharedBaseParams,
  deltaParamsPerPersona,
  activeCostParams,
  computeBaseVsDelta,
} from '../nodes/parameters.js';
import { MODEL_PARAMS } from '../nodes/constants.js';
import {
  VllmClient,
  VllmClientError,
  offlineVllmFetch,
} from '../serving/vllm_client.js';
import {
  createPersonaAdapter,
  renderPersonaRequest,
  completeWithPersona,
  accountPersonaBatch,
} from '../serving/persona_adapters.js';

// ---------------------------------------------------------------------------
// A. Node-slice leasing
// ---------------------------------------------------------------------------

test('sliceKey builds a canonical, unique key per node coordinate', () => {
  assert.equal(sliceKey({ agent: 'DREAM', manager: 3, node: 7 }), 'lease:node:DREAM/3/7');
  assert.notEqual(
    sliceKey({ agent: 'DREAM', manager: 3, node: 7 }),
    sliceKey({ agent: 'VISION', manager: 3, node: 7 }),
  );
});

test('InMemoryNodeSliceLease: claim → renew → release lifecycle', async () => {
  const lease = new InMemoryNodeSliceLease();
  const key = sliceKey({ agent: 'DREAM', manager: 0, node: 0 });

  const claim = await lease.claim(key, 'worker-a', 1000);
  assert.equal(claim.ok, true);
  assert.equal(claim.reason, 'ACQUIRED');
  assert.equal(claim.claim?.holder, 'worker-a');
  assert.equal(lease.holderOf(key), 'worker-a');

  const renew = await lease.renew(key, 'worker-a', 1000);
  assert.equal(renew.ok, true);
  assert.equal(renew.reason, 'RENEWED');

  const release = await lease.release(key, 'worker-a');
  assert.equal(release.ok, true);
  assert.equal(release.reason, 'RELEASED');
  assert.equal(lease.holderOf(key), undefined);
});

test('InMemoryNodeSliceLease: a second worker cannot double-claim a live slice', async () => {
  const lease = new InMemoryNodeSliceLease();
  const key = sliceKey({ agent: 'VISION', manager: 1, node: 1 });

  assert.equal((await lease.claim(key, 'worker-a', 5000)).ok, true);

  const contested = await lease.claim(key, 'worker-b', 5000);
  assert.equal(contested.ok, false);
  assert.equal(contested.reason, 'HELD_BY_OTHER');
  assert.equal(contested.heldBy, 'worker-a');

  // worker-b also cannot renew or release someone else's lease.
  assert.equal((await lease.renew(key, 'worker-b', 5000)).reason, 'HELD_BY_OTHER');
  assert.equal((await lease.release(key, 'worker-b')).reason, 'HELD_BY_OTHER');
  assert.equal(lease.holderOf(key), 'worker-a');
});

test('InMemoryNodeSliceLease: TTL expiry re-opens a crashed worker\'s slice', async () => {
  let t = 1_000_000;
  const lease = new InMemoryNodeSliceLease({ now: () => t });
  const key = sliceKey({ agent: 'DREAM', manager: 2, node: 5 });

  const a = await lease.claim(key, 'worker-a', 1000);
  assert.equal(a.ok, true);

  // Before expiry: still held by A.
  t += 999;
  assert.equal((await lease.claim(key, 'worker-b', 1000)).reason, 'HELD_BY_OTHER');

  // After expiry: B can take it, and A can no longer renew.
  t += 2;
  const b = await lease.claim(key, 'worker-b', 1000);
  assert.equal(b.ok, true);
  assert.equal(b.reason, 'ACQUIRED');
  assert.equal(lease.holderOf(key), 'worker-b');
  assert.equal((await lease.renew(key, 'worker-a', 1000)).reason, 'HELD_BY_OTHER');
});

test('InMemoryNodeSliceLease: fencing token advances across holders, stable on re-claim', async () => {
  let t = 0;
  const lease = new InMemoryNodeSliceLease({ now: () => t });
  const key = sliceKey({ agent: 'DREAM', manager: 0, node: 9 });

  const a1 = await lease.claim(key, 'worker-a', 100);
  const a2 = await lease.claim(key, 'worker-a', 100); // idempotent re-claim
  assert.equal(a1.claim?.fencingToken, a2.claim?.fencingToken, 'same holder keeps its token');

  t += 200; // let it expire
  const b = await lease.claim(key, 'worker-b', 100);
  assert.ok((b.claim?.fencingToken ?? 0) > (a1.claim?.fencingToken ?? 0), 'new holder gets a higher token');
});

test('InMemoryNodeSliceLease: release on a free key is NOT_HELD (idempotent, not fatal)', async () => {
  const lease = new InMemoryNodeSliceLease();
  const res = await lease.release(sliceKey({ agent: 'DREAM', manager: 0, node: 0 }), 'worker-a');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'NOT_HELD');
});

// A tiny in-memory RedisLike that implements just the SET NX PX / GET / PEXPIRE / DEL surface.
function makeFakeRedis(now: () => number): RedisLike {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string): { value: string; expiresAt: number } | undefined => {
    const e = store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
    return e;
  };
  return {
    async set(key, value, opts) {
      const existing = live(key);
      if (opts?.nx && existing) return null;
      store.set(key, { value, expiresAt: now() + (opts?.pxMs ?? 30_000) });
      return 'OK';
    },
    async get(key) {
      return live(key)?.value ?? null;
    },
    async pexpire(key, ms) {
      const e = live(key);
      if (!e) return 0;
      e.expiresAt = now() + ms;
      return 1;
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
  };
}

test('RedisLeaseStub: SET NX PX acquire, no double-claim, compare-and-delete release', async () => {
  let t = 0;
  const redis = makeFakeRedis(() => t);
  const lease = new RedisLeaseStub({ redis, now: () => t });
  const key = sliceKey({ agent: 'VISION', manager: 4, node: 4 });

  const a = await lease.claim(key, 'worker-a', 1000);
  assert.equal(a.ok, true);
  assert.equal(a.reason, 'ACQUIRED');

  const b = await lease.claim(key, 'worker-b', 1000);
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'HELD_BY_OTHER');
  assert.equal(b.heldBy, 'worker-a');

  // Idempotent re-claim by the holder refreshes TTL.
  assert.equal((await lease.claim(key, 'worker-a', 1000)).reason, 'RENEWED');

  // A non-holder cannot release; the holder can.
  assert.equal((await lease.release(key, 'worker-b')).reason, 'HELD_BY_OTHER');
  assert.equal((await lease.release(key, 'worker-a')).ok, true);

  // After release it is free again.
  assert.equal((await lease.claim(key, 'worker-b', 1000)).ok, true);
});

test('RedisLeaseStub: PX TTL expiry re-opens the slice', async () => {
  let t = 0;
  const redis = makeFakeRedis(() => t);
  const lease = new RedisLeaseStub({ redis, now: () => t });
  const key = sliceKey({ agent: 'DREAM', manager: 5, node: 5 });

  assert.equal((await lease.claim(key, 'worker-a', 500)).ok, true);
  t += 501;
  const b = await lease.claim(key, 'worker-b', 500);
  assert.equal(b.ok, true);
  assert.equal(b.reason, 'ACQUIRED');
  // A stale holder cannot renew after expiry.
  assert.equal((await lease.renew(key, 'worker-a', 500)).reason, 'HELD_BY_OTHER');
});

// ---------------------------------------------------------------------------
// B. GPU cost model + ledger wiring
// ---------------------------------------------------------------------------

test('GpuCostModel: costUsd = gpuSeconds × ratePerSecond × (activeParams / 1e9)', () => {
  const model = new GpuCostModel({ ratePerSecond: 0.0004 });
  // 10 GPU-seconds, 7e9 active params (one 7B) → 10 × 0.0004 × 7 = 0.028
  assert.equal(model.costUsd({ gpuSeconds: 10, activeParams: 7e9 }), 0.028);
  // Zero active params → zero cost (idle ≈ $0).
  assert.equal(model.costUsd({ gpuSeconds: 10, activeParams: 0 }), 0);
  // Per-call rate override.
  assert.equal(model.costUsd({ gpuSeconds: 1, activeParams: 1e9, ratePerSecond: 0.01 }), 0.01);
});

test('GpuCostModel: clamps negative/NaN inputs to zero (no negative or NaN charges)', () => {
  const model = new GpuCostModel({ ratePerSecond: 0.001 });
  assert.equal(model.costUsd({ gpuSeconds: -5, activeParams: 7e9 }), 0);
  assert.equal(model.costUsd({ gpuSeconds: 5, activeParams: Number.NaN }), 0);
  assert.throws(() => new GpuCostModel({ ratePerSecond: -1 }));
});

test('GpuCostModel: minUsd floors a billable execution', () => {
  const model = new GpuCostModel({ ratePerSecond: 0.0001, minUsd: 0.01 });
  // Tiny run would be < 0.01 → floored to 0.01; but a zero run stays zero.
  assert.equal(model.costUsd({ gpuSeconds: 0.001, activeParams: 1e6 }), 0.01);
  assert.equal(model.costUsd({ gpuSeconds: 0, activeParams: 0 }), 0);
});

test('GpuCostModel wires optionally into the ledger path without breaking defaults', () => {
  const ledger = new InMemoryLedger();
  const base = {
    packetId: 'pkt_1',
    source: AgentRole.APEX,
    destination: AgentRole.DREAM,
    status: 'SUCCESS' as const,
    knollSignature: 'sig',
  };

  // Default path: no cost model → cost_usd defaults to 0 (unchanged ledger behavior).
  const defaulted = ledger.logRequest(base);
  assert.equal(defaulted.cost_usd, 0);

  // Opt-in path: price the SAME base input through the model, then log it.
  const model = new GpuCostModel({ ratePerSecond: 0.0004 });
  const priced = priceLogRequest(base, model, { gpuSeconds: 10, activeParams: 7e9 });
  const logged = ledger.logRequest(priced);
  assert.equal(logged.cost_usd, 0.028);

  // priceLogRequest returns a COPY; the base input is untouched.
  assert.equal((base as { cost_usd?: number }).cost_usd, undefined);
  assert.equal(ledger.totalCost(), 0.028);
});

// ---------------------------------------------------------------------------
// C. Base-vs-delta parameter accounting
// ---------------------------------------------------------------------------

test('deltaParamsPerPersona: cheap delta vs a 7B base; rank 0 = pure prompt (zero weights)', () => {
  const d = deltaParamsPerPersona(); // rank 16 default
  assert.ok(d > 0);
  assert.ok(d < MODEL_PARAMS / 100, 'a persona delta is <1% of a 7B base');
  assert.equal(deltaParamsPerPersona(0), 0, 'a prompt/sampling-only persona adds no weights');
  assert.ok(deltaParamsPerPersona(32) > deltaParamsPerPersona(16), 'higher rank ⇒ larger delta');
});

test('sharedBaseParams: 7B counted once per replica', () => {
  assert.equal(sharedBaseParams(1), MODEL_PARAMS);
  assert.equal(sharedBaseParams(3), 3 * MODEL_PARAMS);
  assert.equal(sharedBaseParams(0), 0);
});

test('activeCostParams / computeBaseVsDelta: honest footprint amortizes the naive figure', () => {
  const activePersonas = 100;
  const usage = computeBaseVsDelta({ activePersonas, replicas: 1 });

  // Reconciliation: base + delta == activeCostParams, and the helper matches the breakdown.
  assert.equal(
    usage.sharedBaseParams + usage.deltaParams,
    usage.activeCostParams,
    'base + delta reconciles',
  );
  assert.equal(activeCostParams({ activePersonas, replicas: 1 }), usage.activeCostParams);

  // The naive figure (full 7B per persona) is much larger than the honest shared figure.
  assert.equal(usage.naiveActiveParams, activePersonas * MODEL_PARAMS);
  assert.ok(usage.activeCostParams < usage.naiveActiveParams, 'shared serving is cheaper');
  assert.ok(usage.amortizationRatio < 1 && usage.amortizationRatio > 0);

  // Idle ⇒ only the base is resident (or zero base with zero replicas).
  assert.equal(activeCostParams({ activePersonas: 0, replicas: 1 }), MODEL_PARAMS);
  assert.equal(activeCostParams({ activePersonas: 0, replicas: 0 }), 0);
});

test('GpuCostModel prices the honest activeCostParams, not the naive figure', () => {
  const model = new GpuCostModel({ ratePerSecond: 0.0004 });
  const honest = activeCostParams({ activePersonas: 100, replicas: 1 });
  const naive = 100 * MODEL_PARAMS;
  const honestCost = model.costUsd({ gpuSeconds: 5, activeParams: honest });
  const naiveCost = model.costUsd({ gpuSeconds: 5, activeParams: naive });
  assert.ok(honestCost < naiveCost, 'shared-serving cost is strictly lower than naive per-persona cost');
});

// ---------------------------------------------------------------------------
// D. Serving seam — vLLM client (offline) + persona adapters
// ---------------------------------------------------------------------------

test('VllmClient: completes against the offline /v1/completions mock (deterministic)', async () => {
  const client = new VllmClient({
    baseUrl: 'http://vllm:8000/v1',
    model: 'offline-7b',
    fetchImpl: offlineVllmFetch(),
  });
  const a = await client.complete('simulate three market outcomes for a launch');
  const b = await client.complete('simulate three market outcomes for a launch');
  assert.ok(a.text.length > 0);
  assert.equal(a.model, 'offline-7b');
  assert.deepEqual(a, b, 'offline mock is deterministic');
  assert.ok(a.usage.totalTokens > 0);
});

test('VllmClient: never leaks the API key via JSON serialization', async () => {
  const client = new VllmClient({
    baseUrl: 'http://vllm:8000/v1',
    model: 'offline-7b',
    apiKey: 'super-secret-key',
    fetchImpl: offlineVllmFetch(),
  });
  const serialized = JSON.stringify(client);
  assert.equal(serialized.includes('super-secret-key'), false);
  assert.equal(JSON.parse(serialized).model, 'offline-7b');
});

test('VllmClient: surfaces a non-2xx as a VllmClientError', async () => {
  const failing: typeof fetch = (async () =>
    new Response('boom', { status: 503 })) as unknown as typeof fetch;
  const client = new VllmClient({ baseUrl: 'http://vllm:8000/v1', model: 'x', fetchImpl: failing });
  await assert.rejects(() => client.complete('hello'), (err: unknown) => {
    assert.ok(err instanceof VllmClientError);
    assert.equal(err.status, 503);
    return true;
  });
});

test('persona adapters: cheap delta, prompt assembly, and per-request options', () => {
  const adapter = createPersonaAdapter({
    personaId: 'DREAM/0/0#42',
    baseModel: 'shared-7b',
    systemPrompt: 'You are a cautious market simulator.',
    loraId: 'lora-market-v1',
    loraRank: 16,
    sampling: { temperature: 0.1, maxTokens: 64 },
  });
  assert.equal(adapter.deltaParams, deltaParamsPerPersona(16));

  const rendered = renderPersonaRequest(adapter, 'What happens if we cut price 10%?');
  assert.ok(rendered.prompt.startsWith('You are a cautious market simulator.'));
  assert.ok(rendered.prompt.includes('cut price 10%'));
  assert.equal(rendered.options.model, 'shared-7b');
  assert.equal(rendered.options.loraId, 'lora-market-v1');
  assert.equal(rendered.options.temperature, 0.1);
  assert.equal(rendered.options.maxTokens, 64);
});

test('persona adapters: completeWithPersona routes through the vLLM client (offline)', async () => {
  const client = new VllmClient({
    baseUrl: 'http://vllm:8000/v1',
    model: 'shared-7b',
    fetchImpl: offlineVllmFetch(),
  });
  const adapter = createPersonaAdapter({ personaId: 'p1', baseModel: 'shared-7b', loraRank: 0 });
  const out = await completeWithPersona(client, adapter, 'render outcomes');
  assert.ok(out.text.length > 0);
  assert.equal(adapter.deltaParams, 0, 'a prompt-only persona has zero delta weights');
});

test('persona adapters: a node batch shares one base model and sums only cheap deltas', () => {
  const adapters = Array.from({ length: 100 }, (_v, i) =>
    createPersonaAdapter({ personaId: `p${i}`, baseModel: 'shared-7b', loraRank: 16 }),
  );
  const acct = accountPersonaBatch(adapters);
  assert.equal(acct.personaCount, 100);
  assert.deepEqual(acct.baseModels, ['shared-7b'], 'one shared base ⇒ maximal weight sharing');
  assert.equal(acct.totalDeltaParams, 100 * deltaParamsPerPersona(16));
  assert.ok(acct.totalDeltaParams < MODEL_PARAMS, '100 deltas still cost less than one 7B base');
});
