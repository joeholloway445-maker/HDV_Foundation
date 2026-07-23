# providers/ — optional LLM provider adapters

A thin, dependency-free seam for **optional** large-language-model access. Providers are pure
text transducers: `complete(prompt, opts) -> { text, model, usage }`. They know **nothing**
about agents, `RoutingPacket`s, APEX, KNOLL, or the ledger, and **must never** be used to
execute, route, or create anything in the matrix. They only produce text.

Design principles:

- **Offline-first.** The default is the deterministic `StubProvider` — no network, no API key,
  no vendor SDK. With zero configuration everything keeps working.
- **No hard SDK dependency.** The HTTP provider uses the global `fetch`, not the `openai`
  package, so it adds zero dependencies and runs on Node >= 20.
- **Minimal surface.** One interface (`LlmProvider`), one method (`complete`).

## Files

| File | Purpose |
| --- | --- |
| `types.ts` | `LlmProvider` interface, `CompleteOptions`, `CompletionResult`, `LlmUsage`. |
| `stub.ts` | `StubProvider` — deterministic, offline default. |
| `openai_compatible.ts` | `OpenAiCompatibleProvider` — `fetch`-based OpenAI Chat Completions client. |
| `factory.ts` | `createProvider` / `createProviderOrStub` — build from env. |
| `index.ts` | Public surface. |

## Configuration (env)

| Variable | Values / example | Default |
| --- | --- | --- |
| `HDV_LLM_PROVIDER` | `stub` \| `openai_compatible` | `stub` |
| `HDV_LLM_BASE_URL` | e.g. `https://api.openai.com/v1` | — (required for `openai_compatible`) |
| `HDV_LLM_API_KEY` | provider API key | — (optional for keyless local servers) |
| `HDV_LLM_MODEL` | e.g. `gpt-4o-mini`, `llama-3.1-8b-instant`, `llama3` | `gpt-4o-mini` |

`OpenAiCompatibleProvider` works with any OpenAI-compatible endpoint: OpenAI, Groq, Together,
local **vLLM** (`http://localhost:8000/v1`), local **Ollama** (`http://localhost:11434/v1`).

## Usage

```ts
import { createProviderOrStub } from './providers/index.js';

const provider = createProviderOrStub();            // stub unless env configures otherwise
const { text, model, usage } = await provider.complete('Summarize this in one line.');
```

### HOPE enrichment (dependency-injected, heuristic default)

HOPE's interpreter classifies utterances **heuristically** and offline. If — and only if — a
provider is injected, `hope/enricher.ts` can rewrite the human-readable **intent summary** into
a crisper one-liner **after** classification. It never re-classifies, never routes, never
executes, and **falls back to the heuristic summary** if no provider is set or the provider
fails.

```ts
import { IntentInterpreter, IntentEnricher } from './hope/index.js';
import { createProviderOrStub } from './providers/index.js';

const intent = new IntentInterpreter().interpret('run and deploy the pipeline now');
const enricher = new IntentEnricher({ provider: createProviderOrStub() }); // omit provider => heuristic
const { intent: enriched, summary } = await enricher.enrichIntent(intent);
// enriched.kind / .suggestedDestination are unchanged; only enriched.intent (summary) may change.
```

## Scripts

```bash
npm run demo:providers    # offline stub demo (set HDV_LLM_* to try a real backend)
npm run test:providers    # provider + enricher tests (stub + local HTTP server + fetch mock)
```
