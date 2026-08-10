/**
 * tests/companion_chat_stream.test.ts — token-by-token SSE companion chat.
 *
 * Coverage:
 *   A. OpenAiCompatibleProvider.completeStream — against a real local HTTP server that emits
 *      genuine SSE frames over time; deltas must arrive incrementally and concatenate to the
 *      full text.
 *   B. POST /v1/companion/chat/stream over real HTTP — connect, read the response as a stream
 *      (never `.json()`), and assert MULTIPLE separate reads arrive over time (not one buffered
 *      blob) whose concatenated deltas form the expected reply, terminated by a `done` event.
 *   C. No-provider / stub-provider fallback — still a valid SSE stream, single delta, same
 *      deterministic reply POST /v1/companion/chat would have returned.
 *   D. Auth-exempt but rate-limited, same posture as POST /v1/companion/chat.
 *   E. The 18+ floor (persona_not_adult) is enforced as a normal buffered 400 BEFORE any SSE
 *      framing is written.
 *   F. Purely additive: the existing buffered POST /v1/companion/chat is unaffected.
 *
 * Run: node --import tsx --test tests/companion_chat_stream.test.ts   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { OpenAiCompatibleProvider } from '../providers/openai_compatible.js';
import { StubProvider } from '../providers/stub.js';
import type { CompleteOptions, CompletionResult, LlmProvider } from '../providers/types.js';
import { handleCompanionChat } from '../companion/index.js';
import { HopeGateway } from '../gateway/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withServer(gw: HopeGateway, fn: (base: string) => Promise<void>): Promise<void> {
  const server = await gw.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Read a fetch Response body to completion, recording each non-empty chunk's arrival time. */
async function collectSse(
  response: Response,
): Promise<{ events: Array<Record<string, unknown>>; readCount: number; spanMs: number }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder('utf-8');
  let raw = '';
  let readCount = 0;
  let firstAt = 0;
  let lastAt = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (value && value.length > 0) {
      readCount += 1;
      const now = Date.now();
      if (!firstAt) firstAt = now;
      lastAt = now;
      raw += decoder.decode(value, { stream: true });
    }
    if (done) break;
  }
  const events = raw
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data:'))
    .map((block) => JSON.parse(block.slice(5).trim()) as Record<string, unknown>);
  return { events, readCount, spanMs: lastAt - firstAt };
}

// ---------------------------------------------------------------------------
// A. OpenAiCompatibleProvider.completeStream — real local HTTP server, real SSE, real delays
// ---------------------------------------------------------------------------

/** Serve a hand-written OpenAI-compatible SSE stream, writing one frame every `delayMs`. */
function serveSse(res: http.ServerResponse, frames: string[], delayMs: number): void {
  // "connection: close" so the client (undici's fetch) doesn't keep the socket alive for reuse
  // after the response ends — keeps `server.close()` in test teardown fast and deterministic.
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'close' });
  let i = 0;
  const pump = (): void => {
    if (i >= frames.length) {
      res.end();
      return;
    }
    res.write(`data: ${frames[i]}\n\n`);
    i += 1;
    setTimeout(pump, delayMs);
  };
  pump();
}

