/**
 * tests/providers.test.ts — the optional LLM provider package (providers/) and HOPE's
 * dependency-injected enricher (hope/enricher.ts).
 *
 * Coverage:
 *   - StubProvider: deterministic, offline, plausible usage.
 *   - OpenAiCompatibleProvider: exercised against a tiny real local HTTP server (node:http)
 *     AND a fetch mock — request shape, auth header, response/usage parsing, error paths.
 *   - factory: env-driven selection, offline-first default, misconfiguration handling.
 *   - IntentEnricher: heuristic-only by default; uses an injected provider; falls back on
 *     failure — and NEVER changes the classification (kind/destination), only the summary.
 *
 * Run: node --import tsx --test tests/providers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';

import {
  StubProvider,
  OpenAiCompatibleProvider,
  OpenAiCompatibleError,
  createProvider,
  createProviderOrStub,
  UnknownProviderError,
  type CompleteOptions,
  type CompletionResult,
  type LlmProvider,
} from '../providers/index.js';
import { IntentEnricher, heuristicSummary } from '../hope/enricher.js';
import { IntentInterpreter } from '../hope/interpreter.js';

// ---------------------------------------------------------------------------
// StubProvider — deterministic, offline
// ---------------------------------------------------------------------------

test('StubProvider is deterministic for the same prompt/options', async () => {
  const p = new StubProvider();
  const a = await p.complete('Simulate launching Project Atlas to 1000 users');
  const b = await p.complete('Simulate launching Project Atlas to 1000 users');
  assert.equal(a.text, b.text);
  assert.equal(a.model, 'stub-1');
  assert.ok(a.text.length > 0);
});

test('StubProvider varies output with different prompts and reports usage', async () => {
  const p = new StubProvider();
  const a = await p.complete('first prompt about apples');
  const b = await p.complete('second prompt about oranges');
  assert.notEqual(a.text, b.text);
  assert.ok(a.usage.totalTokens > 0);
  assert.equal(a.usage.totalTokens, a.usage.promptTokens + a.usage.completionTokens);
});

test('StubProvider honors a per-call model override', async () => {
  const p = new StubProvider({ model: 'stub-base' });
  const r = await p.complete('hello', { model: 'stub-override' });
  assert.equal(r.model, 'stub-override');
});

// ---------------------------------------------------------------------------
// OpenAiCompatibleProvider — against a real tiny local HTTP server
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
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  try {
    await run(baseUrl, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function okChatResponse(res: http.ServerResponse, content: string): void {
  const payload = {
    id: 'chatcmpl-test',
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test('OpenAiCompatibleProvider sends a well-formed request and parses the response', async () => {
  await withServer(
    (_req, res) => okChatResponse(res, '  A concise paraphrase.  '),
    async (baseUrl, captured) => {
      const p = new OpenAiCompatibleProvider({
        baseUrl,
        apiKey: 'test-key',
        model: 'test-model',
      });
      const result = await p.complete('paraphrase this', {
        system: 'be concise',
        maxTokens: 50,
        temperature: 0.1,
      });

      // Response parsing: content is trimmed, model + usage flow through.
      assert.equal(result.text, 'A concise paraphrase.');
      assert.equal(result.model, 'test-model');
      assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });

      // Request shape.
      assert.equal(captured.length, 1);
      const req = captured[0];
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers['authorization'], 'Bearer test-key');
      assert.equal(req.headers['content-type'], 'application/json');
      const body = req.body as {
        model: string;
        temperature: number;
        max_tokens: number;
        messages: Array<{ role: string; content: string }>;
      };
      assert.equal(body.model, 'test-model');
      assert.equal(body.temperature, 0.1);
      assert.equal(body.max_tokens, 50);
      assert.deepEqual(body.messages, [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'paraphrase this' },
      ]);
    },
  );
});

test('OpenAiCompatibleProvider omits the Authorization header when no apiKey (keyless local)', async () => {
  await withServer(
    (_req, res) => okChatResponse(res, 'local model reply'),
    async (baseUrl, captured) => {
      const p = new OpenAiCompatibleProvider({ baseUrl, model: 'llama3' });
      const r = await p.complete('hi');
      assert.equal(r.text, 'local model reply');
      assert.equal(captured[0].headers['authorization'], undefined);
    },
  );
});

test('OpenAiCompatibleProvider throws OpenAiCompatibleError on HTTP error', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
    },
    async (baseUrl) => {
      const p = new OpenAiCompatibleProvider({ baseUrl, model: 'm', apiKey: 'x' });
      await assert.rejects(
        () => p.complete('hi'),
        (err: unknown) => {
          assert.ok(err instanceof OpenAiCompatibleError);
          assert.equal((err as OpenAiCompatibleError).status, 401);
          return true;
        },
      );
    },
  );
});

test('OpenAiCompatibleProvider throws when the response has no completion text', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: '' } }] }));
    },
    async (baseUrl) => {
      const p = new OpenAiCompatibleProvider({ baseUrl, model: 'm' });
      await assert.rejects(() => p.complete('hi'), OpenAiCompatibleError);
    },
  );
});

// ---------------------------------------------------------------------------
// OpenAiCompatibleProvider — with an injected fetch mock (no server)
// ---------------------------------------------------------------------------

test('OpenAiCompatibleProvider works with an injected fetch mock', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return new Response(
      JSON.stringify({
        model: 'mock-model',
        choices: [{ message: { content: 'mocked text' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const p = new OpenAiCompatibleProvider({
    baseUrl: 'https://example.test/v1/',
    apiKey: 'k',
    model: 'mock-model',
    fetchImpl: fetchMock,
  });
  const r = await p.complete('hello');
  assert.equal(r.text, 'mocked text');
  assert.equal(r.model, 'mock-model');
  assert.equal(r.usage.totalTokens, 5);
  // Trailing slash on baseUrl is normalized (no double slash before the path).
  assert.equal(seenUrl, 'https://example.test/v1/chat/completions');
  assert.equal(seenInit?.method, 'POST');
});

// ---------------------------------------------------------------------------
// factory — env-driven, offline-first
// ---------------------------------------------------------------------------

test('factory defaults to StubProvider (offline-first) with an empty env', () => {
  const p = createProvider({ env: {} });
  assert.ok(p instanceof StubProvider);
  assert.equal(p.name, 'stub');
});

test('factory builds an OpenAiCompatibleProvider from env', () => {
  const p = createProvider({
    env: {
      HDV_LLM_PROVIDER: 'openai_compatible',
      HDV_LLM_BASE_URL: 'https://api.openai.com/v1',
      HDV_LLM_API_KEY: 'sk-test',
      HDV_LLM_MODEL: 'gpt-4o-mini',
    },
  });
  assert.ok(p instanceof OpenAiCompatibleProvider);
  assert.equal(p.model, 'gpt-4o-mini');
});

test('factory throws for openai_compatible without a base URL', () => {
  assert.throws(() => createProvider({ env: { HDV_LLM_PROVIDER: 'openai_compatible' } }), /HDV_LLM_BASE_URL/);
});

test('factory throws UnknownProviderError for an unknown provider kind', () => {
  assert.throws(
    () => createProvider({ env: { HDV_LLM_PROVIDER: 'nope' } }),
    (err: unknown) => err instanceof UnknownProviderError,
  );
});

test('createProviderOrStub never throws and falls back to the stub on misconfig', () => {
  const p = createProviderOrStub({ env: { HDV_LLM_PROVIDER: 'openai_compatible' } });
  assert.ok(p instanceof StubProvider);
});

// ---------------------------------------------------------------------------
// IntentEnricher — DI, heuristic default, fallback, never re-classifies
// ---------------------------------------------------------------------------

const interpreter = new IntentInterpreter();

test('heuristicSummary produces a non-empty, capitalized restatement', () => {
  const intent = interpreter.interpret('Simulate how "Project Atlas" launches to reach 1000 users');
  const s = heuristicSummary(intent);
  assert.ok(s.length > 0);
  assert.equal(s[0], s[0].toUpperCase());
});

test('IntentEnricher is heuristic-only when no provider is injected', async () => {
  const enricher = new IntentEnricher();
  assert.equal(enricher.canEnrich, false);
  const intent = interpreter.interpret('run the deployment for "Gamma"');
  const out = await enricher.enrich(intent);
  assert.equal(out.source, 'heuristic');
  assert.equal(out.summary, heuristicSummary(intent));
  assert.equal(out.model, undefined);
});

test('IntentEnricher uses an injected provider to improve the summary', async () => {
  const provider: LlmProvider = {
    name: 'fake',
    model: 'fake-1',
    async complete(_prompt: string, _opts?: CompleteOptions): Promise<CompletionResult> {
      return { text: '"Deploy the Gamma service now."', model: 'fake-1', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
  };
  const enricher = new IntentEnricher({ provider });
  assert.equal(enricher.canEnrich, true);

  const intent = interpreter.interpret('run the deployment for "Gamma"');
  const out = await enricher.enrich(intent);
  assert.equal(out.source, 'llm');
  assert.equal(out.model, 'fake-1');
  // Surrounding quotes are stripped by sanitization.
  assert.equal(out.summary, 'Deploy the Gamma service now.');
});

test('IntentEnricher falls back to heuristics when the provider throws', async () => {
  const provider: LlmProvider = {
    name: 'boom',
    model: 'boom-1',
    async complete(): Promise<CompletionResult> {
      throw new Error('network down');
    },
  };
  const enricher = new IntentEnricher({ provider });
  const intent = interpreter.interpret('simulate three outcomes for launching "Beta"');
  const out = await enricher.enrich(intent);
  assert.equal(out.source, 'heuristic');
  assert.equal(out.summary, heuristicSummary(intent));
  assert.match(out.error ?? '', /network down/);
});

test('IntentEnricher falls back when the provider returns empty text', async () => {
  const provider: LlmProvider = {
    name: 'empty',
    model: 'empty-1',
    async complete(): Promise<CompletionResult> {
      return { text: '   ', model: 'empty-1', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
  };
  const enricher = new IntentEnricher({ provider });
  const intent = interpreter.interpret('document that we deferred "Beta"');
  const out = await enricher.enrich(intent);
  assert.equal(out.source, 'heuristic');
});

test('enrichIntent only changes the summary text, never the classification', async () => {
  const provider: LlmProvider = {
    name: 'fake',
    model: 'fake-1',
    async complete(): Promise<CompletionResult> {
      return { text: 'A crisper summary.', model: 'fake-1', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
  };
  const enricher = new IntentEnricher({ provider });
  const original = interpreter.interpret('Simulate how "Project Atlas" could launch to reach 1000 users');
  const { intent: enriched, summary } = await enricher.enrichIntent(original);

  assert.equal(summary.source, 'llm');
  assert.equal(enriched.intent, 'A crisper summary.');
  // Everything that drives routing/classification is preserved exactly.
  assert.equal(enriched.kind, original.kind);
  assert.equal(enriched.suggestedDestination, original.suggestedDestination);
  assert.equal(enriched.confidence, original.confidence);
  assert.deepEqual(enriched.entities, original.entities);
  assert.deepEqual(enriched.goals, original.goals);
  assert.deepEqual(enriched.constraints, original.constraints);
});
