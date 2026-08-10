# providers/ — optional LLM provider adapters

A thin, dependency-free seam for **optional** large-language-model access. Providers are pure
text transducers: `complete(prompt, opts) -> { text, model, usage }`. They know **nothing**
about agents, `RoutingPacket`s, APEX, KNOLL, or the ledger, and **must never** be used to
execute, route, or create anything in the matrix. They only produce text.

## Streaming (`completeStream`, optional)

`LlmProvider` has one *optional* second method alongside `complete`:

```ts
completeStream?(prompt: string, opts?: CompleteOptions): AsyncIterable<{ delta: string }>;
```

It's the token-by-token twin of `complete`: instead of resolving once with the full text, it
yields `{ delta }` chunks as the backend produces them — concatenating every `delta` in order
reconstructs the same text `complete()` would have returned. It is **optional** because not
every provider can support it (the offline `StubProvider` doesn't); callers MUST feature-detect
it (`typeof provider.completeStream === 'function'`) rather than assume it exists, and fall back
to `complete()` (or a canned reply) when it's absent. Same rules as `complete`: pure text
in/out, no tool use, no routing, no side effects.

`OpenAiCompatibleProvider` implements it by adding `stream: true` to the same request body
`complete()` sends, then incrementally parsing the resulting `text/event-stream` response —
`data: {"choices":[{"delta":{"content":"..."}}]}` frames, terminated by a literal
`data: [DONE]` frame — exactly what Ollama and every OpenAI-compatible chat completions endpoint
emits for a streaming request. It uses `fetch`'s `response.body` (a web `ReadableStream`), same
as `complete()` uses `fetch` for the buffered call — no extra dependency. `companion/handlers.ts`'s
`handleCompanionChatStream` (mounted at `POST /v1/companion/chat/stream`) is the one consumer
today; see that file and `gateway/server.ts`'s `serveCompanionChatStream` for the SSE wiring.

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
| `openai_compatible.ts` | `OpenAiCompatibleProvider` — `fetch`-based OpenAI Chat Completions client (`complete`, plus streaming via `completeStream`). |
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

## Image providers (companion portraits)

Sibling seam, same rules, different medium: `image_types.ts`'s `ImageProvider` is a pure
prompt-to-image transducer (`generate(prompt, opts) -> { imageBase64, mimeType, model }`),
used by `companion/portrait_handlers.ts` (`POST /v1/companion/portrait`). Same offline-first
default (`StubImageProvider` — a real, tiny, deterministic PNG, never shown to end users; the
product layer treats it the same as "no provider").

| File | Purpose |
| --- | --- |
| `image_types.ts` | `ImageProvider` interface, `GenerateImageOptions`, `ImageResult`. |
| `image_stub.ts` | `StubImageProvider` — deterministic, offline default (dependency-free PNG encoder). |
| `google_ai_studio_image.ts` | `GoogleAiStudioImageProvider` — Imagen via the Generative Language API. SFW only (Google's safety filters apply). |
| `colab_tunnel_image.ts` | `ColabTunnelImageProvider` — talks to a self-hosted model behind a tunnel; see `colab/07_portrait_server.py`. |
| `image_factory.ts` | `createImageProvider` / `createImageProviderOrStub` — build from env. |

| Variable | Values / example | Default |
| --- | --- | --- |
| `HDV_IMAGE_PROVIDER` | `stub` \| `google_ai_studio` \| `colab_tunnel` | `stub` |
| `HDV_IMAGE_API_KEY` | Google AI Studio key, or the Colab server's shared-secret token | — |
| `HDV_IMAGE_BASE_URL` | e.g. `https://xxxx.ngrok-free.app` (required for `colab_tunnel`) | — |
| `HDV_IMAGE_MODEL` | e.g. `imagen-3.0-generate-002` (required for `google_ai_studio`) | — |

`GenerateImageOptions.style` carries `PortraitPersona.style` (FuckLike/web's own "Realistic" /
"Anime" create-form option) through to the provider. `ColabTunnelImageProvider` forwards it as
`style` in the request body; `colab/07_portrait_server.py`'s `MODEL_ROUTES` uses it to route
each request to a different checkpoint (e.g. a photoreal model for "realistic", a stylized
model for "anime") without the gateway ever knowing more than one model exists.

```bash
npm run test:image-providers   # stub + local HTTP server tests (Google AI Studio + Colab tunnel shapes)
npm run test:portrait          # companion/portrait_handlers.ts + gateway integration
```

## Video providers (companion scenes/loops)

One more sibling seam, one step further: `video_types.ts`'s `VideoProvider` takes a prompt
**and a seed image** (image-to-video — used by `companion/scene_handlers.ts`,
`POST /v1/companion/scene`) and returns `{ videoBase64, mimeType, model }`. The seed image is
typically the output of `/v1/companion/portrait`. Same offline-first default
(`StubVideoProvider` — honestly not a real playable video, see its doc comment; the product
layer treats it the same as "no provider").

| File | Purpose |
| --- | --- |
| `video_types.ts` | `VideoProvider` interface, `GenerateVideoOptions`, `VideoResult`. |
| `video_stub.ts` | `StubVideoProvider` — deterministic, offline default. |
| `colab_tunnel_video.ts` | `ColabTunnelVideoProvider` — talks to a self-hosted world/video model (e.g. LingBot-World) behind a tunnel; see `colab/08_scene_server.py`. |
| `video_factory.ts` | `createVideoProvider` / `createVideoProviderOrStub` — build from env. |

| Variable | Values / example | Default |
| --- | --- | --- |
| `HDV_VIDEO_PROVIDER` | `stub` \| `colab_tunnel` | `stub` |
| `HDV_VIDEO_API_KEY` | The Colab scene server's shared-secret token | — |
| `HDV_VIDEO_BASE_URL` | e.g. `https://xxxx.ngrok-free.app` (required for `colab_tunnel`) | — |
| `HDV_VIDEO_MODEL` | Reported model id override | — |

There is currently no `google_ai_studio`-equivalent hosted option for video — general-purpose
video models exist commercially, but the whole point of this seam for FuckLike is an
NSFW-capable path, which points at self-hosting via `colab_tunnel` regardless.

```bash
npm run test:video-providers   # stub + local HTTP server tests
npm run test:scene             # companion/scene_handlers.ts + gateway integration
```
