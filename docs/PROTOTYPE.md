# PROTOTYPE — "How soon until we see a prototype?"

**Short answer: you can see it right now, locally, with one command.** A *public* prototype
(a URL a stranger can click, backed by a real GPU model) is an ops task — hours of setup, not
months of building. This doc is the honest timeline: what already works, what's a weekend of
plumbing, and what is genuinely still ahead.

> **Definition first — so we don't oversell (see [Prototype vs Production](#prototype-vs-production)):**
> A **prototype** proves the shape of the product end-to-end (the front door, the routing laws,
> the metering, the marketing surface) even if the heavy inference is simulated or runs on one
> small model. **Production** is the same thing hardened, scaled, secured, and on-call. We are
> at "prototype, running locally today" and one ops push from "prototype, running in public."

---

## NOW — already built, runs on your machine (offline, zero paid APIs)

One command boots the whole marketable prototype and verifies it over HTTP:

```bash
npm run prototype
# → installs deps if needed, typechecks, runs a fast smoke, starts the gateway on :8787,
#   curls health/intent/pricing/waitlist/metrics, then prints every URL & file to open.
#   Ctrl+C stops the gateway. Add --ci to boot-verify-and-exit (no interactive hang).
```

Under the hood, every piece below is real, tested (`npm test` → 260+ checks green), and flows
through the constitution's laws (**HOPE → APEX → KNOLL → DREAM/VISION**, no bypass):

| Capability | What it is | Exact command |
| --- | --- | --- |
| **One-command boot** | Boot + live-verify the prototype | `npm run prototype` (or `./scripts/prototype.sh --ci`) |
| **Programmatic smoke** | All gateway handlers, no port needed | `npm run smoke` |
| **HOPE HTTP gateway** | `node:http`, zero deps; `/v1/intent`, `/v1/health`, `/v1/metrics`, `/v1/matrix/stats`, ledger/audit | `npm run gateway` → http://localhost:8787 |
| **Natural-language intent** | HOPE interprets → APEX routes → KNOLL gates | `POST /v1/intent {"utterance":"…"}` |
| **Billing / metering** | Active-parameter-second pricing, 5 tiers, per-tenant allowances | `GET /v1/billing/pricing` · `npm run demo:billing` |
| **MCP server** | Drive the matrix from Cursor / any MCP client | `npm run mcp` · config in `docs/MCP.md` |
| **Marketing landing page** | Static, self-contained, no build step | `npm run marketing` → `marketing/index.html` |
| **Waitlist** | Static form → `POST /v1/waitlist` (public, rate-limited, idempotent) | `npm run waitlist` → `marketing/waitlist.html` |
| **Showcase** | Static architecture/product showcase | `npm run showcase` → `showcase/index.html` |
| **Eval board** | Scores 5 headline metrics against the real APEX→KNOLL gate | `npm run eval:board` → `eval/out/` |
| **Local demos** | End-to-end walkthroughs of each layer | `npm run demo` · `demo:phase2/4` · `demo:vision` · `demo:providers` · `demo:tenancy` · `demo:metrics` |

**What "NOW" is honestly missing:** the heavy inference is simulated (DREAM/VISION workers emit
structured stubs, not 7B GPU output — see [`docs/PHASES_5_8_STATUS.md`](./PHASES_5_8_STATUS.md)),
persistence defaults to in-memory, and there is no public URL yet. Everything else — the routing
laws, the metering math, the front door, the marketing funnel — is real and testable today.

---

## TODAY → THIS WEEKEND (ops, not engineering) — a public URL prototype

No new product code required. This is provisioning + DNS + a model runtime. Runbooks already
exist in the repo:

1. **Stand up a box** — a Hostinger VPS (or any Ubuntu host). Bootstrap script + systemd unit +
   reverse proxy are written: [`deploy/HOSTINGER.md`](../deploy/HOSTINGER.md),
   `deploy/bootstrap_hostinger.sh` (`npm run bootstrap:hostinger`), `deploy/hdv-gateway.service`,
   `deploy/Caddyfile` / `deploy/nginx.conf.sample`.
2. **Point a domain at it** — A record → the VPS; Caddy fetches TLS automatically. Set
   `HDV_API_KEY`, `HDV_RATE_LIMIT`, `HDV_CORS_ORIGIN` (see `.env.example`).
