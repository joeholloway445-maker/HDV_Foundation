# Companion Chat Server — small, per-persona LoRA experts on a shared base model (GPU)

> Text twin of `07_portrait_server.py` / `08_scene_server.py`: a GPU-backed model server
> exposed behind a tunnel for companion chat, instead of an always-CPU-bound single shared
> model. Like `10_kokoro_tts_server.md`, this is a **reference deployment doc**, not a
> notebook script — the serving engine ([vLLM](https://github.com/vllm-project/vllm)) already
> speaks the OpenAI-compatible API `providers/openai_compatible.ts` uses, so there's no custom
> FastAPI wrapper to write or maintain here.
>
> **Scope reminder (constitution §6 / providers seam):** a provider is a pure *text
> transducer* — `complete(prompt) -> { text }`. This server only enriches companion chat text
> (`POST /v1/companion/chat`). It **never** routes, executes, creates, or bypasses APEX/KNOLL —
> swapping which model answers changes *reply quality/voice*, nothing about governance.

---

## 1. What this actually is

One shared base chat model (a single set of weights in VRAM) with many small **LoRA
adapters** — one per companion persona, a few tens of MB each — loaded alongside it. vLLM's
`--enable-lora` mode serves all of them from ONE process/GPU and lets a caller pick which
adapter answers a given request by putting its registered name in the ordinary OpenAI `model`
field. This is dramatically cheaper than running N separate full models: N small LoRAs share
one base model's memory footprint instead of needing N x that footprint.

`companion/persona_model_catalog.ts` is the HDV-side half of this: it maps a companion's
`companionId` to the LoRA adapter name to request, and is **empty by default** — a persona
with no trained adapter yet just uses the base model (unspecialized, same as today), exactly
like a persona with no trained *portrait* LoRA falls back to the plain per-style checkpoint.

## 2. Install + run vLLM with multi-LoRA serving

Needs an actual GPU (CPU vLLM exists but multi-LoRA serving at usable speed does not run well
without one) — a Colab Pro / Kaggle Notebooks GPU session, a rented GPU, or your own hardware.

```bash
pip install -q vllm

# BASE_MODEL: pick any small-to-mid instruct model your GPU's VRAM comfortably fits in the
# quantization you choose — vLLM supports AWQ/GPTQ/bitsandbytes 4-bit out of the box. A
# Colab/Kaggle T4 (16 GB) comfortably fits a ~7-8B model at 4-bit; scale up with a bigger GPU.
python -m vllm.entrypoints.openai.api_server \
  --model $BASE_MODEL \
  --enable-lora \
  --lora-modules jordyn=/path/to/jordyn-lora isabella=/path/to/isabella-lora \
  --max-lora-rank 32 \
  --port 8000
```

`--lora-modules <name>=<path>` can be repeated for every trained persona adapter — add more as
they're trained, same "grow the catalog over time" posture as `PERSONA_LORA_ROUTES`. Adapter
**names must exactly match the persona/companion id** (e.g. `jordyn`) — `resolvePersonaModel`
sends that name straight through as the `model` field with no translation, so
`companion/persona_model_catalog.ts`'s entry and this flag's adapter name must agree.

Training a persona's LoRA is a separate step, not yet scripted in this repo the way
`11_train_character_lora.py` scripts the image side — standard tools
([`peft`](https://github.com/huggingface/peft), [`trl`](https://github.com/huggingface/trl), or
[axolotl](https://github.com/OpenAccess-AI-Collective/axolotl)) fine-tune a small LoRA from a
persona's chat transcripts/voice examples against `$BASE_MODEL`.

## 3. Exposing it to the internet

Same tunnel pattern as `07_portrait_server.py` §"EXPOSING IT TO THE INTERNET" — ngrok,
Cloudflare Tunnel, or (if running on your own VPS with a GPU) direct loopback + reverse proxy.
vLLM's OpenAI server needs no wrapping to tunnel; just point ngrok/cloudflared at port `8000`.

## 4. Wiring it into HDV

```bash
HDV_LLM_PROVIDER=openai_compatible
HDV_LLM_BASE_URL=https://xxxx.ngrok-free.app/v1
HDV_LLM_MODEL=$BASE_MODEL          # the default when a companion has no catalogued LoRA
# HDV_LLM_API_KEY=                 # vLLM is keyless by default; set only if you add auth in front
```

This is the SAME `HDV_LLM_PROVIDER=openai_compatible` path Ollama already uses
(`deploy/OLLAMA.md`) — vLLM just happens to also support per-request LoRA selection over that
identical protocol, so nothing about the client wiring changes.

Restart the gateway to pick up the change, then verify:

```bash
npm run test:companion    # existing suite, unaffected — model routing defaults to undefined
                           # (base model) until a persona actually has a catalog entry
```

## 5. Scaling under load ("kick on another expert")

This server has no built-in autoscaling — running more replicas is a deployment decision, not
something `persona_model_catalog.ts` decides. If one persona (or the base model generally)
becomes a bottleneck: run another vLLM instance (another Colab/Kaggle GPU session, or a rented
one) registering the SAME adapter names, and put both behind a simple round-robin/DNS load
balancer, or set `HDV_LLM_BASE_URL` per-tenant via the tenancy layer (`config/models.json`,
`tenancy/`) to split traffic across instances. The horizontal-worker/task-queue plumbing this
repo already has (`colab/05_horizontal_worker.py`, `HDV_QUEUE=kafka`) is built for exactly this
kind of "more workers when the queue backs up" scaling, applied to APEX task dispatch generally
— reuse the same instinct here rather than building a second scaling mechanism.

## 6. Security notes

- vLLM's OpenAI server is **keyless by default**, same posture as Ollama/Kokoro — put it behind
  a reverse proxy with a shared secret if you want one; `providers/openai_compatible.ts` already
  sends `HDV_LLM_API_KEY` as a bearer token when set, and scrubs it from thrown errors
  (`providers/redact.ts`).
- No persona/age logic lives in this server — the 18+ floor is enforced upstream at the text's
  origin (`companion/types.ts`), same as every other companion surface.
- A tunnel URL is a public URL. Treat it the same as the portrait/scene tunnels: don't publish
  it outside your own `.env`, and expect to rotate it whenever the Colab/Kaggle session restarts.
