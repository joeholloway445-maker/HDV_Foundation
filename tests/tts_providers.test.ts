/**
 * tests/tts_providers.test.ts — the optional TTS provider package (providers/tts_*.ts).
 *
 * Sibling to tests/image_providers.test.ts / tests/video_providers.test.ts. Same coverage shape:
 *   - StubTtsProvider: deterministic, offline, produces a genuinely valid (silent) WAV file.
 *   - KokoroTunnelTtsProvider: exercised against a tiny real local HTTP server, plus the
 *     optional bearer-token header and never leaking the API key in thrown errors.
 *   - tts_factory: env-driven selection, offline-first default, misconfiguration handling.
 *
 * Run: node --import tsx --test tests/tts_providers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';

import {
  StubTtsProvider,
  KokoroTunnelTtsProvider,
  KokoroTunnelTtsError,
  createTtsProvider,
  createTtsProviderOrStub,
  UnknownTtsProviderError,
} from '../providers/index.js';

// ---------------------------------------------------------------------------
// StubTtsProvider — deterministic, offline, a real (tiny, silent) WAV
// ---------------------------------------------------------------------------

test('StubTtsProvider is deterministic and produces a valid WAV', async () => {
  const p = new StubTtsProvider();
  const a = await p.generate('hello there');
  const b = await p.generate('hello there');
  assert.equal(a.audioBase64, b.audioBase64);
  assert.equal(a.mimeType, 'audio/wav');
  assert.equal(a.model, 'stub-tts-1');

  const bytes = Buffer.from(a.audioBase64, 'base64');
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(bytes.subarray(36, 40).toString('ascii'), 'data');
  // PCM audio format marker (offset 20, uint16 LE) must be 1.
  assert.equal(bytes.readUInt16LE(20), 1);
  // chunk size (offset 4) must match the actual remaining byte count.
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  // data size (offset 40) must match the actual PCM payload length.
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
});

test('StubTtsProvider produces identical (silent) audio regardless of input text', async () => {
  const p = new StubTtsProvider();
  const a = await p.generate('prompt one');
  const b = await p.generate('a totally different, much longer line of dialogue');
  assert.equal(a.audioBase64, b.audioBase64);
});

test('StubTtsProvider honors custom sampleRate/durationSeconds/model options', async () => {
  const p = new StubTtsProvider({ model: 'custom-stub', sampleRate: 8000, durationSeconds: 0.25 });
  const result = await p.generate('x');
  assert.equal(result.model, 'custom-stub');
  const bytes = Buffer.from(result.audioBase64, 'base64');
  assert.equal(bytes.readUInt32LE(24), 8000); // sample rate field
  // 8000 Hz * 0.25s * 2 bytes/sample = 4000 bytes of PCM data.
  assert.equal(bytes.readUInt32LE(40), 4000);
});

// ---------------------------------------------------------------------------
// KokoroTunnelTtsProvider — real local HTTP server
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

const FAKE_WAV_BYTES = Buffer.from('RIFF....WAVEfmt fake-audio-bytes-for-testing', 'ascii');

test('KokoroTunnelTtsProvider sends a well-formed request and parses the raw-bytes response', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/audio/speech');
      assert.deepEqual(req.body, { input: 'hello world', voice: 'af_bella', speed: 1.2 });
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(FAKE_WAV_BYTES);
    },
    async (baseUrl) => {
      const provider = new KokoroTunnelTtsProvider({ baseUrl });
      const result = await provider.generate('hello world', { voice: 'af_bella', speed: 1.2 });
      assert.equal(Buffer.from(result.audioBase64, 'base64').equals(FAKE_WAV_BYTES), true);
      assert.equal(result.mimeType, 'audio/wav');
      assert.equal(result.model, 'kokoro-82m');
    },
  );
});

test('KokoroTunnelTtsProvider sends the bearer token when an apiKey is configured', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer tts-secret');
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(FAKE_WAV_BYTES);
    },
    async (baseUrl) => {
      const provider = new KokoroTunnelTtsProvider({ baseUrl, apiKey: 'tts-secret' });
      await provider.generate('x');
    },
  );
});

test('KokoroTunnelTtsProvider omits the Authorization header when no apiKey', async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.headers.authorization, undefined);
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(FAKE_WAV_BYTES);
    },
    async (baseUrl) => {
      const provider = new KokoroTunnelTtsProvider({ baseUrl });
      await provider.generate('x');
    },
  );
});

test('KokoroTunnelTtsProvider recognizes audio/mpeg responses', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(FAKE_WAV_BYTES);
    },
    async (baseUrl) => {
      const provider = new KokoroTunnelTtsProvider({ baseUrl });
      const result = await provider.generate('x');
      assert.equal(result.mimeType, 'audio/mpeg');
    },
  );
});

test('KokoroTunnelTtsProvider falls back to a default voice when configured and none is passed per-call', async () => {
  await withServer(
    (req, res) => {
      assert.deepEqual(req.body, { input: 'x', voice: 'am_adam' });
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(FAKE_WAV_BYTES);
    },
    async (baseUrl) => {
      const provider = new KokoroTunnelTtsProvider({ baseUrl, voice: 'am_adam' });
      await provider.generate('x');
    },
  );
});

test('KokoroTunnelTtsProvider throws KokoroTunnelTtsError on HTTP error', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('cpu warming up');
    },
    async (baseUrl) => {
      const provider = new KokoroTunnelTtsProvider({ baseUrl });
      await assert.rejects(() => provider.generate('x'), KokoroTunnelTtsError);
    },
  );
});

test('KokoroTunnelTtsProvider throws KokoroTunnelTtsError on an empty response body', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end();
    },
    async (baseUrl) => {
      const provider = new KokoroTunnelTtsProvider({ baseUrl });
      await assert.rejects(() => provider.generate('x'), KokoroTunnelTtsError);
    },
  );
});

test('KokoroTunnelTtsProvider never leaks the API key in a thrown error message', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('server said: key=super-secret-tts-key rejected');
    },
    async (baseUrl) => {
      const provider = new KokoroTunnelTtsProvider({ baseUrl, apiKey: 'super-secret-tts-key' });
      await assert.rejects(
        () => provider.generate('x'),
        (err: unknown) => {
          assert.ok(err instanceof KokoroTunnelTtsError);
          const serialized = `${err.message} ${err.body ?? ''}`;
          assert.ok(!serialized.includes('super-secret-tts-key'));
          return true;
        },
      );
    },
  );
});

test('KokoroTunnelTtsProvider never leaks the API key via JSON.stringify/toJSON', () => {
  const provider = new KokoroTunnelTtsProvider({ baseUrl: 'http://127.0.0.1:9', apiKey: 'super-secret-tts-key' });
  const json = JSON.stringify(provider);
  assert.ok(!json.includes('super-secret-tts-key'));
  assert.deepEqual(provider.toJSON(), {
    name: 'kokoro_tunnel',
    model: 'kokoro-82m',
    url: 'http://127.0.0.1:9/v1/audio/speech',
  });
});

test('KokoroTunnelTtsProvider requires a baseUrl', () => {
  assert.throws(() => new KokoroTunnelTtsProvider({ baseUrl: '' }));
});

// ---------------------------------------------------------------------------
// tts_factory — env-driven, offline-first
// ---------------------------------------------------------------------------

test('tts factory defaults to StubTtsProvider (offline-first) with an empty env', () => {
  const p = createTtsProvider({ env: {} });
  assert.equal(p.name, 'stub');
});

test('tts factory builds a KokoroTunnelTtsProvider from env', () => {
  const p = createTtsProvider({
    env: { HDV_TTS_PROVIDER: 'kokoro_tunnel', HDV_TTS_BASE_URL: 'http://kokoro-tts:8880' },
  });
  assert.equal(p.name, 'kokoro_tunnel');
});

test('tts factory throws for kokoro_tunnel without a base URL', () => {
  assert.throws(() => createTtsProvider({ env: { HDV_TTS_PROVIDER: 'kokoro_tunnel' } }));
});

test('tts factory throws UnknownTtsProviderError for an unknown kind', () => {
  assert.throws(
    () => createTtsProvider({ env: { HDV_TTS_PROVIDER: 'elevenlabs-please' } }),
    UnknownTtsProviderError,
  );
});

test('createTtsProviderOrStub never throws and falls back to the stub on misconfig', () => {
  const p = createTtsProviderOrStub({ env: { HDV_TTS_PROVIDER: 'kokoro_tunnel' } });
  assert.equal(p.name, 'stub');
});
