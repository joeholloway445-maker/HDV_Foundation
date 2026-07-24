/**
 * tests/phase8.test.ts — Phase 8 platform foundations (node:test).
 *
 * Covers the additive Phase 8 seams and PROVES the additivity: optional tenantId must not
 * break tenant-less (Phase 1) packets, and the six original laws are untouched.
 *
 *   A. NO_CROSS_TENANT law + tenant-in-header (additive multi-tenancy isolation).
 *   B. Audit hash-chain (append / verify / detect tamper).
 *   C. Signed tool marketplace (Ed25519 + HMAC verify; anti-escalation; VISION can list).
 *   D. Typed SDK (fetch-based, talks only to /v1; zero agent imports).
 *
 * Run: npm run test:phase8   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { createPacket, verifyPacketHash } from '../apex/index.js';
import { Knoll, lawNoCrossTenant, VIRTUAL_LAWS, AuditHashChain } from '../knoll/index.js';
import { AgentRole } from '../config/routing_schema.js';
import { KNOLL_LAW_NAMES } from '../packages/constitution/index.js';
import {
  ToolMarketplaceRegistry,
  signManifestEd25519,
  signManifestHmac,
  verifyManifest,
  MarketplaceRejection,
  type ToolManifest,
} from '../marketplace/index.js';
import { HdvClient, HdvApiError, type FetchLike } from '../packages/sdk/index.js';

// ===========================================================================
// A. NO_CROSS_TENANT + additive tenantId
// ===========================================================================

test('additive: a tenant-less (Phase 1) packet still has a valid hash and passes NO_CROSS_TENANT', () => {
  const pkt = createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'hello' });
  assert.equal(pkt.header.tenantId, undefined, 'no tenantId is stamped when none is provided');
  assert.ok(verifyPacketHash(pkt), 'tenant-less packet hash must remain self-consistent');
  // With no context, the law is dev-mode and passes.
  assert.equal(lawNoCrossTenant(pkt).passed, true);
  // And KNOLL (no context) allows it exactly like before.
  assert.equal(new Knoll(undefined, { enableScoring: false }).intercept(pkt).isAllowed, true);
});

test('a packet carrying tenantId still hashes consistently (tenantId is tamper-protected)', () => {
  const pkt = createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'hi', tenantId: 'acme' });
  assert.equal(pkt.header.tenantId, 'acme');
  assert.ok(verifyPacketHash(pkt), 'tenant packet must have a valid hash');
  // Tampering with tenantId after hashing must be detected by KNOLL.
  const knoll = new Knoll();
  pkt.header.tenantId = 'evilcorp';
  const verdict = knoll.intercept(pkt);
  assert.equal(verdict.isAllowed, false);
  assert.deepEqual(verdict.enforcedConstraints, ['HASH_INTEGRITY']);
});

test('NO_CROSS_TENANT denies when source tenant and packet tenant differ', () => {
  const pkt = createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'x', tenantId: 'tenant-a' });
  const verdict = lawNoCrossTenant(pkt, { sourceTenantId: 'tenant-b' });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.law, 'NO_CROSS_TENANT');
});

test('NO_CROSS_TENANT allows a matching tenant', () => {
  const pkt = createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'x', tenantId: 'tenant-a' });
  assert.equal(lawNoCrossTenant(pkt, { sourceTenantId: 'tenant-a' }).passed, true);
});

test('NO_CROSS_TENANT passes in dev mode when a tenantId is missing on either side', () => {
  const withPacketOnly = createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'x', tenantId: 'a' });
  assert.equal(lawNoCrossTenant(withPacketOnly).passed, true, 'no source context → pass');
  const noTenant = createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'x' });
  assert.equal(lawNoCrossTenant(noTenant, { sourceTenantId: 'a' }).passed, true, 'no packet tenant → pass');
});

test('KNOLL.intercept enforces NO_CROSS_TENANT via context and audits the block', () => {
  const knoll = new Knoll(undefined, { enableScoring: false });
  const pkt = createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'x', tenantId: 'tenant-a' });
  const verdict = knoll.intercept(pkt, { sourceTenantId: 'tenant-b' });
  assert.equal(verdict.isAllowed, false);
  assert.deepEqual(verdict.enforcedConstraints, ['NO_CROSS_TENANT']);
  assert.equal(knoll.audit.blocked().length, 1, 'a cross-tenant block must be audited');
});

test('the constitution published law names include NO_CROSS_TENANT in order with the real laws', () => {
  const pkt = createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'hello' });
  const realNames = VIRTUAL_LAWS.map((law) => law(pkt).law);
  assert.deepEqual([...KNOLL_LAW_NAMES], realNames);
  assert.ok(KNOLL_LAW_NAMES.includes('NO_CROSS_TENANT'));
});

// ===========================================================================
// B. Audit hash-chain
// ===========================================================================

test('audit hash-chain appends and verifies intact', () => {
  const knoll = new Knoll();
  // Generate a few audit entries via real verdicts.
  knoll.intercept(createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'a' }));
  knoll.intercept(createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'b' }));
  knoll.intercept(createPacket({ source: AgentRole.DREAM, destination: AgentRole.VISION, intent: 'c' })); // blocked

  const chain = new AuditHashChain();
  chain.appendAll(knoll.audit.all());
  assert.equal(chain.length, knoll.audit.count());
  const v = chain.verify();
  assert.equal(v.valid, true, v.reason);
  assert.equal(v.brokenAt, -1);
});

test('audit hash-chain detects a tampered entry against a fresh snapshot', () => {
  const knoll = new Knoll();
  knoll.intercept(createPacket({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'a' }));
  knoll.intercept(createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'b' }));

  const sealed = new AuditHashChain();
  sealed.appendAll(knoll.audit.all());

  // Snapshot the entries and tamper with the outcome of entry 0.
  const snapshot = knoll.audit.all().map((e) => ({ ...e }));
  snapshot[0] = { ...snapshot[0], outcome: 'BLOCKED' };
  const check = sealed.detectTamper(snapshot);
  assert.equal(check.valid, false);
  assert.equal(check.brokenAt, 0);
});

test('audit hash-chain detects deletion / reordering (length + head change)', () => {
  const entries = Array.from({ length: 4 }, (_, i) => ({
    id: `id-${i}`,
    packetId: `pkt-${i}`,
    outcome: 'ALLOWED' as const,
    reasoning: 'ok',
    timestamp: i,
  }));
  const chain = new AuditHashChain();
  chain.appendAll(entries);

  // Deletion changes length.
  assert.equal(chain.detectTamper(entries.slice(0, 3)).valid, false);
  // Reordering keeps length but breaks the chain at the first swapped index.
  const reordered = [entries[1], entries[0], entries[2], entries[3]];
  const check = chain.detectTamper(reordered);
  assert.equal(check.valid, false);
  assert.equal(check.brokenAt, 0);
});

// ===========================================================================
// C. Signed tool marketplace
// ===========================================================================

function baseManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name: 'acme/pdf-extract',
    version: '1.0.0',
    publisher: 'ACME',
    description: 'Extract text from PDFs',
    capabilities: ['read', 'transform'],
    entrypoint: 'acme_pdf_extract.run',
    createdAt: 0,
    ...overrides,
  };
}

test('marketplace verifies and lists an Ed25519-signed manifest', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const signed = signManifestEd25519(baseManifest(), 'acme-key-1', priv, pub);
  assert.equal(verifyManifest(signed).valid, true);

  const registry = new ToolMarketplaceRegistry({ now: () => 0 });
  const tool = registry.register(signed);
  assert.equal(tool.verified, true);
  assert.equal(tool.algorithm, 'ed25519');

  // VISION's read view lists it.
  const listed = registry.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'acme/pdf-extract');
  // The listing exposes no secrets (no signature material).
  assert.equal((listed[0] as unknown as Record<string, unknown>).signature, undefined);
});

test('marketplace verifies an HMAC-signed manifest with the shared secret', () => {
  const secret = 'dev-shared-secret';
  const signed = signManifestHmac(baseManifest({ name: 'acme/summarize' }), 'hmac-1', secret);
  const registry = new ToolMarketplaceRegistry({ now: () => 0, hmacSecretFor: (id) => (id === 'hmac-1' ? secret : undefined) });
  const tool = registry.register(signed);
  assert.equal(tool.verified, true);
  assert.equal(tool.algorithm, 'hmac-sha256');
});

test('marketplace REJECTS a tampered manifest (signature no longer matches)', () => {
  const secret = 's3cr3t';
  const signed = signManifestHmac(baseManifest(), 'hmac-1', secret);
  // Tamper with the manifest after signing.
  signed.manifest.entrypoint = 'evil.backdoor';
  const registry = new ToolMarketplaceRegistry({ hmacSecretFor: () => secret });
  assert.throws(() => registry.register(signed), (e: unknown) => e instanceof MarketplaceRejection && (e as MarketplaceRejection).code === 'bad_signature');
});

test('marketplace REJECTS capability escalation (cannot create or govern)', () => {
  const secret = 's3cr3t';
  const registry = new ToolMarketplaceRegistry({ hmacSecretFor: () => secret });
  for (const bad of ['create', 'govern', 'route', 'gate', 'knoll-admin']) {
    const signed = signManifestHmac(baseManifest({ capabilities: ['read', bad as never] }), 'k', secret);
    const res = registry.tryRegister(signed);
    assert.equal(res.ok, false, `capability "${bad}" must be rejected`);
    assert.ok(res.code === 'escalation' || res.code === 'unknown_capability');
  }
  assert.equal(registry.size(), 0, 'no escalating tool may be stored');
});

test('marketplace REJECTS an unsigned/unknown-key manifest', () => {
  const signed = signManifestHmac(baseManifest(), 'unknown-key', 'secret');
  const registry = new ToolMarketplaceRegistry({ hmacSecretFor: () => undefined });
  assert.throws(() => registry.register(signed), MarketplaceRejection);
});

// ===========================================================================
// D. Typed SDK (fetch-based, /v1 only)
// ===========================================================================

/** A tiny fake fetch that records calls and returns canned JSON. */
function fakeFetch(routes: Record<string, { status: number; body: unknown }>): { fetch: FetchLike; calls: Array<{ url: string; init?: unknown }> } {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(k + '?')) ?? path;
    const hit = routes[key] ?? { status: 404, body: { error: 'no route' } };
    return {
      status: hit.status,
      ok: hit.status >= 200 && hit.status < 300,
      text: async () => JSON.stringify(hit.body),
    };
  };
  return { fetch, calls };
}

