/**
 * tests/companion_chat.test.ts — companion chat (companion/).
 *
 * Coverage:
 *   A. parseCompanionChatInput — validation, defaults, history trimming.
 *   B. handleCompanionChat — deterministic fallback (no provider), LLM path (stub provider),
 *      provider-failure fallback.
 *   C. Gateway integration (real HTTP) — POST /v1/companion/chat is PUBLIC (auth-exempt) but
 *      still rate-limited, exactly like POST /v1/waitlist.
 *
 * Run: npm run test:companion   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import {
  parseCompanionChatInput,
  CompanionChatValidationError,
  handleCompanionChat,
} from '../companion/index.js';
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
  constructor(private readonly impl: (prompt: string, opts?: CompleteOptions) => Promise<CompletionResult> | CompletionResult) {}
  async complete(prompt: string, opts?: CompleteOptions): Promise<CompletionResult> {
    return this.impl(prompt, opts);
  }
}

// ---------------------------------------------------------------------------
// A. parseCompanionChatInput
// ---------------------------------------------------------------------------

test('parseCompanionChatInput requires persona.name and message', () => {
  assert.throws(() => parseCompanionChatInput(null), CompanionChatValidationError);
  assert.throws(() => parseCompanionChatInput({}), CompanionChatValidationError);
  assert.throws(
    () => parseCompanionChatInput({ persona: { name: 'Luna' }, message: '   ' }),
    CompanionChatValidationError,
  );
  assert.throws(
    () => parseCompanionChatInput({ persona: {}, message: 'hi' }),
    CompanionChatValidationError,
  );
});

test('parseCompanionChatInput enforces the 18+ floor regardless of provider', () => {
  assert.throws(
    () => parseCompanionChatInput({ persona: { name: 'Luna', age: 17 }, message: 'hi' }),
    (err: unknown) => err instanceof CompanionChatValidationError && err.code === 'persona_not_adult',
  );
  assert.throws(
    () => parseCompanionChatInput({ persona: { name: 'Luna', age: 0 }, message: 'hi' }),
    (err: unknown) => err instanceof CompanionChatValidationError && err.code === 'persona_not_adult',
  );
  assert.throws(
    () => parseCompanionChatInput({ persona: { name: 'Luna' }, message: 'hi' }), // no age at all
    CompanionChatValidationError,
  );
});

test('parseCompanionChatInput defaults personality and drops malformed history turns', () => {
  const { persona, history, message } = parseCompanionChatInput({
    persona: { name: 'Luna', age: 23, personality: 'not-a-real-one' },
    history: [
      { role: 'user', text: 'hey' },
      { role: 'bot', text: 'hi there' },
      { role: 'nonsense', text: 'dropped' },
      { text: 'also dropped (no role)' },
      42,
    ],
    message: '  hello  ',
  });
  assert.equal(persona.name, 'Luna');
  assert.equal(persona.personality, 'playful'); // unknown personality -> safe default
  assert.equal(history.length, 2);
  assert.equal(message, 'hello');
});

test('parseCompanionChatInput defaults intensity/adherence to 3 and clamps out-of-range values', () => {
  const defaulted = parseCompanionChatInput({ persona: { name: 'Luna', age: 23 }, message: 'hi' });
  assert.equal(defaulted.persona.intensity, 3);
  assert.equal(defaulted.persona.adherence, 3);

  const clamped = parseCompanionChatInput({
    persona: { name: 'Luna', age: 23, intensity: 99, adherence: -5 },
    message: 'hi',
  });
  assert.equal(clamped.persona.intensity, 5);
  assert.equal(clamped.persona.adherence, 1);

  const rounded = parseCompanionChatInput({
    persona: { name: 'Luna', age: 23, intensity: 4.4, adherence: '2' },
    message: 'hi',
  });
  assert.equal(rounded.persona.intensity, 4);
  assert.equal(rounded.persona.adherence, 2);
});

// ---------------------------------------------------------------------------
// B. handleCompanionChat
// ---------------------------------------------------------------------------

test('handleCompanionChat returns a deterministic fallback reply with no provider', async () => {
  const res = await handleCompanionChat({
    persona: { name: 'Luna', age: 23, personality: 'romantic' },
    message: 'hi',
  });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.reply, 'string');
  assert.ok((res.body.reply as string).length > 0);
  assert.equal(res.body.source, 'fallback');
});

test('handleCompanionChat treats the StubProvider like no provider (curated fallback, not raw echo)', async () => {
  const { StubProvider } = await import('../providers/stub.js');
  const res = await handleCompanionChat(
    { persona: { name: 'Luna', age: 23, personality: 'mysterious' }, message: 'hi' },
    { provider: new StubProvider() },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'fallback');
  assert.equal(res.body.model, null);
});

test('handleCompanionChat rejects malformed input with 400', async () => {
  const res = await handleCompanionChat({ persona: { name: 'Luna' } });
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
});

test('handleCompanionChat uses the provider when one is injected', async () => {
  const provider = new FakeProvider(async (prompt, opts) => {
    assert.ok(prompt.includes('User: hi'));
    assert.ok(opts?.system?.includes('Luna'));
    return { text: '  "Hey you." ', model: 'fake-1', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
  const res = await handleCompanionChat(
    { persona: { name: 'Luna', age: 23, personality: 'playful' }, message: 'hi' },
    { provider },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.reply, 'Hey you.'); // sanitized: quotes stripped, whitespace trimmed
  assert.equal(res.body.source, 'llm');
  assert.equal(res.body.model, 'fake-1');
});

test('handleCompanionChat threads intensity/adherence into the system prompt and temperature', async () => {
  const provider = new FakeProvider(async (_prompt, opts) => {
    assert.ok(opts?.system?.includes('Content intensity (5/5)'));
    assert.ok(opts?.system?.includes('Character adherence (1/5)'));
    assert.equal(opts?.temperature, 1.1); // adherence 1 -> loosest/highest temperature
    return { text: 'ok', model: 'fake-1', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
  const res = await handleCompanionChat(
    { persona: { name: 'Luna', age: 23, intensity: 5, adherence: 1 }, message: 'hi' },
    { provider },
  );
  assert.equal(res.status, 200);
});

test('handleCompanionChat defaults to moderate intensity/adherence when omitted', async () => {
  const provider = new FakeProvider(async (_prompt, opts) => {
    assert.ok(opts?.system?.includes('Content intensity (3/5)'));
    assert.ok(opts?.system?.includes('Character adherence (3/5)'));
    assert.equal(opts?.temperature, 0.8);
    return { text: 'ok', model: 'fake-1', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
  const res = await handleCompanionChat({ persona: { name: 'Luna', age: 23 }, message: 'hi' }, { provider });
  assert.equal(res.status, 200);
});

test('handleCompanionChat falls back to a canned reply when the provider throws', async () => {
  const provider = new FakeProvider(async () => {
    throw new Error('upstream down');
  });
  const res = await handleCompanionChat(
    { persona: { name: 'Luna', age: 23, personality: 'soft' }, message: 'hi' },
    { provider },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'fallback');
  assert.equal(res.body.error, 'upstream down');
});

// ---------------------------------------------------------------------------
// C. Gateway integration
// ---------------------------------------------------------------------------

test('POST /v1/companion/chat is public (no key needed) but still rate-limited like /v1/waitlist', async () => {
  const gw = new HopeGateway({
    security: { apiKey: 'secret-key', rateLimit: 3 },
    provider: false,
    logger: false,
  });
  await withServer(gw, async (base) => {
    // No X-HDV-Key header at all -> still succeeds (auth-exempt).
    const res = await fetch(`${base}/v1/companion/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: { name: 'Luna', age: 23, personality: 'bratty' }, message: 'hi' }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { reply: string; source: string };
    assert.equal(typeof json.reply, 'string');
    assert.equal(json.source, 'fallback'); // provider: false -> stub-free, always fallback

    // A protected route on the SAME gateway still requires the key, proving auth isn't globally off.
    const protectedRes = await fetch(`${base}/v1/matrix/stats`);
    assert.equal(protectedRes.status, 401);
  });
});
