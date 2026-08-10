/**
 * tests/companion_speak.test.ts — companion speech (companion/speak_*.ts).
 *
 * Coverage:
 *   A. parseSpeakRequest — validation, the shared MAX_MESSAGE_CHARS length cap.
 *   B. handleSpeakRequest — "unavailable" with no provider (or the stub), success with an
 *      injected provider, graceful "unavailable" on provider failure.
 *   C. Gateway integration (real HTTP) — POST /v1/companion/speak is PUBLIC (auth-exempt) but
 *      still rate-limited, exactly like chat/portrait/scene.
 *
 * Run: node --import tsx --test tests/companion_speak.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { parseSpeakRequest, SpeakValidationError, handleSpeakRequest } from '../companion/index.js';
import { MAX_MESSAGE_CHARS } from '../companion/types.js';
import { HopeGateway } from '../gateway/index.js';
import { StubTtsProvider } from '../providers/index.js';
import type { GenerateTtsOptions, TtsProvider, TtsResult } from '../providers/tts_types.js';

async function withServer(gw: HopeGateway, fn: (base: string) => Promise<void>): Promise<void> {
  const server = await gw.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

class FakeTtsProvider implements TtsProvider {
  readonly name = 'fake';
  readonly model = 'fake-tts-1';
  constructor(private readonly impl: (text: string, opts?: GenerateTtsOptions) => Promise<TtsResult> | TtsResult) {}
  async generate(text: string, opts?: GenerateTtsOptions): Promise<TtsResult> {
    return this.impl(text, opts);
  }
}

// ---------------------------------------------------------------------------
// A. parseSpeakRequest
// ---------------------------------------------------------------------------

test('parseSpeakRequest requires a non-empty "text" string', () => {
  assert.throws(() => parseSpeakRequest(null), SpeakValidationError);
  assert.throws(() => parseSpeakRequest({}), SpeakValidationError);
  assert.throws(() => parseSpeakRequest({ text: '' }), SpeakValidationError);
  assert.throws(() => parseSpeakRequest({ text: '   ' }), SpeakValidationError);
  assert.throws(() => parseSpeakRequest({ text: 42 }), SpeakValidationError);
});

test('parseSpeakRequest enforces the shared MAX_MESSAGE_CHARS cap', () => {
  const ok = 'a'.repeat(MAX_MESSAGE_CHARS);
  assert.doesNotThrow(() => parseSpeakRequest({ text: ok }));

  const tooLong = 'a'.repeat(MAX_MESSAGE_CHARS + 1);
  assert.throws(
    () => parseSpeakRequest({ text: tooLong }),
    (err: unknown) => err instanceof SpeakValidationError && err.message.includes(String(MAX_MESSAGE_CHARS)),
  );
});

test('parseSpeakRequest trims text and keeps an optional voice, defaulting to undefined', () => {
  const withVoice = parseSpeakRequest({ text: '  hi there  ', voice: 'af_bella' });
  assert.equal(withVoice.text, 'hi there');
  assert.equal(withVoice.voice, 'af_bella');

  const withoutVoice = parseSpeakRequest({ text: 'hi there' });
  assert.equal(withoutVoice.voice, undefined);
});

test('parseSpeakRequest ignores a non-string voice', () => {
  const { voice } = parseSpeakRequest({ text: 'hi', voice: 42 });
  assert.equal(voice, undefined);
});

// ---------------------------------------------------------------------------
// B. handleSpeakRequest
// ---------------------------------------------------------------------------

test('handleSpeakRequest returns "unavailable" with no provider', async () => {
  const res = await handleSpeakRequest({ text: 'hello there' });
  assert.equal(res.status, 200);
  assert.equal(res.body.audio, null);
  assert.equal(res.body.source, 'unavailable');
  assert.equal(res.body.model, null);
});

test('handleSpeakRequest treats the StubTtsProvider like no provider', async () => {
  const res = await handleSpeakRequest({ text: 'hello there' }, { provider: new StubTtsProvider() });
  assert.equal(res.status, 200);
  assert.equal(res.body.audio, null);
  assert.equal(res.body.source, 'unavailable');
});

test('handleSpeakRequest rejects invalid input with 400, even with a provider injected', async () => {
  const provider = new FakeTtsProvider(() => {
    throw new Error('should never be called for invalid input');
  });
  const res = await handleSpeakRequest({ text: '' }, { provider });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_speak_request');
});

test('handleSpeakRequest returns a data URI on success and never routes/executes', async () => {
  const provider = new FakeTtsProvider((text) => {
    assert.equal(text, 'hello there');
    return { audioBase64: 'QUJD', mimeType: 'audio/wav', model: 'fake-tts-1' };
  });
  const res = await handleSpeakRequest({ text: 'hello there' }, { provider });
  assert.equal(res.status, 200);
  assert.equal(res.body.audio, 'data:audio/wav;base64,QUJD');
  assert.equal(res.body.source, 'fake');
  assert.equal(res.body.model, 'fake-tts-1');
});

test('handleSpeakRequest forwards the requested voice to the provider', async () => {
  const provider = new FakeTtsProvider((_text, opts) => {
    assert.equal(opts?.voice, 'af_bella');
    return { audioBase64: 'QUJD', mimeType: 'audio/wav', model: 'fake-tts-1' };
  });
  const res = await handleSpeakRequest({ text: 'hi', voice: 'af_bella' }, { provider });
  assert.equal(res.status, 200);
});

test('handleSpeakRequest falls back to "unavailable" (not a crash) when the provider throws', async () => {
  const provider = new FakeTtsProvider(async () => {
    throw new Error('cpu warming up');
  });
  const res = await handleSpeakRequest({ text: 'hello there' }, { provider });
  assert.equal(res.status, 200);
  assert.equal(res.body.audio, null);
  assert.equal(res.body.source, 'unavailable');
  assert.equal(res.body.error, 'cpu warming up');
});

// ---------------------------------------------------------------------------
// C. Gateway integration
// ---------------------------------------------------------------------------

test('POST /v1/companion/speak is public (no key needed) but still rate-limited like chat/portrait', async () => {
  const gw = new HopeGateway({
    security: { apiKey: 'secret-key', rateLimit: 3 },
    provider: false,
    imageProvider: false,
    videoProvider: false,
    ttsProvider: false,
    logger: false,
  });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/companion/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello there' }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { audio: string | null; source: string };
    assert.equal(json.audio, null);
    assert.equal(json.source, 'unavailable'); // ttsProvider: false -> always unavailable

    // A protected route on the SAME gateway still requires the key.
    const protectedRes = await fetch(`${base}/v1/matrix/stats`);
    assert.equal(protectedRes.status, 401);

    // Rate limiting still applies to this public route (rateLimit: 3 above).
    let sawLimit = false;
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${base}/v1/companion/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      if (r.status === 429) sawLimit = true;
    }
    assert.ok(sawLimit, 'expected rate limiting to eventually kick in on the public speak route');
  });
});

test('POST /v1/companion/speak rejects text over the length cap with 400 over real HTTP', async () => {
  const gw = new HopeGateway({
    security: { apiKey: 'secret-key', rateLimit: 100 },
    provider: false,
    imageProvider: false,
    videoProvider: false,
    ttsProvider: false,
    logger: false,
  });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/companion/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'a'.repeat(MAX_MESSAGE_CHARS + 1) }),
    });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { code: string };
    assert.equal(json.code, 'invalid_speak_request');
  });
});