test('OpenAiCompatibleProvider.completeStream yields deltas incrementally as real SSE frames arrive', async () => {
  const chunks = ['Hey', ' there', ', how', ' are you?'];
  const server = http.createServer((req, res) => {
    const bodyChunks: Buffer[] = [];
    req.on('data', (c) => bodyChunks.push(c as Buffer));
    req.on('end', () => {
      const frames = [
        ...chunks.map((c) => JSON.stringify({ choices: [{ delta: { content: c } }] })),
        '[DONE]',
      ];
      serveSse(res, frames, 15);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
    });

    assert.equal(typeof provider.completeStream, 'function');

    const received: string[] = [];
    const arrivalTimes: number[] = [];
    for await (const chunk of provider.completeStream!('hi', {})) {
      received.push(chunk.delta);
      arrivalTimes.push(Date.now());
    }

    assert.deepEqual(received, chunks);
    assert.equal(received.join(''), 'Hey there, how are you?');
    // Real incremental delivery: the last delta arrives measurably later than the first —
    // proves this wasn't buffered into one blob and parsed all at once.
    assert.ok(arrivalTimes.length >= 2);
    assert.ok(
      arrivalTimes[arrivalTimes.length - 1] - arrivalTimes[0] >= 30,
      `expected deltas spread out over time, got span ${arrivalTimes[arrivalTimes.length - 1] - arrivalTimes[0]}ms`,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('OpenAiCompatibleProvider.completeStream tolerates a [DONE]-only (empty) stream', async () => {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => serveSse(res, ['[DONE]'], 5));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const provider = new OpenAiCompatibleProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' });
    const received: string[] = [];
    for await (const chunk of provider.completeStream!('hi', {})) received.push(chunk.delta);
    assert.deepEqual(received, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// Fake streaming provider for gateway-level tests (no real network).
// ---------------------------------------------------------------------------

class FakeStreamingProvider implements LlmProvider {
  readonly name = 'fake-stream';
  readonly model = 'fake-stream-1';
  constructor(
    private readonly chunks: string[],
    private readonly delayMs = 15,
  ) {}

  async complete(_prompt: string, _opts?: CompleteOptions): Promise<CompletionResult> {
    return {
      text: this.chunks.join(''),
      model: this.model,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }

  async *completeStream(_prompt: string, _opts?: CompleteOptions): AsyncIterable<{ delta: string }> {
    for (const c of this.chunks) {
      await sleep(this.delayMs);
      yield { delta: c };
    }
  }
}

// ---------------------------------------------------------------------------
// B. Gateway route over real HTTP — genuinely incremental delivery
// ---------------------------------------------------------------------------

test('POST /v1/companion/chat/stream delivers multiple SSE chunks over time, then a done event', async () => {
  const provider = new FakeStreamingProvider(['Hey ', 'you.', ' Nice', ' to meet you.']);
  const gw = new HopeGateway({ provider, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/companion/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        persona: { name: 'Luna', age: 23, personality: 'romantic' },
        message: 'hi',
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const { events, readCount, spanMs } = await collectSse(res);

    // Not one buffered blob: the transport delivered more than one chunk, spread over time.
    assert.ok(readCount > 1, `expected multiple stream reads, got ${readCount}`);
    assert.ok(spanMs >= 30, `expected reads spread out over time, got ${spanMs}ms`);

    const deltaEvents = events.filter((e) => typeof e.delta === 'string');
    assert.equal(deltaEvents.length, 4);
    const full = deltaEvents.map((e) => e.delta as string).join('');
    assert.equal(full, 'Hey you. Nice to meet you.');

    const doneEvent = events[events.length - 1];
    assert.equal(doneEvent.done, true);
    assert.equal(doneEvent.model, 'fake-stream-1');
    assert.equal(doneEvent.source, 'llm');
  });
});

// ---------------------------------------------------------------------------
// C. No-provider / stub fallback — still a valid SSE stream, single chunk, deterministic
// ---------------------------------------------------------------------------

test('POST /v1/companion/chat/stream falls back to the SAME deterministic reply as /v1/companion/chat when there is no provider', async () => {
  const gw = new HopeGateway({ provider: false, logger: false });
  const body = { persona: { name: 'Luna', age: 23, personality: 'bratty' }, message: 'hi there' };

  const buffered = await handleCompanionChat(body); // no provider injected -> fallback
  assert.equal(buffered.status, 200);
  assert.equal(buffered.body.source, 'fallback');

  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/companion/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const { events } = await collectSse(res);

    const deltaEvents = events.filter((e) => typeof e.delta === 'string');
    assert.equal(deltaEvents.length, 1); // single-chunk fallback, per spec
    assert.equal(deltaEvents[0].delta, buffered.body.reply); // SAME pool, not a divergent copy

    const doneEvent = events[events.length - 1];
    assert.equal(doneEvent.done, true);
    assert.equal(doneEvent.source, 'fallback');
    assert.equal(doneEvent.model, null);
  });
});

test('POST /v1/companion/chat/stream treats the StubProvider like no provider (still one fallback chunk)', async () => {
  const gw = new HopeGateway({ provider: new StubProvider(), logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/companion/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: { name: 'Luna', age: 23, personality: 'mysterious' }, message: 'hi' }),
    });
    assert.equal(res.status, 200);
    const { events } = await collectSse(res);
    const deltaEvents = events.filter((e) => typeof e.delta === 'string');
    assert.equal(deltaEvents.length, 1);
    const doneEvent = events[events.length - 1];
    assert.equal(doneEvent.source, 'fallback');
    assert.equal(doneEvent.model, null);
  });
});

// ---------------------------------------------------------------------------
// D. Auth-exempt but rate-limited, same posture as POST /v1/companion/chat
// ---------------------------------------------------------------------------

test('POST /v1/companion/chat/stream is public (no key needed) but still rate-limited', async () => {
  const provider = new FakeStreamingProvider(['ok'], 1);
  const gw = new HopeGateway({
    security: { apiKey: 'secret-key', rateLimit: 2 },
    provider,
    logger: false,
  });
  await withServer(gw, async (base) => {
    const doRequest = () =>
      fetch(`${base}/v1/companion/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' }, // deliberately NO X-HDV-Key
        body: JSON.stringify({ persona: { name: 'Luna', age: 23 }, message: 'hi' }),
      });

    const first = await doRequest();
    assert.equal(first.status, 200); // auth-exempt: no key needed
    await collectSse(first); // drain fully before the next request

    const second = await doRequest();
    assert.equal(second.status, 200);
    await collectSse(second);

    // Third request within the same window exceeds rateLimit: 2 -> 429, plain JSON, no SSE.
    const third = await doRequest();
    assert.equal(third.status, 429);
    assert.match(third.headers.get('content-type') ?? '', /application\/json/);
    const json = (await third.json()) as { error: string };
    assert.match(json.error, /rate limit/i);

    // A protected route on the SAME gateway still requires the key, proving auth isn't globally
    // off — checked from a distinct simulated client IP so it isn't itself rate-limited by the
    // quota the three requests above already spent.
    const protectedRes = await fetch(`${base}/v1/matrix/stats`, {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    assert.equal(protectedRes.status, 401);
  });
});

// ---------------------------------------------------------------------------
// E. The 18+ floor is enforced BEFORE any streaming starts
// ---------------------------------------------------------------------------

test('POST /v1/companion/chat/stream rejects an under-18 persona with a buffered 400, no SSE framing', async () => {
  const provider = new FakeStreamingProvider(['should never be sent']);
  const gw = new HopeGateway({ provider, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/companion/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: { name: 'Luna', age: 17 }, message: 'hi' }),
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.doesNotMatch(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const json = (await res.json()) as { error: string; code: string };
    assert.equal(json.code, 'persona_not_adult');
  });
});

test('POST /v1/companion/chat/stream rejects a missing/malformed body with a buffered 400', async () => {
  const gw = new HopeGateway({ provider: false, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/companion/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: { name: 'Luna' } }), // no age, no message
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const json = (await res.json()) as { error: string };
    assert.equal(typeof json.error, 'string');
  });
});

// ---------------------------------------------------------------------------
// F. Purely additive — the existing buffered route is untouched
// ---------------------------------------------------------------------------

test('POST /v1/companion/chat (buffered) still works exactly as before, unaffected by the new stream route', async () => {
  const provider = new FakeStreamingProvider(['irrelevant to the buffered route']);
  const gw = new HopeGateway({ provider, logger: false });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/companion/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: { name: 'Luna', age: 23, personality: 'soft' }, message: 'hi' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const json = (await res.json()) as { reply: string; source: string };
    // The FakeStreamingProvider only implements completeStream for the /stream route; the
    // buffered route calls complete() as always, proving the two routes are independent.
    assert.equal(json.reply, 'irrelevant to the buffered route');
    assert.equal(json.source, 'llm');
  });
});
