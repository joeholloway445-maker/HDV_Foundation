# Companion Speech Server — self-hosted Kokoro-82M (production VPS sidecar)

> Unlike `07_portrait_server.py` / `08_scene_server.py` (throwaway Colab-notebook cells that
> load a GPU model and expose it behind a tunnel for a single session), this is a **reference
> deployment doc**, not a notebook. Kokoro-82M is small enough (Apache-2.0, ~82M params,
> **CPU-inference-capable**) to run as an always-on Docker sidecar directly on the production
> VPS, right next to the existing Ollama LLM container — see [`deploy/OLLAMA.md`](../deploy/OLLAMA.md)
> for that same co-location pattern applied to text. There is no `10_*.py` notebook script
> because there's nothing to notebook: you `docker run` (or compose-up) a pre-built image and
> point `providers/kokoro_tunnel_tts.ts` at it.
>
> **Scope reminder (constitution §6 / providers seam):** a provider is a pure *text-to-speech
> transducer* — `generate(text) -> { audioBase64 }`. Kokoro here only turns already-approved
> companion chat text into audio for `POST /v1/companion/speak`. It **never** routes, executes,
> creates, or bypasses APEX/KNOLL, and it carries no persona/age logic of its own — the 18+
> floor is enforced upstream, at the text's origin (`companion/types.ts`), same as every other
> companion surface.

---

## 1. What's actually running

[`remsky/Kokoro-FastAPI`](https://github.com/remsky/Kokoro-FastAPI) (aka "FastKoko") is the
verified, actively-maintained, Dockerized FastAPI wrapper around Kokoro-82M. It exposes an
**OpenAI-compatible** speech endpoint, so the wire contract here mirrors OpenAI's real
`/v1/audio/speech` API rather than the ad-hoc JSON envelope the image/video colab_tunnel
providers use.

**Verified against the project's README (fetched at doc-authoring time — reconfirm before going
live, since images/ports can move on):**

```bash
# CPU-only (recommended default — this is the whole point of choosing Kokoro):
docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest

# NVIDIA GPU (CUDA 12.6), if you have one to spare — not required:
docker run --gpus all -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-gpu:latest
```

The service listens on **port 8880** and exposes:

| Route | Purpose |
| --- | --- |
| `POST /v1/audio/speech` | **The one this provider uses.** OpenAI-compatible speech synthesis. |
| `GET /v1/audio/voices` | Lists available named voices (e.g. `af_bella`, `am_adam`, …). |
| `POST /v1/audio/voices/combine` | Weighted voice blends (not used by this provider). |
| `/web` | A built-in browser UI — handy for a manual smoke test, not used by HDV. |

Authentication is **not required by default** — same "keyless local server" posture as Ollama.
If you front it with a reverse proxy or want a shared secret anyway, `KokoroTunnelTtsProvider`
sends one as a bearer token when `HDV_TTS_API_KEY` is set (the server can be configured to check
it via its own reverse-proxy layer; Kokoro-FastAPI itself has no built-in key check to enforce).

---

## 2. The `/v1/audio/speech` contract

Request body (fields `providers/kokoro_tunnel_tts.ts` sends):

```json
{ "input": "Hey, I missed you today.", "voice": "af_bella", "speed": 1.0 }
```

- `input` (required) — the text to synthesize. HDV caps this at `MAX_MESSAGE_CHARS` (4000
  chars, `companion/types.ts`) before it ever reaches the provider — see
  `companion/speak_types.ts`.
- `voice` (optional) — a named voice id. Kokoro ships several (see `GET /v1/audio/voices` on a
  running server for the current list); `HDV_TTS_VOICE` sets a gateway-wide default, or a client
  can pass one per call via `{ voice }` in `POST /v1/companion/speak`.
- `speed` (optional) — playback-speed multiplier, default `1.0`.

Response: **raw audio bytes**, not a JSON envelope — the format is carried in the
`Content-Type` response header (Kokoro-FastAPI supports `mp3, wav, opus, flac, aac, pcm` via an
optional `response_format` request field, which this provider does not set, so the server's
configured default applies). `KokoroTunnelTtsProvider` reads whatever comes back, base64-encodes
it, and normalizes `Content-Type` down to one of the two formats this seam documents supporting
— `audio/wav` or `audio/mpeg` (anything else falls back to being reported as `audio/wav`, since
raw bytes are stored either way and the caller ultimately trusts the `mimeType` field on the
result, not a guess). If you need a guaranteed format, put `Kokoro-FastAPI` behind a reverse
proxy that pins `response_format`, or extend the provider to send it explicitly.

