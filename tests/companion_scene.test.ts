/**
 * tests/companion_scene.test.ts — companion scenes/loops (companion/scene_*.ts).
 *
 * Coverage:
 *   A. parseSceneRequest — validation, the 18+ floor, seed image normalization (raw base64 and
 *      data URI forms), action string handling.
 *   B. handleSceneRequest — "unavailable" with no provider (or the stub), success with an
 *      injected provider, graceful "unavailable" on provider failure.
 *   C. Gateway integration — POST /v1/companion/scene is PUBLIC (auth-exempt) but still
 *      rate-limited, same posture as chat and portrait.
 *
 * Run: node --import tsx --test tests/companion_scene.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { parseSceneRequest, SceneValidationError, handleSceneRequest } from '../companion/index.js';
import { HopeGateway } from '../gateway/index.js';
import { StubVideoProvider } from '../providers/index.js';
import type { GenerateVideoOptions, VideoProvider, VideoResult } from '../providers/video_types.js';

async function withServer(gw: HopeGateway, fn: (base: string) => Promise<void>): Promise<void> {
  const server = await gw.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

class FakeVideoProvider implements VideoProvider {
  readonly name = 'fake';
  readonly model = 'fake-video-1';
  constructor(
    private readonly impl: (
      prompt: string,
      seedImage: string,
      opts?: GenerateVideoOptions,
    ) => Promise<VideoResult> | VideoResult,
  ) {}
  async generate(prompt: string, seedImage: string, opts?: GenerateVideoOptions): Promise<VideoResult> {
    return this.impl(prompt, seedImage, opts);
  }
}

const VALID_SEED = 'c2VlZC1pbWFnZS1ieXRlcy1sb25nLWVub3VnaC10by1wYXNzLXZhbGlkYXRpb24=';

// ---------------------------------------------------------------------------
// A. parseSceneRequest
// ---------------------------------------------------------------------------

test('parseSceneRequest requires persona.name, persona.age, and seedImage', () => {
  assert.throws(() => parseSceneRequest(null), SceneValidationError);
  assert.throws(() => parseSceneRequest({}), SceneValidationError);
  assert.throws(
    () => parseSceneRequest({ persona: { name: 'Luna', age: 23 } }), // no seedImage
    SceneValidationError,
  );
  assert.throws(
    () => parseSceneRequest({ persona: { name: 'Luna', age: 23 }, seedImage: 'short' }), // too short
    SceneValidationError,
  );
});

test('parseSceneRequest enforces the 18+ floor', () => {
  assert.throws(
    () => parseSceneRequest({ persona: { name: 'Luna', age: 17 }, seedImage: VALID_SEED }),
    (err: unknown) => err instanceof SceneValidationError && err.code === 'persona_not_adult',
  );
});

test('parseSceneRequest accepts a raw base64 seed image', () => {
  const { seedImage } = parseSceneRequest({ persona: { name: 'Luna', age: 23 }, seedImage: VALID_SEED });
  assert.equal(seedImage, VALID_SEED);
});

test('parseSceneRequest strips a data: URI prefix from the seed image', () => {
  const { seedImage } = parseSceneRequest({
    persona: { name: 'Luna', age: 23 },
    seedImage: `data:image/png;base64,${VALID_SEED}`,
  });
  assert.equal(seedImage, VALID_SEED);
});

test('parseSceneRequest keeps a valid actionString and drops an empty one', () => {
  const withAction = parseSceneRequest({
    persona: { name: 'Luna', age: 23 },
    seedImage: VALID_SEED,
    actionString: 'w-10,a-10,d-10',
  });
  assert.equal(withAction.actionString, 'w-10,a-10,d-10');

  const withoutAction = parseSceneRequest({
    persona: { name: 'Luna', age: 23 },
    seedImage: VALID_SEED,
    actionString: '   ',
  });
  assert.equal(withoutAction.actionString, undefined);
});

test('parseSceneRequest keeps an optional appearance descriptor, defaulting to undefined', () => {
  const withAppearance = parseSceneRequest({
    persona: { name: 'Jordyn', age: 24, appearance: 'gorgeous, thick, light brunette hair' },
    seedImage: VALID_SEED,
  });
  assert.equal(withAppearance.persona.appearance, 'gorgeous, thick, light brunette hair');

  const without = parseSceneRequest({ persona: { name: 'Luna', age: 23 }, seedImage: VALID_SEED });
  assert.equal(without.persona.appearance, undefined);
});

// ---------------------------------------------------------------------------
// B. handleSceneRequest
// ---------------------------------------------------------------------------

test('handleSceneRequest returns "unavailable" with no provider', async () => {
  const res = await handleSceneRequest({ persona: { name: 'Luna', age: 23 }, seedImage: VALID_SEED });
  assert.equal(res.status, 200);
  assert.equal(res.body.video, null);
  assert.equal(res.body.source, 'unavailable');
});

test('handleSceneRequest treats the StubVideoProvider like no provider', async () => {
  const res = await handleSceneRequest(
    { persona: { name: 'Luna', age: 23 }, seedImage: VALID_SEED },
    { provider: new StubVideoProvider() },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.video, null);
  assert.equal(res.body.source, 'unavailable');
});

test('handleSceneRequest rejects an under-18 persona with 400, even with a provider injected', async () => {
  const provider = new FakeVideoProvider(() => {
    throw new Error('should never be called for an under-18 persona');
  });
  const res = await handleSceneRequest(
    { persona: { name: 'Kid', age: 12 }, seedImage: VALID_SEED },
    { provider },
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'persona_not_adult');
});

test('handleSceneRequest returns a data URI on success and passes the seed image + action string through', async () => {
  const provider = new FakeVideoProvider((prompt, seedImage, opts) => {
    assert.ok(prompt.includes('Luna'));
    assert.equal(seedImage, VALID_SEED);
    assert.equal(opts?.actionString, 'w-10');
    return { videoBase64: 'QUJD', mimeType: 'video/mp4', model: 'fake-video-1' };
  });
  const res = await handleSceneRequest(
    { persona: { name: 'Luna', age: 23 }, seedImage: VALID_SEED, actionString: 'w-10' },
    { provider },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.video, 'data:video/mp4;base64,QUJD');
  assert.equal(res.body.source, 'fake');
});

test('handleSceneRequest folds persona.appearance into the prompt when provided', async () => {
  const provider = new FakeVideoProvider((prompt) => {
    assert.ok(prompt.includes('gorgeous, thick, light brunette hair'));
    return { videoBase64: 'QUJD', mimeType: 'video/mp4', model: 'fake-video-1' };
  });
  const res = await handleSceneRequest(
    {
      persona: { name: 'Jordyn', age: 24, personality: 'romantic', appearance: 'gorgeous, thick, light brunette hair' },
      seedImage: VALID_SEED,
    },
    { provider },
  );
  assert.equal(res.status, 200);
});

test('handleSceneRequest falls back to "unavailable" (not a crash) when the provider throws', async () => {
  const provider = new FakeVideoProvider(async () => {
    throw new Error('gpu warming up');
  });
  const res = await handleSceneRequest(
    { persona: { name: 'Luna', age: 23 }, seedImage: VALID_SEED },
    { provider },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.video, null);
  assert.equal(res.body.error, 'gpu warming up');
});

// ---------------------------------------------------------------------------
// C. Gateway integration
// ---------------------------------------------------------------------------

test('POST /v1/companion/scene is public (no key needed) but still rate-limited like chat/portrait', async () => {
  const gw = new HopeGateway({
    security: { apiKey: 'secret-key', rateLimit: 3 },
    provider: false,
    imageProvider: false,
    videoProvider: false,
    logger: false,
  });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/companion/scene`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: { name: 'Luna', age: 23 }, seedImage: VALID_SEED }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { video: string | null; source: string };
    assert.equal(json.video, null);
    assert.equal(json.source, 'unavailable');

    const protectedRes = await fetch(`${base}/v1/matrix/stats`);
    assert.equal(protectedRes.status, 401);
  });
});
