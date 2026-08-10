# Local LLM on the VPS — Ollama (co-located inference)

> How to run a small **7B–8B model locally on the same Hostinger KVM4** so HDV Foundation
> can enrich text with a real model **without any third-party key leaving the box**. This is
> the "Local / self-host" provider mode from [`HOSTINGER.md`](./HOSTINGER.md) §8.
>
> **Scope reminder (constitution §6 / providers seam):** a provider is a pure *text
> transducer* — `complete(prompt) -> { text }`. Ollama here only enriches HOPE's
> human-readable intent summary. It **never** routes, executes, creates, or bypasses APEX/
> KNOLL. Swapping the stub for a real model changes *text quality*, nothing about governance.

---

## 1. Is KVM4 enough?

| Model | Quant | Approx RAM | CPU-only feel on KVM4 | Verdict |
|-------|-------|-----------|-----------------------|---------|
| `llama3.2:3b`  | Q4 | ~3–4 GB  | fastest, decent for summaries | ✅ recommended default |
| `llama3.1:8b`  | Q4 | ~6–8 GB  | usable, seconds per short reply | ✅ good if you want more quality |
| `mistral:7b`   | Q4 | ~5–6 GB  | similar to 8b | ✅ fine |
| `llama3.1:70b` | any | 40 GB+ | not viable on CPU KVM4 | ❌ use BYOK/hosted |

KVM4 (~16 GB RAM, ~4 vCPU, **no GPU**) runs a **quantized 7B/8B on CPU**. It works, but
CPU inference is slow (expect a few seconds for a short completion). For latency-sensitive
or high-volume workloads, prefer **BYOK / a hosted OpenAI-compatible provider** and keep
Ollama for offline/private deployments. Because providers only enrich a short summary
line, even slow local inference is acceptable for many use cases.

> If you attached a GPU plan, Ollama uses it automatically; the numbers above are the
> CPU-only floor that KVM4 guarantees.

---

## 2. Install Ollama (bare metal)

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

The installer registers a systemd service. **Keep it bound to loopback** so it is never
publicly reachable (do not `ufw allow 11434`):

```bash
sudo systemctl edit ollama
```

Add:

```ini
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
# Optional: cap memory / keep models warm
Environment="OLLAMA_KEEP_ALIVE=30m"
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
sudo systemctl enable ollama
```

Pull a model:

```bash
ollama pull llama3.2:3b        # fast default
# or: ollama pull llama3.1:8b
```

Smoke-test the OpenAI-compatible endpoint (Ollama exposes `/v1` natively):

```bash
curl -s http://127.0.0.1:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"llama3.2:3b","messages":[{"role":"user","content":"Say hi in one line."}]}' \
  | head -c 400; echo
```

---

## 3. Wire it into HDV (provider seam)

Edit `big5-matrix/.env`:

```bash
HDV_LLM_PROVIDER=openai_compatible
HDV_LLM_BASE_URL=http://127.0.0.1:11434/v1   # loopback — same box
HDV_LLM_MODEL=llama3.2:3b
HDV_LLM_API_KEY=                              # empty: Ollama is keyless
```

Restart the gateway to pick up the change:

```bash
sudo systemctl restart hdv-gateway            # bare-metal path
# or (Docker path B):
#   docker compose -f deploy/docker-compose.prod.yml up -d gateway
```

Verify the provider builds (offline check, no network to a vendor):

```bash
cd big5-matrix
npm run demo:providers        # uses HDV_LLM_* if set, else the deterministic stub
```

---

## 4. Docker path (compose profile)

If you deploy via [`docker-compose.prod.yml`](./docker-compose.prod.yml), start the
bundled Ollama service with its profile and point the gateway at the internal hostname:

```bash
docker compose -f deploy/docker-compose.prod.yml --profile local-llm up -d
# pull a model into the container's volume:
docker compose -f deploy/docker-compose.prod.yml exec ollama ollama pull llama3.2:3b
```

Then in `.env` (note the **service name**, not localhost, inside the Docker network):

```bash
HDV_LLM_PROVIDER=openai_compatible
HDV_LLM_BASE_URL=http://ollama:11434/v1
HDV_LLM_MODEL=llama3.2:3b
HDV_LLM_API_KEY=
```

Restart the gateway container:

