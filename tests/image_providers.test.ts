/**
 * tests/image_providers.test.ts — the optional image provider package (providers/image_*.ts).
 *
 * Sibling to tests/providers.test.ts (text). Same coverage shape:
 *   - StubImageProvider: deterministic, offline, produces a genuinely valid PNG.
 *   - GoogleAiStudioImageProvider: exercised against a tiny real local HTTP server.
 *   - ColabTunnelImageProvider: same, plus the optional bearer-token header.
 *   - image_factory: env-driven selection, offline-first default, misconfiguration handling.
 *
 * Run: node --import tsx --test tests/image_providers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';

import {
  StubImageProvider,
  GoogleAiStudioImageProvider,
  GoogleAiStudioImageError,
  ColabTunnelImageProvider,
  ColabTunnelImageError,
  createImageProvider,
  createImageProviderOrStub,
  UnknownImageProviderError,
} from '../providers/index.js';

// ---------------------------------------------------------------------------
// StubImageProvider — deterministic, offline, a real (tiny) PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('StubImageProvider is deterministic for the same prompt and produces a valid PNG', async () => {
  const p = new StubImageProvider();
  const a = await p.generate('a playful companion named Luna');
  const b = await p.generate('a playful companion named Luna');
  assert.equal(a.imageBase64, b.imageBase64);
  assert.equal(a.mimeType, 'image/png');
  assert.equal(a.model, 'stub-image-1');

  const bytes = Buffer.from(a.imageBase64, 'base64');
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'output must start with the PNG signature');
});

test('StubImageProvider varies output with different prompts', async () => {
  const p = new StubImageProvider();
  const a = await p.generate('prompt one');
  const b = await p.generate('prompt two');
  assert.notEqual(a.imageBase64, b.imageBase64);
});

// ---------------------------------------------------------------------------
// GoogleAiStudioImageProvider / ColabTunnelImageProvider — real local HTTP server
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

async function withServer(
  handler: (req: CapturedRequest, res: http.ServerResponse) => void,
  run: (baseUrl: string, captured: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const cap: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      captured.push(cap);
      handler(cap, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await run(baseUrl, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('GoogleAiStudioImageProvider sends a well-formed request and parses the response', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.method, 'POST');
      assert.ok(req.url?.startsWith('/models/imagen-3.0-generate-002:predict?key=test-key'));
      assert.deepEqual(req.body, { instances: [{ prompt: 'a portrait' }], parameters: { sampleCount: 1 } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ predictions: [{ bytesBase64Encoded: TINY_PNG_B64, mimeType: 'image/png' }] }));
    },
    async (baseUrl) => {
      const provider = new GoogleAiStudioImageProvider({
        apiKey: 'test-key',
        model: 'imagen-3.0-generate-002',
        baseUrl,
      });
      const result = await provider.generate('a portrait');
      assert.equal(result.imageBase64, TINY_PNG_B64);
      assert.equal(result.mimeType, 'image/png');
      assert.equal(result.model, 'imagen-3.0-generate-002');
    },
  );
});

test('GoogleAiStudioImageProvider throws GoogleAiStudioImageError when safety filters block the image', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ predictions: [] }));
    },
    async (baseUrl) => {
      const provider = new GoogleAiStudioImageProvider({ apiKey: 'k', model: 'imagen-3.0-generate-002', baseUrl });
      await assert.rejects(() => provider.generate('anything'), GoogleAiStudioImageError);
    },
  );
});

test('GoogleAiStudioImageProvider never leaks the API key via JSON.stringify/toJSON', () => {
  const provider = new GoogleAiStudioImageProvider({ apiKey: 'super-secret', model: 'imagen-3.0-generate-002' });
  const json = JSON.stringify(provider);
  assert.ok(!json.includes('super-secret'));
  assert.deepEqual(provider.toJSON(), {
    name: 'google_ai_studio',
    model: 'imagen-3.0-generate-002',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  });
});

test('ColabTunnelImageProvider sends the bearer token and parses the response', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/generate');
      assert.equal(req.headers.authorization, 'Bearer tunnel-secret');
      assert.deepEqual(req.body, { prompt: 'a portrait', width: 512, height: 512 });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ image_base64: TINY_PNG_B64, mime_type: 'image/png', model: 'sdxl-custom' }));
    },
    async (baseUrl) => {
      const provider = new ColabTunnelImageProvider({ baseUrl, apiKey: 'tunnel-secret' });
      const result = await provider.generate('a portrait', { width: 512, height: 512 });
      assert.equal(result.imageBase64, TINY_PNG_B64);
      assert.equal(result.model, 'sdxl-custom');
    },
  );
});

test('ColabTunnelImageProvider omits the Authorization header when no apiKey', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.headers.authorization, undefined);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ image_base64: TINY_PNG_B64 }));
    },
    async (baseUrl) => {
      const provider = new ColabTunnelImageProvider({ baseUrl });
      await provider.generate('a portrait');
    },
  );
});

test('ColabTunnelImageProvider throws ColabTunnelImageError on HTTP error', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('gpu warming up');
    },
    async (baseUrl) => {
      const provider = new ColabTunnelImageProvider({ baseUrl });
      await assert.rejects(() => provider.generate('x'), ColabTunnelImageError);
    },
  );
});

// ---------------------------------------------------------------------------
// image_factory — env-driven, offline-first
// ---------------------------------------------------------------------------

test('image factory defaults to StubImageProvider (offline-first) with an empty env', () => {
  const p = createImageProvider({ env: {} });
  assert.equal(p.name, 'stub');
});

test('image factory builds a GoogleAiStudioImageProvider from env', () => {
  const p = createImageProvider({
    env: { HDV_IMAGE_PROVIDER: 'google_ai_studio', HDV_IMAGE_API_KEY: 'k', HDV_IMAGE_MODEL: 'imagen-3.0-generate-002' },
  });
  assert.equal(p.name, 'google_ai_studio');
});

test('image factory builds a ColabTunnelImageProvider from env', () => {
  const p = createImageProvider({
    env: { HDV_IMAGE_PROVIDER: 'colab_tunnel', HDV_IMAGE_BASE_URL: 'https://x.ngrok-free.app' },
  });
  assert.equal(p.name, 'colab_tunnel');
});

test('image factory throws for google_ai_studio without an API key', () => {
  assert.throws(() => createImageProvider({ env: { HDV_IMAGE_PROVIDER: 'google_ai_studio' } }));
});

test('image factory throws for colab_tunnel without a base URL', () => {
  assert.throws(() => createImageProvider({ env: { HDV_IMAGE_PROVIDER: 'colab_tunnel' } }));
});

test('image factory throws UnknownImageProviderError for an unknown kind', () => {
  assert.throws(
    () => createImageProvider({ env: { HDV_IMAGE_PROVIDER: 'dall-e-please' } }),
    UnknownImageProviderError,
  );
});

test('createImageProviderOrStub never throws and falls back to the stub on misconfig', () => {
  const p = createImageProviderOrStub({ env: { HDV_IMAGE_PROVIDER: 'colab_tunnel' } });
  assert.equal(p.name, 'stub');
});
