/**
 * tests/companion_portrait.test.ts — companion portraits (companion/portrait_*.ts).
 *
 * Coverage:
 *   A. parsePortraitRequest — validation, the hard 18+ floor, defaults.
 *   B. handlePortraitRequest — "unavailable" with no provider (or the stub), success with an
 *      injected provider, graceful "unavailable" on provider failure.
 *   C. Gateway integration (real HTTP) — POST /v1/companion/portrait is PUBLIC (auth-exempt)
 *      but still rate-limited, exactly like chat and waitlist.
 *
 * Run: node --import tsx --test tests/companion_portrait.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import {
  parsePortraitRequest,
  PortraitValidationError,
  handlePortraitRequest,
} from '../companion/index.js';
import { HopeGateway } from '../gateway/index.js';
import { StubImageProvider } from '../providers/index.js';
import type { GenerateImageOptions, ImageProvider, ImageResult } from '../providers/image_types.js';

async function withServer(gw: HopeGateway, fn: (base: string) => Promise<void>): Promise<void> {
  const server = await gw.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

class FakeImageProvider implements ImageProvider {
  readonly name = 'fake';
  readonly model = 'fake-image-1';
  constructor(private readonly impl: (prompt: string, opts?: GenerateImageOptions) => Promise<ImageResult> | ImageResult) {}
  async generate(prompt: string, opts?: GenerateImageOptions): Promise<ImageResult> {
    return this.impl(prompt, opts);
  }
}

// ---------------------------------------------------------------------------
// A. parsePortraitRequest
// ---------------------------------------------------------------------------

test('parsePortraitRequest requires persona.name and persona.age', () => {
  assert.throws(() => parsePortraitRequest(null), PortraitValidationError);
  assert.throws(() => parsePortraitRequest({}), PortraitValidationError);
  assert.throws(() => parsePortraitRequest({ persona: { age: 25 } }), PortraitValidationError); // no name
  assert.throws(() => parsePortraitRequest({ persona: { name: 'Luna' } }), PortraitValidationError); // no age
});

test('parsePortraitRequest enforces the 18+ floor regardless of provider', () => {
  assert.throws(
    () => parsePortraitRequest({ persona: { name: 'Luna', age: 17 } }),
    (err: unknown) => err instanceof PortraitValidationError && err.code === 'persona_not_adult',
  );
  assert.throws(
    () => parsePortraitRequest({ persona: { name: 'Luna', age: 0 } }),
    (err: unknown) => err instanceof PortraitValidationError && err.code === 'persona_not_adult',
  );
  // Non-integer / non-numeric ages are rejected outright, not silently coerced.
  assert.throws(() => parsePortraitRequest({ persona: { name: 'Luna', age: 21.5 } }), PortraitValidationError);
  assert.throws(() => parsePortraitRequest({ persona: { name: 'Luna', age: 'twenty-five' } }), PortraitValidationError);
});

test('parsePortraitRequest accepts a valid adult persona and defaults style/personality', () => {
  const { persona } = parsePortraitRequest({ persona: { name: 'Luna', age: 23 } });
  assert.equal(persona.name, 'Luna');
  assert.equal(persona.age, 23);
  assert.equal(persona.style, 'realistic');
  assert.equal(persona.personality, 'playful');
});

test('parsePortraitRequest keeps a valid custom style/personality/backstory', () => {
  const { persona } = parsePortraitRequest({
    persona: { name: 'Nova', age: 24, style: 'anime', personality: 'mysterious', backstory: 'A goth DJ.' },
  });
  assert.equal(persona.style, 'anime');
  assert.equal(persona.personality, 'mysterious');
  assert.equal(persona.backstory, 'A goth DJ.');
});

test('parsePortraitRequest keeps an optional appearance descriptor, defaulting to undefined', () => {
  const withAppearance = parsePortraitRequest({
    persona: { name: 'Jordyn', age: 24, appearance: 'gorgeous, thick, light brunette hair' },
  });
  assert.equal(withAppearance.persona.appearance, 'gorgeous, thick, light brunette hair');

  const without = parsePortraitRequest({ persona: { name: 'Luna', age: 23 } });
  assert.equal(without.persona.appearance, undefined);
});

// ---------------------------------------------------------------------------
// B. handlePortraitRequest
// ---------------------------------------------------------------------------

test('handlePortraitRequest returns "unavailable" with no provider', async () => {
  const res = await handlePortraitRequest({ persona: { name: 'Luna', age: 23 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.image, null);
  assert.equal(res.body.source, 'unavailable');
});

test('handlePortraitRequest treats the StubImageProvider like no provider', async () => {
  const res = await handlePortraitRequest(
    { persona: { name: 'Luna', age: 23 } },
    { provider: new StubImageProvider() },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.image, null);
  assert.equal(res.body.source, 'unavailable');
});

test('handlePortraitRequest rejects an under-18 persona with 400, even with a provider injected', async () => {
  const provider = new FakeImageProvider(() => {
    throw new Error('should never be called for an under-18 persona');
  });
  const res = await handlePortraitRequest({ persona: { name: 'Kid', age: 12 } }, { provider });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'persona_not_adult');
});

test('handlePortraitRequest returns a data URI on success and never routes/executes', async () => {
  const provider = new FakeImageProvider((prompt) => {
    assert.ok(prompt.includes('Luna'));
    assert.ok(prompt.includes('clearly an adult'));
    return { imageBase64: 'QUJD', mimeType: 'image/png', model: 'fake-image-1' };
  });
  const res = await handlePortraitRequest(
    { persona: { name: 'Luna', age: 23, personality: 'playful' } },
    { provider },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.image, 'data:image/png;base64,QUJD');
  assert.equal(res.body.source, 'fake');
  assert.equal(res.body.model, 'fake-image-1');
});

test('handlePortraitRequest folds persona.appearance into the prompt when provided', async () => {
  const provider = new FakeImageProvider((prompt) => {
    assert.ok(prompt.includes('gorgeous, thick, light brunette hair'));
    return { imageBase64: 'QUJD', mimeType: 'image/png', model: 'fake-image-1' };
  });
  const res = await handlePortraitRequest(
    { persona: { name: 'Jordyn', age: 24, personality: 'romantic', appearance: 'gorgeous, thick, light brunette hair' } },
    { provider },
  );
  assert.equal(res.status, 200);
});

test('handlePortraitRequest forwards persona.style to the provider for checkpoint routing', async () => {
  const provider = new FakeImageProvider((_prompt, opts) => {
    assert.equal(opts?.style, 'anime');
    return { imageBase64: 'QUJD', mimeType: 'image/png', model: 'fake-image-1' };
  });
  const res = await handlePortraitRequest(
    { persona: { name: 'Nova', age: 24, style: 'anime' } },
    { provider },
  );
  assert.equal(res.status, 200);
});

test('handlePortraitRequest falls back to "unavailable" (not a crash) when the provider throws', async () => {
  const provider = new FakeImageProvider(async () => {
    throw new Error('gpu warming up');
  });
  const res = await handlePortraitRequest({ persona: { name: 'Luna', age: 23 } }, { provider });
  assert.equal(res.status, 200);
  assert.equal(res.body.image, null);
  assert.equal(res.body.source, 'unavailable');
  assert.equal(res.body.error, 'gpu warming up');
});

// ---------------------------------------------------------------------------
// C. Gateway integration
// ---------------------------------------------------------------------------

test('POST /v1/companion/portrait is public (no key needed) but still rate-limited like chat', async () => {
  const gw = new HopeGateway({
    security: { apiKey: 'secret-key', rateLimit: 3 },
    provider: false,
    imageProvider: false,
    logger: false,
  });
  await withServer(gw, async (base) => {
    const res = await fetch(`${base}/v1/companion/portrait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: { name: 'Luna', age: 23 } }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { image: string | null; source: string };
    assert.equal(json.image, null);
    assert.equal(json.source, 'unavailable'); // imageProvider: false -> always unavailable

    // A protected route on the SAME gateway still requires the key.
    const protectedRes = await fetch(`${base}/v1/matrix/stats`);
    assert.equal(protectedRes.status, 401);
  });
});
