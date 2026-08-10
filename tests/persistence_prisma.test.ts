/**
 * tests/persistence_prisma.test.ts — persistence backend selector + Prisma repositories
 * (RequestLog, NodeIdentity, SecurityAudit, IntentDocument, and CompanionMemory — companion/'s
 * opt-in relationship memory; see tests/companion_memory.test.ts for handler/gateway-level
 * coverage of that repository).
 *
 * The in-memory backend tests always run. The Prisma-backed tests require a reachable
 * Postgres and skip gracefully when DATABASE_URL is not set (see docker-compose.yml /
 * .env.example for local setup, then `npm run db:push`).
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { AgentRole } from '../config/routing_schema.js';
import {
  createRepositories,
  newRowId,
  type RepositoryBundle,
} from '../persistence/index.js';

// ---------------------------------------------------------------------------
// In-memory backend (default) — always runs, must never regress.
// ---------------------------------------------------------------------------

test('createRepositories() defaults to the in-memory backend', () => {
  const repos = createRepositories();
  assert.equal(repos.mode, 'memory');
});

test('memory backend: RequestLog ledger behaves as before', async () => {
  const repos = createRepositories('memory');
  const { requestLog } = repos;

  requestLog.save({
    id: newRowId('req'),
    packetId: 'pkt-1',
    timestamp: Date.now(),
    source: AgentRole.HOPE,
    destination: AgentRole.APEX,
    status: 'SUCCESS',
    cost_usd: 0.25,
    knollSignature: 'sig-1',
  });
  requestLog.save({
    id: newRowId('req'),
    packetId: 'pkt-2',
    timestamp: Date.now(),
    source: AgentRole.APEX,
    destination: AgentRole.KNOLL,
    status: 'BLOCKED',
    cost_usd: 0,
    knollSignature: 'sig-2',
  });

  assert.equal(requestLog.all().length, 2);
  assert.equal(requestLog.findByPacketId('pkt-1')?.status, 'SUCCESS');
  assert.equal(requestLog.countByStatus('BLOCKED'), 1);

  // Lifecycle helpers are no-ops for memory and must resolve.
  await repos.hydrate();
  await repos.flush();
  await repos.close();
});

test('memory backend: node registry, audit, and intent archive work', () => {
  const { nodeIdentity, securityAudit, intentArchive } = createRepositories('memory');

  nodeIdentity.upsert({
    node_id: 'node-a',
    role: AgentRole.VISION,
    status: 'ACTIVE',
    last_seen: Date.now(),
    is_ephemeral: true,
  });
  nodeIdentity.upsert({
    node_id: 'node-a',
    role: AgentRole.VISION,
    status: 'IDLE',
    last_seen: Date.now(),
    is_ephemeral: true,
  });
  assert.equal(nodeIdentity.all().length, 1, 'upsert replaces, not appends');
  assert.equal(nodeIdentity.countByStatus('IDLE'), 1);

  securityAudit.save({
    id: newRowId('aud'),
    packetId: 'pkt-1',
    outcome: 'BLOCKED',
    reasoning: 'endpoint not allowed',
    timestamp: Date.now(),
  });
  securityAudit.save({
    id: newRowId('aud'),
    packetId: 'pkt-2',
    outcome: 'ALLOWED',
    timestamp: Date.now(),
  });
  assert.equal(securityAudit.all().length, 2);
  assert.equal(securityAudit.blocked().length, 1);

  const intentId = randomUUID();
  intentArchive.save({
    id: intentId,
    utterance: 'simulate a rollout',
    kind: 'SIMULATE',
    entities: ['rollout'],
    goals: ['forecast'],
    constraints: [],
    suggestedDestination: AgentRole.DREAM,
    confidence: 0.9,
    documentedAt: Date.now(),
    clarificationNeeded: false,
  });
  intentArchive.save({
    id: randomUUID(),
    utterance: 'do the thing',
    kind: 'UNKNOWN',
    entities: [],
    goals: [],
    constraints: [],
    suggestedDestination: AgentRole.HOPE,
    confidence: 0.1,
    documentedAt: Date.now(),
    clarificationNeeded: true,
  });
  assert.equal(intentArchive.all().length, 2);
  assert.equal(intentArchive.get(intentId)?.kind, 'SIMULATE');
  assert.equal(intentArchive.needingClarification().length, 1);
});

test('memory backend: companion memory (companion/memory.ts) get/upsert/all behave as expected', () => {
  const { companionMemory } = createRepositories('memory');

  assert.equal(companionMemory.get('nobody'), undefined);

  companionMemory.upsert({ companionId: 'c-1', affectionLevel: 55, summary: 'first', turnCount: 1, updatedAt: 1 });
  companionMemory.upsert({ companionId: 'c-1', affectionLevel: 60, summary: 'second', turnCount: 2, updatedAt: 2 });
  assert.equal(companionMemory.all().length, 1, 'upsert replaces, not appends');
  assert.equal(companionMemory.get('c-1')?.summary, 'second');

  companionMemory.upsert({ companionId: 'c-2', affectionLevel: 50, summary: '', turnCount: 0, updatedAt: 3 });
  assert.equal(companionMemory.all().length, 2);
});

// ---------------------------------------------------------------------------
// Prisma backend — requires Postgres; skips gracefully without DATABASE_URL.
// ---------------------------------------------------------------------------

const noDatabase = !process.env.DATABASE_URL;
const skipPrisma = noDatabase ? 'DATABASE_URL not set — skipping Prisma tests' : false;

test(
  'prisma backend: write-through persists and re-hydrates across bundles',
  { skip: skipPrisma },
  async () => {
    const seed = randomUUID().slice(0, 8);
    let writer: RepositoryBundle | undefined;
    let reader: RepositoryBundle | undefined;

    try {
      writer = createRepositories('prisma');

      // Start from a clean slate for this table set.
      writer.requestLog.clear();
      writer.nodeIdentity.clear();
      writer.securityAudit.clear();
      writer.intentArchive.clear();
      writer.companionMemory.clear();
      await writer.flush();

      const packetId = `pkt-${seed}`;
      writer.requestLog.save({
        id: newRowId('req'),
        packetId,
        timestamp: Date.now(),
        source: AgentRole.HOPE,
        destination: AgentRole.APEX,
        status: 'SUCCESS',
        cost_usd: 1.5,
        knollSignature: `sig-${seed}`,
      });

      const nodeId = `node-${seed}`;
      writer.nodeIdentity.upsert({
        node_id: nodeId,
        role: AgentRole.VISION,
        status: 'ACTIVE',
        last_seen: Date.now(),
        is_ephemeral: true,
      });

      writer.securityAudit.save({
        id: newRowId('aud'),
        packetId,
        outcome: 'BLOCKED',
        reasoning: 'test-block',
        timestamp: Date.now(),
      });

      const intentId = randomUUID();
      writer.intentArchive.save({
        id: intentId,
        utterance: `utterance ${seed}`,
        kind: 'SIMULATE',
        entities: ['a', 'b'],
        goals: ['g1'],
        constraints: ['c1'],
        suggestedDestination: AgentRole.DREAM,
        confidence: 0.75,
        documentedAt: Date.now(),
        clarificationNeeded: true,
      });

      const companionId = `comp-${seed}`;
      writer.companionMemory.upsert({
        companionId,
        affectionLevel: 77,
        summary: `summary for ${seed}`,
        turnCount: 3,
        updatedAt: Date.now(),
      });

      // Synchronous reads are served from the write-through projection immediately.
      assert.equal(writer.requestLog.findByPacketId(packetId)?.cost_usd, 1.5);
      assert.equal(writer.nodeIdentity.get(nodeId)?.status, 'ACTIVE');
      assert.equal(writer.companionMemory.get(companionId)?.affectionLevel, 77);

      // Persist everything to Postgres.
      await writer.flush();

      // A fresh bundle hydrates purely from the durable store.
      reader = createRepositories('prisma');
      await reader.hydrate();

      const durableLog = reader.requestLog.findByPacketId(packetId);
      assert.ok(durableLog, 'request log persisted');
      assert.equal(durableLog?.status, 'SUCCESS');
      assert.equal(durableLog?.cost_usd, 1.5);
      assert.equal(durableLog?.source, AgentRole.HOPE);

      const durableNode = reader.nodeIdentity.get(nodeId);
      assert.ok(durableNode, 'node identity persisted');
      assert.equal(durableNode?.role, AgentRole.VISION);
      assert.equal(durableNode?.is_ephemeral, true);

      const durableBlocked = reader.securityAudit
        .blocked()
        .filter((r) => r.packetId === packetId);
      assert.equal(durableBlocked.length, 1);
      assert.equal(durableBlocked[0]?.reasoning, 'test-block');

      const durableIntent = reader.intentArchive.get(intentId);
      assert.ok(durableIntent, 'intent document persisted');
      assert.deepEqual(durableIntent?.entities, ['a', 'b']);
      assert.deepEqual(durableIntent?.goals, ['g1']);
      assert.equal(durableIntent?.confidence, 0.75);
      assert.equal(durableIntent?.clarificationNeeded, true);
      assert.ok(reader.intentArchive.needingClarification().some((r) => r.id === intentId));

      const durableMemory = reader.companionMemory.get(companionId);
      assert.ok(durableMemory, 'companion memory persisted');
      assert.equal(durableMemory?.affectionLevel, 77);
      assert.equal(durableMemory?.summary, `summary for ${seed}`);
      assert.equal(durableMemory?.turnCount, 3);
    } finally {
      // Best-effort cleanup so repeated runs stay isolated.
      if (writer) {
        writer.requestLog.clear();
        writer.nodeIdentity.clear();
        writer.securityAudit.clear();
        writer.intentArchive.clear();
        writer.companionMemory.clear();
        await writer.flush().catch(() => {});
        await writer.close().catch(() => {});
      }
      if (reader) await reader.close().catch(() => {});
    }
  },
);

test(
  'prisma backend: companion memory upsert overwrites in place (not append)',
  { skip: skipPrisma },
  async () => {
    let bundle: RepositoryBundle | undefined;
    try {
      bundle = createRepositories('prisma');
      const companionId = `comp-upsert-${randomUUID().slice(0, 8)}`;

      bundle.companionMemory.upsert({ companionId, affectionLevel: 50, summary: 'first', turnCount: 1, updatedAt: Date.now() });
      bundle.companionMemory.upsert({ companionId, affectionLevel: 62, summary: 'second', turnCount: 2, updatedAt: Date.now() });
      await bundle.flush();

      const reread = createRepositories('prisma');
      await reread.hydrate();
      const record = reread.companionMemory.get(companionId);
      assert.ok(record, 'companion memory persisted');
      assert.equal(record?.affectionLevel, 62);
      assert.equal(record?.summary, 'second');
      assert.equal(record?.turnCount, 2);
      await reread.close().catch(() => {});
    } finally {
      if (bundle) {
        bundle.companionMemory.clear();
        await bundle.flush().catch(() => {});
        await bundle.close().catch(() => {});
      }
    }
  },
);
