/**
 * tests/companion_memory.test.ts — opt-in companion relationship memory (companion/memory.ts,
 * persistence/repositories.ts's CompanionMemoryRepository, GET /v1/companion/memory).
 *
 * Coverage:
 *   A. companion/memory.ts — buildMemoryContext, updateMemoryAfterTurn, defaultCompanionMemory.
 *      Must never crash and never require a provider (offline/stub path).
 *   B. handleCompanionChat — memory folded into the system prompt when BOTH companionId and a
 *      memoryRepository are present; regression guard proving behavior is UNCHANGED (byte-for-
 *      byte identical system prompt, no repository writes) when either is absent.
 *   C. persistence/repositories.ts — InMemoryCompanionMemoryRepository default behavior.
 *   D. Gateway integration (real HTTP) — GET /v1/companion/memory (public, rate-limited, never
 *      404s), and a full POST chat -> GET memory round trip through HopeGateway.
 *
 * Run: node --import tsx --test tests/companion_memory.test.ts   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import {
  parseCompanionChatInput,
  CompanionChatValidationError,
  handleCompanionChat,
  buildMemoryContext,
  updateMemoryAfterTurn,
  defaultCompanionMemory,
} from '../companion/index.js';
import { HopeGateway } from '../gateway/index.js';
import { InMemoryCompanionMemoryRepository } from '../persistence/index.js';
import type { CompanionMemoryRecord } from '../persistence/index.js';
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
  constructor(private readonly impl: (prompt: string, opts?: CompleteOptions) => Promise<CompletionResult> | CompletionResult) {}
  async complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
    return this.impl(prompt, opts);
  }
}

/** Fire-and-forget memory writes land on a later microtask/tick; give them room to settle. */
function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// A. companion/memory.ts
// ---------------------------------------------------------------------------

test('defaultCompanionMemory produces sane, mid-range defaults', () => {
  const memory = defaultCompanionMemory('abc123');
  assert.equal(memory.companionId, 'abc123');
  assert.equal(memory.affectionLevel, 50);
  assert.equal(memory.summary, '');
  assert.equal(memory.turnCount, 0);
  assert.equal(typeof memory.updatedAt, 'number');
});

test('buildMemoryContext folds level + summary into one line, with a friendly default for a blank summary', () => {
  const fresh = defaultCompanionMemory('c1');
  const freshCtx = buildMemoryContext(fresh);
  assert.match(freshCtx, /Current affection level: 50\/100/);
  assert.match(freshCtx, /no shared history yet/i);

  const established: CompanionMemoryRecord = {
    companionId: 'c1',
    affectionLevel: 72,
    summary: 'They talked about hiking trips.',
    turnCount: 4,
    updatedAt: Date.now(),
  };
  const ctx = buildMemoryContext(established);
  assert.match(ctx, /Relationship history: They talked about hiking trips\./);
  assert.match(ctx, /Current affection level: 72\/100/);
});

test('updateMemoryAfterTurn never crashes and needs no provider (offline/stub path)', async () => {
  const memory = defaultCompanionMemory('c2');
  const updated = await updateMemoryAfterTurn(memory, 'hi there', 'Hey you.');
  assert.equal(updated.companionId, 'c2');
  assert.equal(updated.turnCount, 1);
  assert.ok(updated.summary.length > 0);
  assert.ok(updated.affectionLevel >= 0 && updated.affectionLevel <= 100);
});

test('updateMemoryAfterTurn nudges affection up on warm messages, down on hostile ones, clamped 0-100', async () => {
  const base = defaultCompanionMemory('c3');
  const warm = await updateMemoryAfterTurn(base, 'I love talking to you, thank you so much!', 'Aw, thank you.');
  assert.ok(warm.affectionLevel > base.affectionLevel, 'warm message should raise affection');

  const hostile = await updateMemoryAfterTurn(base, 'I hate you, you are so annoying and stupid', 'Ouch.');
  assert.ok(hostile.affectionLevel < base.affectionLevel, 'hostile message should lower affection');

  // Repeated hostility across many turns must clamp at the floor, never go negative.
  let m = base;
  for (let i = 0; i < 50; i += 1) {
    m = await updateMemoryAfterTurn(m, 'I hate you, you are worthless and dumb', 'Ouch.');
  }
  assert.equal(m.affectionLevel, 0);

  // Repeated warmth clamps at the ceiling, never exceeds 100.
  let m2 = base;
  for (let i = 0; i < 50; i += 1) {
    m2 = await updateMemoryAfterTurn(m2, 'I love you, you are amazing, thank you', 'I adore you too.');
  }
  assert.equal(m2.affectionLevel, 100);
});