3. **Add a real model runtime** — install **Ollama** and pull a small local model so `/v1/intent`
   can return genuine model output instead of a stub: [`deploy/OLLAMA.md`](../deploy/OLLAMA.md).
   The provider seam (`providers/`, `tenancy/` BYOK) is already wired for this.
4. **Publish the funnel** — serve `marketing/index.html` + `marketing/waitlist.html` from the same
   box, pointed at the live gateway (`waitlist.html?api=https://your-gateway`).

**Result:** a link you can send anyone — landing page, working waitlist, and a live gateway that
answers real intents against a small model. That is a bona-fide public prototype.

---

## NEXT 2 WEEKS — from "it exists" to "people can sign up and pay"

| Milestone | Definition of done | Builds on |
| --- | --- | --- |
| **Waitlist live** | Public form on the domain, submissions landing in a durable store, stats visible | `market/`, `POST /v1/waitlist`, flip persistence to Postgres |
| **Stripe test mode** | Checkout in test mode wired to the tier table; a signup can "subscribe" with a test card | `billing/` + `config/pricing.json` already model the tiers |
| **Demo video published** | 2–3 min screen recording of the one-command boot + a real intent, on the landing page | script/checklist in `marketing/DEMO_VIDEO.md` |
| **First 10 design partners** | 10 real teams using the public prototype, giving feedback | GTM plan in [`docs/GTM.md`](./GTM.md), launch steps in [`docs/LAUNCH_CHECKLIST.md`](./LAUNCH_CHECKLIST.md) |

This fortnight is mostly integration + go-to-market, not core architecture. The laws, metering,
and API surface don't change.

---

## PHASE 5 — the first *real* GPU slice (the honest hard part)

The one thing simulation can't fake: a real 7B model doing real work and reporting back through
the constitution. Target: **one Colab/Hostinger 7B worker completes a task and reports through APEX.**

- **Definition of done:** a DREAM or VISION worker runs an actual 7B model on a GPU, produces a
  result, and re-ingests it via `POST /v1/worker/report` → **APEX → KNOLL → HOPE**, appearing in
  the ledger and on `/v1/metrics` — with **zero** DREAM↔VISION direct contact.
- **Already real (the seams):** the worker *protocol* (`colab/worker_protocol.py`,
  `colab/05_horizontal_worker.py`), the re-ingest endpoint and its guards (`gateway/`,
  `tests/worker_report.test.ts`), and the model-backend hook (`colab/06_gpu_model_hooks.py`).
- **Still to do:** load a real 7B behind that hook and run it on a GPU (Colab T4 or a Hostinger
  GPU slice). Everything downstream — routing, gating, billing, metrics — already handles the
  result the moment it's real.
- **Then Phase 6 scaling** (K8s + KEDA scale-to-zero + vLLM shared 7B + LoRA personas) turns one
  worker into the fleet — see [`docs/SCALE.md`](./SCALE.md) and
  [`docs/PHASES_5_8_STATUS.md`](./PHASES_5_8_STATUS.md).

---

## Prototype vs Production

| | **Prototype** (where we are) | **Production** (the goal) |
| --- | --- | --- |
| **Inference** | Simulated stubs, or one small local model (Ollama / one 7B) | vLLM-served shared 7B + per-persona LoRA across the fleet |
| **Scale** | One box, one process | K8s + KEDA scale-to-zero workers, node-slice leasing |
| **Persistence** | In-memory by default | Postgres/Prisma + durable queue (Kafka) default-on |
| **Security** | KNOLL laws + per-packet SHA-256 + auth/rate-limit middleware (all real) | + hash-chain audit, JWT tenancy, row-level isolation, KMS, pen-test |
| **Billing** | Metering math + allowances real; no money moves | Stripe live mode, real GPU-second cost ledger |
| **Availability** | "Runs when I run it" | On-call, SLAs, observability/alerting, multi-region |
| **What's proven** | The *shape*: front door, routing laws, metering, funnel — end-to-end and tested | The *shape at scale*: hardened, secured, and reliable |

**Bottom line:** the prototype is not a mock-up — it's the real architecture with simulated
muscle. Making the muscle real (Phase 5) and making it scale/harden (Phases 6–8) is the road
ahead; the skeleton and nervous system already work today, verifiable with `npm run prototype`.
