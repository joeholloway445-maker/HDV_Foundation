/**
 * tests/video_providers.test.ts — the optional video provider package (providers/video_*.ts).
 *
 * Sibling to tests/image_providers.test.ts. Coverage:
 *   - StubVideoProvider: deterministic, offline (honestly not a real video — see the source
 *     doc comment — but exercises the seam end-to-end).
 *   - ColabTunnelVideoProvider: exercised against a tiny real local HTTP server.
 *   - video_factory: env-driven selection, offline-first default, misconfiguration handling.
 *
 * Run: node --import tsx --test tests/video_providers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';

import {
  StubVideoProvider,
  ColabTunnelVideoProvider,
  ColabTunnelVideoError,
  createVideoProvider,
  createVideoProviderOrStub,
  UnknownVideoProviderError,
} from '../providers/index.js';

// ---------------------------------------------------------------------------
// StubVideoProvider — deterministic, offline
// ---------------------------------------------------------------------------

test('StubVideoProvider is deterministic for the same prompt+seed image', async () => {
  const p = new StubVideoProvider();
  const a = await p.generate('a playful companion', 'c2VlZC1pbWFnZQ==');
  const b = await p.generate('a playful companion', 'c2VlZC1pbWFnZQ==');
  assert.equal(a.videoBase64, b.videoBase64);
  assert.equal(a.model, 'stub-video-1');
});

test('StubVideoProvider varies with different inputs', async () => {
  const p = new StubVideoProvider();
  const a = await p.generate('prompt one', 'aW1hZ2Ux');
  const b = await p.generate('prompt two', 'aW1hZ2Uy');
  assert.notEqual(a.videoBase64, b.videoBase64);
});

// ---------------------------------------------------------------------------
// ColabTunnelVideoProvider — real local HTTP server
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

test('ColabTunnelVideoProvider sends the seed image + action string and parses the response', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/generate');
      assert.equal(req.headers.authorization, 'Bearer tunnel-secret');
      assert.deepEqual(req.body, {
        prompt: 'a scene',
        seed_image_base64: 'c2VlZA==',
        action_string: 'w-10,a-10',
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ video_base64: 'dmlkZW8=', mime_type: 'video/mp4', model: 'lingbot-world-fast' }));
    },
    async (baseUrl) => {
      const provider = new ColabTunnelVideoProvider({ baseUrl, apiKey: 'tunnel-secret' });
      const result = await provider.generate('a scene', 'c2VlZA==', { actionString: 'w-10,a-10' });
      assert.equal(result.videoBase64, 'dmlkZW8=');
      assert.equal(result.model, 'lingbot-world-fast');
    },
  );
});

test('ColabTunnelVideoProvider omits action_string when not provided', async () => {
  await withServer(
    (req, res) => {
      assert.deepEqual(req.body, { prompt: 'p', seed_image_base64: 's' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ video_base64: 'dg==' }));
    },
    async (baseUrl) => {
      const provider = new ColabTunnelVideoProvider({ baseUrl });
      await provider.generate('p', 's');
    },
  );
});

test('ColabTunnelVideoProvider throws ColabTunnelVideoError on HTTP error', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('gpu warming up');
    },
    async (baseUrl) => {
      const provider = new ColabTunnelVideoProvider({ baseUrl });
      await assert.rejects(() => provider.generate('x', 'seed'), ColabTunnelVideoError);
    },
  );
});

// ---------------------------------------------------------------------------
// video_factory — env-driven, offline-first
// ---------------------------------------------------------------------------

test('video factory defaults to StubVideoProvider (offline-first) with an empty env', () => {
  const p = createVideoProvider({ env: {} });
  assert.equal(p.name, 'stub');
});

test('video factory builds a ColabTunnelVideoProvider from env', () => {
  const p = createVideoProvider({
    env: { HDV_VIDEO_PROVIDER: 'colab_tunnel', HDV_VIDEO_BASE_URL: 'https://x.ngrok-free.app' },
  });
  assert.equal(p.name, 'colab_tunnel');
});

test('video factory throws for colab_tunnel without a base URL', () => {
  assert.throws(() => createVideoProvider({ env: { HDV_VIDEO_PROVIDER: 'colab_tunnel' } }));
});

test('video factory throws UnknownVideoProviderError for an unknown kind', () => {
  assert.throws(
    () => createVideoProvider({ env: { HDV_VIDEO_PROVIDER: 'sora-please' } }),
    UnknownVideoProviderError,
  );
});

test('createVideoProviderOrStub never throws and falls back to the stub on misconfig', () => {
  const p = createVideoProviderOrStub({ env: { HDV_VIDEO_PROVIDER: 'colab_tunnel' } });
  assert.equal(p.name, 'stub');
});
