/**
 * tests/tenancy.test.ts — BYOK + subscription model routing (tenancy/).
 *
 * Coverage (per the tenancy requirements):
 *   - ModelCatalog.resolve: explicit id, nearest-param-count selection, plan entitlements.
 *   - ProviderRouter BYOK path: uses the TENANT's baseUrl + key (verified via a fetch mock).
 *   - ProviderRouter subscription path: uses PLATFORM env keys (Hostinger / cloud), stub fallback.
 *   - Secrets: raw API keys NEVER appear in route metadata, logs, JSON, or error messages.
 *
 * Run: node --import tsx --test tests/tenancy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelCatalog,
  ModelResolutionError,
  createTenantProvider,
  createTenantRoute,
  defaultCatalog,
  effectiveParamCap,
  type ModelCatalogConfig,
  type Tenant,
} from '../tenancy/index.js';
import { OpenAiCompatibleProvider, StubProvider } from '../providers/index.js';

// A compact, self-contained catalog for deterministic tests (mirrors config/models.json shape).
const TEST_CONFIG: ModelCatalogConfig = {
  defaultModelId: 'mistral-7b',
  models: [
    { id: 'tinyllama', displayName: 'TinyLlama', parameterCount: 1.1, providerKind: 'openai_compatible', hosting: 'local', costMultiplier: 0, runsOn: ['local', 'byok'] },
    { id: 'phi', displayName: 'Phi-2', parameterCount: 2.7, providerKind: 'openai_compatible', hosting: 'local', costMultiplier: 0, runsOn: ['local', 'byok'] },
    { id: 'mistral-7b', displayName: 'Mistral 7B', parameterCount: 7, providerKind: 'openai_compatible', hosting: 'local', costMultiplier: 0, runsOn: ['local', 'byok'] },
    { id: 'llama3-8b-hostinger', displayName: 'Llama 3 8B', parameterCount: 8, providerKind: 'openai_compatible', hosting: 'hostinger', costMultiplier: 1, runsOn: ['hostinger', 'byok'] },
    { id: 'llama3-70b-hostinger', displayName: 'Llama 3 70B', parameterCount: 70, providerKind: 'openai_compatible', hosting: 'hostinger', costMultiplier: 6, runsOn: ['hostinger', 'byok'] },
    { id: 'gpt-4o-mini', displayName: 'GPT-4o mini', parameterCount: 8, providerKind: 'openai_compatible', hosting: 'cloud', costMultiplier: 2, runsOn: ['openai_compatible', 'byok'] },
  ],
};

function catalog(): ModelCatalog {
  return ModelCatalog.fromConfig(TEST_CONFIG);
}

/** A fetch mock that captures the URL + Authorization header and returns a valid chat response. */
function captureFetch(): { fetchImpl: typeof fetch; calls: Array<{ url: string; auth?: string }> } {
  const calls: Array<{ url: string; auth?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get('authorization') ?? undefined });
    return new Response(
      JSON.stringify({
        model: 'mock',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// ModelCatalog — resolution
// ---------------------------------------------------------------------------

test('the bundled config/models.json loads and includes local + hostinger models', () => {
  const c = defaultCatalog();
  assert.ok(c.get('tinyllama'));
  assert.ok(c.get('mistral-7b'));
  const hostinger = c.models.filter((m) => m.hosting === 'hostinger');
  assert.ok(hostinger.length > 0, 'expected at least one hostinger-hosted model');
  const local = c.models.filter((m) => m.hosting === 'local');
  assert.ok(local.length >= 3, 'expected several free local models');
});

test('resolve picks the exact model by id when the plan allows it', () => {
  const tenant: Tenant = { id: 't', plan: 'PRO' };
  const m = catalog().resolve(tenant, { modelId: 'gpt-4o-mini' });
  assert.equal(m.id, 'gpt-4o-mini');
});

test('resolve by param count picks the NEAREST allowed model', () => {
  const enterprise: Tenant = { id: 't', plan: 'ENTERPRISE' };
  const c = catalog();
  // 6B is closest to mistral-7b (7B).
  assert.equal(c.resolve(enterprise, { paramCount: 6 }).id, 'mistral-7b');
  // 60B is closest to llama3-70b.
  assert.equal(c.resolve(enterprise, { paramCount: 60 }).id, 'llama3-70b-hostinger');
  // 3B is closest to phi (2.7B).
  assert.equal(c.resolve(enterprise, { paramCount: 3 }).id, 'phi');
});

test('nearest-param selection respects plan entitlements (FREE caps at 7B, local only)', () => {
  const free: Tenant = { id: 't', plan: 'FREE' };
  // Even asking for 70B, FREE can only reach local <=7B; nearest allowed is mistral-7b.
  assert.equal(catalog().resolve(free, { paramCount: 70 }).id, 'mistral-7b');
});

test('a tenant maxActiveParams tightens the plan cap', () => {
  const tenant: Tenant = { id: 't', plan: 'PRO', maxActiveParams: 8 };
  assert.equal(effectiveParamCap(tenant), 8);
  const chosen = catalog().resolve(tenant, { paramCount: 70 });
  assert.ok(chosen.parameterCount <= 8, `expected <=8B, got ${chosen.parameterCount}`);
});

test('resolve throws when an explicit model is outside the plan entitlements', () => {
  const free: Tenant = { id: 't', plan: 'FREE' };
  assert.throws(() => catalog().resolve(free, { modelId: 'llama3-70b-hostinger' }), ModelResolutionError);
});

test('resolve falls back to preferredModelId, then default', () => {
  const c = catalog();
  const withPref: Tenant = { id: 't', plan: 'PRO', preferredModelId: 'gpt-4o-mini' };
  assert.equal(c.resolve(withPref).id, 'gpt-4o-mini');
  const noPref: Tenant = { id: 't', plan: 'PRO' };
  assert.equal(c.resolve(noPref).id, 'mistral-7b'); // catalog default
});

// ---------------------------------------------------------------------------
// ProviderRouter — BYOK path
// ---------------------------------------------------------------------------

test('BYOK routes to the TENANT key + baseUrl (not the platform)', async () => {
  const { fetchImpl, calls } = captureFetch();
  const tenant: Tenant = {
    id: 'byok-1',
    plan: 'BYOK',
    byokKeys: { openaiCompatible: { apiKey: 'sk-tenant-secret', baseUrl: 'https://tenant.example/v1' } },
  };
  // Platform env is set to a DIFFERENT endpoint to prove BYOK ignores it.
  const env = { HDV_HOSTINGER_LLM_BASE_URL: 'https://platform.example/v1', HDV_HOSTINGER_LLM_API_KEY: 'sk-platform' };
  const route = createTenantRoute(tenant, { catalog: catalog(), env, fetchImpl, request: { modelId: 'llama3-70b-hostinger' } });

  assert.equal(route.path, 'byok');
  assert.equal(route.billedTo, 'tenant');
  assert.equal(route.endpoint, 'https://tenant.example/v1');
  assert.ok(route.provider instanceof OpenAiCompatibleProvider);

  await route.provider.complete('hi');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://tenant.example/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer sk-tenant-secret');
});

test('BYOK plan without usable keys degrades to the subscription/stub path (no crash)', () => {
  const tenant: Tenant = { id: 'byok-2', plan: 'BYOK' }; // no keys
  const route = createTenantRoute(tenant, { catalog: catalog(), env: {}, request: { modelId: 'mistral-7b' } });
  assert.notEqual(route.path, 'byok');
  assert.equal(route.provider instanceof StubProvider, true);
});

// ---------------------------------------------------------------------------
// ProviderRouter — subscription (platform) path
// ---------------------------------------------------------------------------

test('subscription (hostinger) uses the PLATFORM base URL + key from env', async () => {
  const { fetchImpl, calls } = captureFetch();
  const tenant: Tenant = { id: 'starter-1', plan: 'STARTER' };
  const env = { HDV_HOSTINGER_LLM_BASE_URL: 'https://hostinger.hdv/v1', HDV_HOSTINGER_LLM_API_KEY: 'sk-platform-host' };
  const route = createTenantRoute(tenant, { catalog: catalog(), env, fetchImpl, request: { modelId: 'llama3-8b-hostinger' } });

  assert.equal(route.path, 'subscription');
  assert.equal(route.billedTo, 'platform');
  assert.equal(route.endpoint, 'https://hostinger.hdv/v1');

  await route.provider.complete('hi');
  assert.equal(calls[0].url, 'https://hostinger.hdv/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer sk-platform-host');
});

test('subscription (cloud) uses HDV_LLM_* platform env', async () => {
  const { fetchImpl, calls } = captureFetch();
  const tenant: Tenant = { id: 'pro-1', plan: 'PRO' };
  const env = { HDV_LLM_BASE_URL: 'https://cloud.hdv/v1', HDV_LLM_API_KEY: 'sk-cloud' };
  const route = createTenantRoute(tenant, { catalog: catalog(), env, fetchImpl, request: { modelId: 'gpt-4o-mini' } });
  assert.equal(route.path, 'subscription');
  await route.provider.complete('hi');
  assert.equal(calls[0].url, 'https://cloud.hdv/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer sk-cloud');
});

test('subscription degrades to the offline stub when platform env is missing', () => {
  const tenant: Tenant = { id: 'starter-2', plan: 'STARTER' };
  const route = createTenantRoute(tenant, { catalog: catalog(), env: {}, request: { modelId: 'llama3-8b-hostinger' } });
  assert.equal(route.path, 'stub');
  assert.ok(route.provider instanceof StubProvider);
});

test('FREE local model routes to the stub offline (no local endpoint configured)', () => {
  const tenant: Tenant = { id: 'free-1', plan: 'FREE' };
  const route = createTenantRoute(tenant, { catalog: catalog(), env: {} });
  assert.equal(route.path, 'stub');
  assert.equal(route.model.hosting, 'local');
});

test('local endpoint, when configured, is used for local models', async () => {
  const { fetchImpl, calls } = captureFetch();
  const tenant: Tenant = { id: 'free-2', plan: 'FREE' };
  const env = { HDV_LOCAL_LLM_BASE_URL: 'http://localhost:11434/v1' };
  const route = createTenantRoute(tenant, { catalog: catalog(), env, fetchImpl, request: { modelId: 'tinyllama' } });
  assert.equal(route.path, 'local');
  await route.provider.complete('hi');
  assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(calls[0].auth, undefined); // keyless local
});

test('createTenantProvider returns a usable provider directly', async () => {
  const tenant: Tenant = { id: 'p', plan: 'FREE' };
  const provider = createTenantProvider(tenant, { catalog: catalog(), env: {}, request: { paramCount: 7 } });
  const r = await provider.complete('hello');
  assert.ok(r.text.length > 0);
});

// ---------------------------------------------------------------------------
// Secrets — keys never leak into route metadata, logs, JSON, or errors
// ---------------------------------------------------------------------------

test('route metadata redacts keys and never contains the raw secret', () => {
  const tenant: Tenant = {
    id: 'byok-3',
    plan: 'BYOK',
    byokKeys: { openaiCompatible: { apiKey: 'sk-super-secret-value-123456', baseUrl: 'https://tenant.example/v1' } },
  };
  const route = createTenantRoute(tenant, { catalog: catalog(), request: { modelId: 'gpt-4o-mini' } });
  const serialized = JSON.stringify({ path: route.path, model: route.model, endpoint: route.endpoint, keyHint: route.keyHint, billedTo: route.billedTo });
  assert.ok(!serialized.includes('sk-super-secret-value-123456'), 'raw key must not appear in route metadata');
  assert.ok(route.keyHint.includes('redacted'));
});

test('platform key is not exposed in subscription route metadata', () => {
  const tenant: Tenant = { id: 'pro-2', plan: 'PRO' };
  const env = { HDV_LLM_BASE_URL: 'https://cloud.hdv/v1', HDV_LLM_API_KEY: 'sk-platform-cloud-secret' };
  const route = createTenantRoute(tenant, { catalog: catalog(), env, request: { modelId: 'gpt-4o-mini' } });
  const serialized = JSON.stringify(route, (_k, v) => (typeof v === 'function' ? undefined : v));
  assert.ok(!serialized.includes('sk-platform-cloud-secret'));
});

test('API keys never appear in error messages when the endpoint fails', async () => {
  const failingFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  const tenant: Tenant = {
    id: 'byok-4',
    plan: 'BYOK',
    byokKeys: { openaiCompatible: { apiKey: 'sk-leaky-key-should-not-appear', baseUrl: 'https://tenant.example/v1' } },
  };
  const provider = createTenantProvider(tenant, { catalog: catalog(), fetchImpl: failingFetch, request: { modelId: 'gpt-4o-mini' } });
  await assert.rejects(
    () => provider.complete('hi'),
    (err: unknown) => {
      const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      assert.ok(!text.includes('sk-leaky-key-should-not-appear'), 'raw key must not appear in errors');
      return true;
    },
  );
});