test('updateMemoryAfterTurn caps the rolling summary length across many turns', async () => {
  let m = defaultCompanionMemory('c4');
  for (let i = 0; i < 50; i += 1) {
    m = await updateMemoryAfterTurn(
      m,
      `This is a fairly long user message number ${i} with plenty of words to pad it out.`,
      `And here is an equally long companion reply number ${i} to match, padded further still.`,
    );
  }
  assert.equal(m.turnCount, 50);
  assert.ok(m.summary.length <= 620, `summary should stay capped, got ${m.summary.length} chars`);
  // The cap keeps the TAIL (most recent exchange), not the head.
  assert.match(m.summary, /49/);
});

// ---------------------------------------------------------------------------
// B. handleCompanionChat — opt-in wiring + regression guard
// ---------------------------------------------------------------------------

test('handleCompanionChat folds memory context into the system prompt when companionId + memoryRepository are both present', async () => {
  const repo = new InMemoryCompanionMemoryRepository();
  repo.upsert({ companionId: 'comp-1', affectionLevel: 88, summary: 'We bonded over coffee.', turnCount: 3, updatedAt: Date.now() });

  const provider = new FakeProvider(async (_prompt, opts) => {
    assert.ok(opts?.system?.includes('Relationship history: We bonded over coffee.'));
    assert.ok(opts?.system?.includes('Current affection level: 88/100'));
    return { text: 'Hey again.', model: 'fake-1', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });

  const res = await handleCompanionChat(
    { persona: { name: 'Luna', age: 23 }, message: 'hi', companionId: 'comp-1' },
    { provider, memoryRepository: repo },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'llm');
});

test('handleCompanionChat persists an updated memory record after a real reply (fire-and-forget)', async () => {
  const repo = new InMemoryCompanionMemoryRepository();
  const provider = new FakeProvider(async () => ({
    text: 'Nice to hear from you.',
    model: 'fake-1',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }));

  const res = await handleCompanionChat(
    { persona: { name: 'Luna', age: 23 }, message: 'I love chatting with you, thank you!', companionId: 'comp-2' },
    { provider, memoryRepository: repo },
  );
  assert.equal(res.status, 200);

  await tick();
  const stored = repo.get('comp-2');
  assert.ok(stored, 'memory should have been persisted');
  assert.equal(stored?.turnCount, 1);
  assert.ok(stored!.affectionLevel > 50);
});

test('handleCompanionChat: absent companionId ⇒ behavior is byte-for-byte unchanged (regression guard)', async () => {
  const repo = new InMemoryCompanionMemoryRepository();
  let capturedSystem: string | undefined;
  const provider = new FakeProvider(async (_prompt, opts) => {
    capturedSystem = opts?.system;
    return { text: 'Hey.', model: 'fake-1', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });

  // Same call WITHOUT memoryRepository at all, to get the "always stateless" baseline prompt.
  let baselineSystem: string | undefined;
  const baselineProvider = new FakeProvider(async (_prompt, opts) => {
    baselineSystem = opts?.system;
    return { text: 'Hey.', model: 'fake-1', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
  await handleCompanionChat({ persona: { name: 'Luna', age: 23 }, message: 'hi' }, { provider: baselineProvider });

  // Now with a memoryRepository injected but NO companionId in the request body.
  const res = await handleCompanionChat(
    { persona: { name: 'Luna', age: 23 }, message: 'hi' },
    { provider, memoryRepository: repo },
  );
  assert.equal(res.status, 200);
  assert.equal(capturedSystem, baselineSystem, 'system prompt must be identical with no companionId');
  assert.ok(!capturedSystem?.includes('Relationship history'));

  await tick();
  assert.equal(repo.all().length, 0, 'no memory row should ever be written without a companionId');
});

test('handleCompanionChat: companionId present but NO memoryRepository injected ⇒ also unchanged', async () => {
  let capturedSystem: string | undefined;
  const provider = new FakeProvider(async (_prompt, opts) => {
    capturedSystem = opts?.system;
    return { text: 'Hey.', model: 'fake-1', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
  const res = await handleCompanionChat(
    { persona: { name: 'Luna', age: 23 }, message: 'hi', companionId: 'comp-3' },
    { provider }, // no memoryRepository
  );
  assert.equal(res.status, 200);
  assert.ok(!capturedSystem?.includes('Relationship history'));
});

test('handleCompanionChat: memory is never touched on the deterministic-fallback path (no/stub provider)', async () => {
  const repo = new InMemoryCompanionMemoryRepository();
  const res = await handleCompanionChat(
    { persona: { name: 'Luna', age: 23 }, message: 'hi', companionId: 'comp-4' },
    { memoryRepository: repo }, // no provider at all
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'fallback');
  await tick();
  assert.equal(repo.all().length, 0, 'fallback replies must never trigger a memory write');
});

test('handleCompanionChat rejects a malformed companionId with 400', async () => {
  const res = await handleCompanionChat({
    persona: { name: 'Luna', age: 23 },
    message: 'hi',
    companionId: 'not a valid id!! ',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_companion_id');
});

test('parseCompanionChatInput leaves companionId undefined when omitted or blank', () => {
  const omitted = parseCompanionChatInput({ persona: { name: 'Luna', age: 23 }, message: 'hi' });
  assert.equal(omitted.companionId, undefined);

  const blank = parseCompanionChatInput({ persona: { name: 'Luna', age: 23 }, message: 'hi', companionId: '   ' });
  assert.equal(blank.companionId, undefined);
});

test('parseCompanionChatInput accepts a well-formed companionId and rejects an over-long one', () => {
  const ok = parseCompanionChatInput({
    persona: { name: 'Luna', age: 23 },
    message: 'hi',
    companionId: 'client-generated_ID-123',
  });
  assert.equal(ok.companionId, 'client-generated_ID-123');

  assert.throws(
    () =>
      parseCompanionChatInput({
        persona: { name: 'Luna', age: 23 },
        message: 'hi',
        companionId: 'x'.repeat(200),
      }),
    (err: unknown) => err instanceof CompanionChatValidationError && err.code === 'invalid_companion_id',
  );
});

// ---------------------------------------------------------------------------
// C. InMemoryCompanionMemoryRepository
// ---------------------------------------------------------------------------

test('InMemoryCompanionMemoryRepository: get/upsert/all/clear behave as expected', () => {
  const repo = new InMemoryCompanionMemoryRepository();
  assert.equal(repo.get('missing'), undefined);

  repo.upsert({ companionId: 'a', affectionLevel: 60, summary: 's1', turnCount: 1, updatedAt: 1 });
  repo.upsert({ companionId: 'a', affectionLevel: 65, summary: 's2', turnCount: 2, updatedAt: 2 });
  assert.equal(repo.all().length, 1, 'upsert replaces, not appends');
  assert.equal(repo.get('a')?.affectionLevel, 65);

  repo.upsert({ companionId: 'b', affectionLevel: 50, summary: '', turnCount: 0, updatedAt: 3 });
  assert.equal(repo.all().length, 2);

  repo.clear();
  assert.equal(repo.all().length, 0);
});

// ---------------------------------------------------------------------------
// D. Gateway integration
// ---------------------------------------------------------------------------

test('GET /v1/companion/memory is public (no key needed), rate-limited, and never 404s', async () => {
  const gw = new HopeGateway({
    security: { apiKey: 'secret-key', rateLimit: 5 },
    provider: false,
    logger: false,
  });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/companion/memory?companionId=brand-new-companion`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { memory: CompanionMemoryRecord };
    assert.equal(json.memory.companionId, 'brand-new-companion');
    assert.equal(json.memory.affectionLevel, 50);
    assert.equal(json.memory.turnCount, 0);

    const missingParam = await fetch(`${base}/v1/companion/memory`);
    assert.equal(missingParam.status, 400);

    // A protected route on the SAME gateway still requires the key.
    const protectedRes = await fetch(`${base}/v1/matrix/stats`);
    assert.equal(protectedRes.status, 401);
  });
});

test('POST /v1/companion/chat with companionId, then GET /v1/companion/memory reflects the update', async () => {
  const provider = new FakeProvider(async () => ({
    text: 'So good to hear from you again.',
    model: 'fake-1',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }));
  const gw = new HopeGateway({ provider, logger: false });
  await withServer(gw, async (base) => {
    const chatRes = await fetch(`${base}/v1/companion/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        persona: { name: 'Luna', age: 23 },
        message: 'I really appreciate you, thank you',
        companionId: 'round-trip-companion',
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatJson = (await chatRes.json()) as { source: string };
    assert.equal(chatJson.source, 'llm');

    await tick(50);

    const memRes = await fetch(`${base}/v1/companion/memory?companionId=round-trip-companion`);
    assert.equal(memRes.status, 200);
    const memJson = (await memRes.json()) as { memory: CompanionMemoryRecord };
    assert.equal(memJson.memory.turnCount, 1);
    assert.ok(memJson.memory.affectionLevel > 50);
    assert.ok(memJson.memory.summary.length > 0);
  });
});

test('a fresh HopeGateway defaults to an in-memory companion memory repository (no DATABASE_URL required)', async () => {
  const provider = new FakeProvider(async () => ({
    text: 'Hi!',
    model: 'fake-1',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }));
  const gw = new HopeGateway({ provider, logger: false });
  const chat = await gw.handleCompanionChat({
    persona: { name: 'Luna', age: 23 },
    message: 'hello',
    companionId: 'default-repo-companion',
  });
  assert.equal(chat.status, 200);
  await tick();
  const mem = gw.handleCompanionMemoryGet('default-repo-companion');
  assert.equal(mem.status, 200);
  assert.equal((mem.body.memory as CompanionMemoryRecord).turnCount, 1);
});