---

## 3. Wiring it into HDV (provider seam)

Edit `big5-matrix/.env`:

```bash
HDV_TTS_PROVIDER=kokoro_tunnel
HDV_TTS_BASE_URL=http://127.0.0.1:8880      # loopback — same box, bare-metal path
HDV_TTS_API_KEY=                             # empty: Kokoro-FastAPI is keyless by default
HDV_TTS_VOICE=af_bella                       # optional gateway-wide default voice
```

Restart the gateway to pick up the change:

```bash
sudo systemctl restart hdv-gateway            # bare-metal path
# or (Docker path, see §4 below):
#   docker compose -f deploy/docker-compose.prod.yml up -d gateway
```

Verify the provider builds and can reach the server (no vendor SDK, just `fetch`):

```bash
cd big5-matrix
npm run test:tts-providers    # stub + local HTTP server tests, no network needed
curl -s -X POST http://127.0.0.1:8880/v1/audio/speech \
  -H 'content-type: application/json' \
  -d '{"input":"Say hi in one line.","voice":"af_bella"}' \
  -o /tmp/test.wav && file /tmp/test.wav
```

---

## 4. Docker path (compose profile)

`deploy/docker-compose.prod.yml` ships `kokoro-tts` as an **optional** service, mirroring how
`ollama` is gated behind `--profile local-llm`:

```bash
docker compose -f deploy/docker-compose.prod.yml --profile tts up -d
```

Then in `.env` (note the **service name**, not localhost, inside the Docker network — same
pattern as `HDV_LLM_BASE_URL=http://ollama:11434/v1` in `deploy/OLLAMA.md`):

```bash
HDV_TTS_PROVIDER=kokoro_tunnel
HDV_TTS_BASE_URL=http://kokoro-tts:8880
HDV_TTS_API_KEY=
```

Restart the gateway container:

```bash
docker compose -f deploy/docker-compose.prod.yml up -d gateway
```

**Loopback-only network exposure**, same security posture as the existing Ollama service: the
compose file publishes `kokoro-tts` on `127.0.0.1:8880` (reachable from the host for manual
curl-testing) but it is **never publicly exposed** — the gateway itself reaches it over the
internal Docker network via the `kokoro-tts` service DNS name, not the published host port. Do
**not** `ufw allow 8880`.

---

## 5. Sizing on Hostinger KVM4

Kokoro-82M is dramatically smaller than the SDXL portrait models (~3.5B params) or
LingBot-World (~18.5B params) that need a Colab GPU tunnel — 82M params runs comfortably on
CPU, which is the entire reason it's deployed as a same-box sidecar instead of another Colab
tunnel. Expect sub-second-to-low-single-digit-second synthesis for a short line of companion
dialogue on KVM4's ~4 vCPU, no GPU required. If you also run Ollama (`deploy/OLLAMA.md`) and the
portrait/scene Colab tunnels, `kokoro-tts` is the lightest of the bunch — it does not change the
KVM4-vs-larger-plan sizing call already made for Ollama.

---

## 6. Security notes

- **Never expose `8880`.** Docker: use the `expose:`-only posture already in
  `deploy/docker-compose.prod.yml` for internal-network reachability, or keep the published
  mapping loopback-bound (`127.0.0.1:8880:8880`) as shipped. No `ufw allow 8880`.
- **No key required** for local inference by default — nothing to leak. If you add a reverse
  proxy with a shared secret, `HDV_TTS_API_KEY` is sent as a bearer token
  (`providers/kokoro_tunnel_tts.ts`) and is scrubbed from any thrown error message via
  `providers/redact.ts`, same as every other provider in this seam.
- Local inference does **not** change the trust boundary: audio still flows back as
  base64-encoded bytes through the provider seam, and `companion/speak_handlers.ts` never
  routes, executes, or touches KNOLL/APEX — it's a pure transducer, exactly like portrait/scene.
- Before going live, reconfirm the exact image tag / port / request-body field names against
  [`remsky/Kokoro-FastAPI`'s current README](https://github.com/remsky/Kokoro-FastAPI) — the
  values above were verified at doc-authoring time but this is a fast-moving OSS project.