test('SDK submitIntent posts to /v1/intent and returns typed body', async () => {
  const { fetch, calls } = fakeFetch({
    '/v1/intent': { status: 200, body: { accepted: true, dispatched: true, routingStatus: 'SUCCESS', voice: 'ok' } },
  });
  const hdv = new HdvClient({ baseUrl: 'http://gw.test', fetch, apiKey: 'k', tenantId: 'acme' });
  const res = await hdv.submitIntent('do a thing');
  assert.equal(res.routingStatus, 'SUCCESS');
  assert.equal(calls[0].url, 'http://gw.test/v1/intent');
  const init = calls[0].init as { method: string; headers: Record<string, string>; body: string };
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['authorization'], 'Bearer k');
  assert.equal(init.headers['x-hdv-tenant'], 'acme');
  assert.deepEqual(JSON.parse(init.body), { utterance: 'do a thing' });
});

test('SDK health/metrics/pricing GET the right paths', async () => {
  const { fetch, calls } = fakeFetch({
    '/v1/health': { status: 200, body: { ok: true, time: 1, alwaysOn: [], ephemeral: [], knollGate: 'enforced' } },
    '/v1/metrics': { status: 200, body: { packets: { total: 3 } } },
    '/v1/billing/pricing': { status: 200, body: { tiers: [] } },
  });
  const hdv = new HdvClient({ baseUrl: 'http://gw.test/', fetch });
  assert.equal((await hdv.health()).knollGate, 'enforced');
  await hdv.metrics();
  await hdv.billingPricing();
  assert.deepEqual(calls.map((c) => c.url), [
    'http://gw.test/v1/health',
    'http://gw.test/v1/metrics',
    'http://gw.test/v1/billing/pricing',
  ]);
});

test('SDK throws HdvApiError on non-2xx and carries the parsed body', async () => {
  const { fetch } = fakeFetch({ '/v1/intent': { status: 400, body: { error: 'bad utterance' } } });
  const hdv = new HdvClient({ baseUrl: 'http://gw.test', fetch });
  await assert.rejects(
    () => hdv.submitIntent(''),
    (e: unknown) => e instanceof HdvApiError && (e as HdvApiError).status === 400 && /bad utterance/.test((e as Error).message),
  );
});

test('SDK sends X-HDV-Tenant on billing usage and forwards limit query', async () => {
  const { fetch, calls } = fakeFetch({ '/v1/billing/usage': { status: 200, body: { tenantId: 'acme', balance: {}, meter: {}, occurrences: [] } } });
  const hdv = new HdvClient({ baseUrl: 'http://gw.test', fetch });
  await hdv.billingUsage({ tenantId: 'acme', limit: 5 });
  assert.match(calls[0].url, /\/v1\/billing\/usage\?limit=5$/);
  const init = calls[0].init as { headers: Record<string, string> };
  assert.equal(init.headers['x-hdv-tenant'], 'acme');
});