```bash
docker compose -f deploy/docker-compose.prod.yml up -d gateway
```

---

## 5. vLLM alternative (if you add a GPU)

The same seam works with any OpenAI-compatible server. On a GPU host, vLLM gives far
higher throughput than CPU Ollama:

```bash
# on a GPU box:
pip install vllm
python -m vllm.entrypoints.openai.api_server \
  --model mistralai/Mistral-7B-Instruct-v0.2 --host 127.0.0.1 --port 8000
```

```bash
# .env:
HDV_LLM_PROVIDER=openai_compatible
HDV_LLM_BASE_URL=http://127.0.0.1:8000/v1
HDV_LLM_MODEL=mistralai/Mistral-7B-Instruct-v0.2
HDV_LLM_API_KEY=
```

This is the local counterpart to the Phase 5/6 GPU worker path in `docs/ROADMAP.md` — the
persona/DREAM worker (`colab/`) can also target a shared vLLM server instead of loading a
model per persona.

---

## 6. Model choice for companion/chat (FuckLike)

The recommendations in §1 are tuned for **HOPE's enrichment path** (a one-line intent
paraphrase) — any small instruct model is fine there. **Companion chat is a different
workload**: personas are adult (18+, enforced server-side — see `companion/types.ts`) fictional
characters whose personalities span playful/romantic/bratty/dominant, and the product
explicitly wants in-character flirtatious/explicit dialogue, not a refusal. Mainstream
instruct models (`llama3.1:8b`, `llama3.2:3b`, etc.) are heavily RLHF-tuned to deflect or
sanitize that regardless of system prompt — the model itself, not the prompt, is the limiter.

**Recommended: `dolphin-llama3:8b`** — verified via the Ollama library and Hugging Face
Hub API before picking (not guessed):
- In Ollama's **official** library namespace (`ollama.com/library/dolphin-llama3`), not a
  community mirror — gets the same maintenance/format guarantees as any other official model.
- Built on `meta-llama/Meta-Llama-3-8B`; HF page (`dphn/dolphin-2.9-llama3-8b`) shows 408K+
  downloads, 504 likes, actively maintained. License is the inherited Llama 3 Community
  License, which **permits commercial use** (the only restriction is a 700M-MAU cap this
  product is nowhere near) — this matters because most of the popular community roleplay
  finetunes (Stheno, Llama-3SOME, etc.) are `cc-by-nc-4.0`, i.e. **non-commercial only**, which
  rules them out for a paid product.
- Purpose-built to follow system-prompt character instructions "without moralizing" rather
  than being a blanket "remove every refusal for anything" abliterated model — the narrower,
  more appropriate category for adult roleplay specifically, not general harm-removal.
- Same 8B size as the other options above, so the KVM4 CPU-inference math in §1 still applies.

```bash
docker compose -f deploy/docker-compose.prod.yml exec ollama ollama pull dolphin-llama3:8b
```

```bash
# .env — companion chat only; HOPE enrichment can stay on a smaller model if you run two:
HDV_LLM_PROVIDER=openai_compatible
HDV_LLM_BASE_URL=http://ollama:11434/v1
HDV_LLM_MODEL=dolphin-llama3:8b
HDV_LLM_API_KEY=
```

Restart the gateway after changing `.env` so it picks up the new model (see §3/§4 above).

`companion/handlers.ts`'s system prompt already frames every chat as consensual fictional
roleplay between verified adults and states explicit content is allowed when in-character —
that framing plus a model that isn't fighting it is what actually gets you past "same
generic response on repeat" behavior. Re-verify this pick periodically the same way it was
picked: check current download/like counts and license on Hugging Face before assuming it's
still current.

---

## 7. Security notes

- **Never expose `11434`.** Bare metal: `OLLAMA_HOST=127.0.0.1`. Docker: use `expose:`
  (internal network) not `ports:` (host). No `ufw allow 11434`.
- **No key needed** for local inference — nothing to leak. This is the strongest privacy
  posture (the "Local / self-host" row in `HOSTINGER.md` §8): prompts never leave the VPS.
- Local inference does **not** change the trust boundary: the model text still flows back
  as plain text through the provider seam, and every *routed packet* is still KNOLL-gated.
- If you offer this to customers as "private inference," that's a genuine BYO-hardware
  story: their data and their model both stay on infrastructure they control.
