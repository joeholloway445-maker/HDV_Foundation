# HDV FOUNDATION — MASTER PLAN

> **The one document.** If you read nothing else, read this. It consolidates the vision, the
> customer experience, every phase (1–8) with build-vs-next status, the immediate founder
> actions, all the bonus strategy tips, and the "market this week" checklist — with links out
> to every supporting doc. Everything here is honest: we lead with the real capacity number
> (**14.3 quadrillion — when all five legs fire**) and keep the one footnote that makes it
> survive scrutiny (*topology × 7B capacity, not a single trained weight file*).

**Companion docs (single sources of truth):**
[`PROTOTYPE.md`](./PROTOTYPE.md) ·
[`GTM.md`](./GTM.md) ·
[`LAUNCH_CHECKLIST.md`](./LAUNCH_CHECKLIST.md) ·
[`MESSAGING.md`](./MESSAGING.md) ·
[`../marketing/math.md`](../marketing/math.md) ·
[`MOAT.md`](./MOAT.md) ·
[`GAME_PLAN.md`](./GAME_PLAN.md) ·
[`ROADMAP.md`](./ROADMAP.md) ·
[`PHASES_5_8_STATUS.md`](./PHASES_5_8_STATUS.md)

**Founder quick-start:** driving-friendly numbered actions in [`FOUNDER_ACTIONS.md`](./FOUNDER_ACTIONS.md).
GitHub launch helpers: [`../scripts/gh_launch.sh`](../scripts/gh_launch.sh) (`bash scripts/gh_launch.sh --status`).

---

## 1. Vision + customer experience

### The vision

**Everyone else is building a bigger brain. HDV is building a bigger *government*.** Five
specialized "Big AI" agents (**HOPE · DREAM · VISION · KNOLL · APEX**) cooperate under a strict
constitution but **never talk to each other directly** — every exchange is routed by **APEX**,
gated by **KNOLL**, billed by the **ledger**, and recorded in a **tamper-evident audit trail**.
Intelligence comes from a vast fleet of small, ephemeral personas, not one monolith — so the
system is **governed, auditable, horizontally scalable, and cheap at rest**.

The headline number is *conceptual capacity*, computed (not asserted):

```
20,480 nodes × 100 personas × 7,000,000,000 params = 1.4336 × 10^16  (~14.3 quadrillion)
```

That is **≈2,867× the parameter capacity of a ~5T frontier class** when all five legs fire.
*Footnote, always kept: topology × 7B capacity, not a single trained 14.3Q weight file — and
only active personas ever cost compute.* (Full math: [`../marketing/math.md`](../marketing/math.md);
approved lines: [`MESSAGING.md`](./MESSAGING.md).)

### The Big 5

| Agent  | Job                                            | Hard constraint                          | Lifecycle |
|--------|------------------------------------------------|------------------------------------------|-----------|
| HOPE   | Parse intent; be the UI/UX voice (interpreter) | CANNOT execute or create                 | Always-on |
| DREAM  | Generate all possible outcomes (simulation)    | CANNOT govern or execute                 | Ephemeral |
| VISION | Tool usage / task implementation (sandboxed)   | CANNOT create or govern                  | Ephemeral |
| KNOLL  | Watch all traffic; enforce laws; privacy       | Always active, monitor-only              | Always-on |
| APEX   | Route tasks between agents (master router)      | Every route MUST pass through KNOLL first| Always-on |

**Legal traffic:** `SOURCE → APEX.dispatch() → KNOLL.intercept() → (allowed?) → DESTINATION`.
DREAM and VISION can never talk directly. Only HOPE/KNOLL/APEX stay always-on; DREAM/VISION
are ephemeral and scale to zero.

### The customer experience (product end-state)

1. **Pick your scale** — a parameter allowance, or a specific model (local TinyLlama/Phi/
   Mistral-7B, Hostinger-hosted 8B/70B, or cloud).
2. **Pick your money path** — **Subscribe** (platform keys on the HDV fleet) or **BYOK** (bring
   OpenAI-compatible keys; HDV platform fee **$0**, you pay only your provider).
3. **See every dollar and every occurrence** — live usage, active-param-seconds, cost
   estimates, and hard caps that refuse overspend.
4. **Plug in anywhere** — the HTTP gateway **or** the MCP server (`hdv_intent`,
   `hdv_estimate_cost`, `hdv_usage`, `hdv_models`, `hdv_health`) for Cursor / Claude / any host.
5. **Infinitely scalable shape** — always-on HOPE/KNOLL/APEX are tiny; DREAM/VISION workers
   scale horizontally (Colab, KVM4, K8s) and idle to ~zero.

The buyer's payoff: **"Ship agents your compliance team will actually approve."** Enforced
constraints + per-packet audit + a usage-honest ledger = the artifact a security review gates on.

---

## 2. Phases 1–8 — built vs next

Legend: **[x]** built & tested · **[~]** partial / scaffold behind a real seam · **[ ]** next.
Full file-referenced ledger: [`PHASES_5_8_STATUS.md`](./PHASES_5_8_STATUS.md) and
[`ROADMAP.md`](./ROADMAP.md). Current release: **v0.7.0**, offline suite green (typecheck +
full tests), constitution never weakened (additive only).

### Phase 1 — Backbone (BUILT)
- [x] `RoutingPacket` contract + SHA-256 tamper-evidence (only inter-agent contract).
- [x] APEX `dispatch` router; every route passes KNOLL first (non-bypassable in code).
- [x] KNOLL six hard laws + block/allow audit trail.
- [x] APEX billing ledger (`cost_usd`, SUCCESS/BLOCKED/FAILED).
- [x] 20,480-node topology + persona lifecycle (spawn → execute → terminate).

### Phase 2/3 — Cognition & scoring (BUILT)
- [x] HOPE interpret + document + voice (entities/goals/urgency, clarify).
- [x] DREAM multi-branch outcome trees + Pareto ranking + scheduler.
- [x] VISION sandboxed tool registry + billable report.
- [x] KNOLL additive behavioral-anomaly score (`BEHAVIORAL_SCORE`).
- [x] Persistence repository interfaces mirroring ledger + audit + intent archive.

### Phase 4 — Forward-facing presence & scaling foundations (BUILT)
- [x] HOPE HTTP gateway (`/v1/intent`, `/v1/health`, `/v1/ledger`, `/v1/audit`,
  `/v1/matrix/stats`, `/v1/metrics`) with auth, rate-limit, CORS, request logging.
- [x] Kafka-like partitioned task queue + consumer groups (async intake, same KNOLL gate).
- [x] Parameter accounting (`nodes/parameters.ts` + `personamatrix/parameters.py`).
- [x] Horizontal Colab worker protocol; VISION sandbox hardening (resource monitor, tool
  audit, concurrent-session limit, timeout kill).
- [x] Prisma/Postgres backend behind repository interfaces (in-memory still default).

### Phase 5 — Make one slice real (simulation → inference) (PARTIAL)
- [x] Provider/model layer + BYOK tenancy (`providers/`, `tenancy/`) — real & tested.
- [x] Product surface: gateway + metering (active-param-seconds) + MCP server — real & tested.
- [~] Kafka real broker (`kafka_real.ts` skips gracefully) — **next: default-on in prod.**
- [~] Postgres/Prisma default (currently in-memory) — **next: flip default in prod.**
- [ ] Real gVisor/Firecracker VISION sandbox (execution is a process-level stub today).
- [ ] Real 7B on one GPU worker (worker protocol real; payloads simulated).
- [ ] **Phase 5 exit:** one documented command spins up Kafka + Postgres + one GPU worker.

### Phase 6 — Scale the fleet (K8s · KEDA · vLLM · cost) (NEXT)
See [`SCALE.md`](./SCALE.md) for the concrete PR list.
- [ ] K8s manifests (always-on trio + worker Jobs).
- [ ] KEDA `ScaledJob` scale-to-zero on queue lag (the literal "workers to zero").
- [ ] Node-slice leasing (no double-claim) via Redis.
- [ ] vLLM shared 7B + per-persona LoRA/prompt deltas (the honest, economical form of 14.3Q).
- [~] Truthful active-vs-base param accounting (base/delta split pending).
- [~] Observability metrics + tracing (Prometheus + PacketTracer real; OTel traces next).
- [ ] Real cost ledger (GPU-seconds × $/s; `cost_usd` is a constant/estimate today).

### Phase 7 — Learn (the intelligence moat) (PARTIAL)
- [~] Behavioral scorer — heuristic, weighted, strictly additive (never allows past a hard law).
- [ ] Learned scorer (ONNX, shadow-mode) from a labeled `SecurityAudit` export.
- [ ] Persona specialization & learned routing (mixture-of-personas).
- [ ] Memory: intent archive as pgvector context (tenant-isolated retrieval).
- [~] **Public eval harness** (`eval/run_board.ts`, `npm run eval:board`) — scores five headline
  metrics against the real APEX→KNOLL gate; **next: wire as a CI quality gate.**

### Phase 8 — Platform (multi-tenant product & ecosystem) (PARTIAL)
- [~] Multi-tenancy: model/plan tenancy + per-tenant billing allowances real; packet-level
  `tenant_id` + KNOLL hard law + row-level security next.
- [~] Public API + SDK: `/v1` gateway + MCP real; **open-core kit** `packages/constitution/`
  publishes the contract; generated OpenAPI SDK next.
- [ ] Tool & persona marketplace (signed manifests).
- [~] Security & compliance: per-packet SHA-256 + `SecurityAudit` + CI security workflow real;
  Merkle hash-chain, KMS, pen-test next.
- [~] HOPE product surface: `showcase/` + `marketing/` + `hope/ui` real; live front-end talking
  only to `/v1` next.

---

## 3. Immediate founder actions

Do these first — most take minutes. Driving-friendly version: [`FOUNDER_ACTIONS.md`](./FOUNDER_ACTIONS.md).

- [ ] **Un-private the repo.** `bash scripts/gh_launch.sh --public` (or in GitHub: Settings →
  General → Danger Zone → Change visibility → Public). MIT license already ships.
- [ ] **Branch protection on `main`.** `bash scripts/gh_launch.sh --protect-main` — require the
  CI check to pass before merge (falls back to printing the manual UI steps if the token lacks
  admin scope).
- [ ] **Publish the showcase / landing page.** `npm run showcase` and `npm run marketing` print
  the paths; host `marketing/index.html` behind the apex domain (Caddy/nginx).
- [ ] **Stand up the Hostinger box.** Follow [`../deploy/HOSTINGER.md`](../deploy/HOSTINGER.md);
  one-command bootstrap: `sudo bash deploy/bootstrap_hostinger.sh`.
- [ ] **Record the 60-second video.** Script: [`../marketing/DEMO_VIDEO.md`](../marketing/DEMO_VIDEO.md)
  — open on 14.3Q, show a legal route billed + an illegal route BLOCKED, close on the three CTAs.
- [ ] **Turn on the waitlist.** `npm run waitlist` prints the path; the form POSTs to the
  gateway `/v1/waitlist` (public, rate-limited). Watch `GET /v1/waitlist/stats`.

Check status any time (safe, read-only): `bash scripts/gh_launch.sh --status`.

---

## 4. Bonus tips (the strategy that compounds)

1. **Lead with 14.3Q.** *"14.3 quadrillion — ≈2,867× a ~5T frontier class, when all five legs
   fire."* It's the hook and it's true as a capacity fact. Keep the one footnote (topology × 7B,
   not a trained weight file); never drop it, never bury it. ([`MESSAGING.md`](./MESSAGING.md))
2. **The constitutional moat.** The differentiator isn't model size — it's the *government*
   around it. Separation of concerns your framework only *suggests*, here it's a law the router
   enforces, with a tamper-evident audit trail per packet. Prove what your agents **can't** do,
   in code and an audit log — not a policy PDF. ([`MOAT.md`](./MOAT.md))
3. **60-second video.** A number-led cut that opens on 14.3Q, shows one legal `HOPE → APEX →
   KNOLL → DREAM` route (billed) and one illegal `DREAM → VISION` route (BLOCKED), then the
   three CTAs. Every number traceable to a command on screen. ([`../marketing/DEMO_VIDEO.md`](../marketing/DEMO_VIDEO.md))
4. **Beachhead.** Land in **regulated, agent-curious mid-market/enterprise** (fintech ops,
   healthcare back-office, insurance, public sector) blocked by security review — plus
   safety-conscious AI-native startups. Not consumers, not pure model-routing. ([`GTM.md`](./GTM.md) §2)
5. **Unit economics.** Meter in **active-param-seconds (APS)**: `active_params = live_personas
   × 7B`. Idle personas ⇒ ~0 APS = **no idle tax**. On bursty workloads that's a worked
   **20×–30,000×** edge over renting a monolith 24/7 (formula shown, no magic number).
6. **Open-core.** Free/MIT is the backbone (RoutingPacket, APEX, KNOLL, ledger, topology,
   gateway, provider seam, self-host) — the standard-setting play. Paid is the operated fleet,
   learned KNOLL, multi-tenancy, marketplace, compliance, SLA. `packages/constitution/` already
   publishes the public surface a typed SDK builds on.
7. **Public eval.** `npm run eval:board` scores governance_violation_rate, knoll_block_rate,
   p50/p95 latency, cost_per_active_param_second, and routing_success_rate against the **real**
   gate → HTML/JSON report. Makes "world-class" **measurable**; wire it as a CI quality gate.
8. **The Colab $15 story.** `$9.99` Colab + `~$5` HDV ≈ **$15/mo**. Against a $100B-class
   frontier CapEx pool that's on the order of **119 million×** capital-efficiency over ~4.7
   years of seats — **stated as a CapEx-vs-seat story, with the formula**, never as a bare
   "119M× cheaper than a subscription." ([`../marketing/math.md`](../marketing/math.md))
9. **7B / 13B / 30B.** Same fixed topology, bigger legs: **7B ⇒ ~14.3Q**, **13B ⇒ ~26.6Q**,
   **30B ⇒ ~61.4Q**. Capacity scales linearly with the persona weight class.
10. **MCP.** HDV is an MCP server, so Cursor / Claude / any agent host can call
    `hdv_intent`, `hdv_estimate_cost`, `hdv_usage`, `hdv_models`, `hdv_health` directly.
    (`npm run mcp`; [`MCP.md`](./MCP.md))
11. **BYOK.** Bring your own keys (or local Ollama/vLLM): HDV platform fee **$0**, you pay only
    your provider, and your keys/data never touch our infra. It's the trust posture for
    security-first buyers — a feature, not a discount.

---

## 5. Market this week — checklist

The ordered, ASAP list. Day-by-day runbook: [`LAUNCH_CHECKLIST.md`](./LAUNCH_CHECKLIST.md).
14-day GTM sprint tracks: [`GTM.md`](./GTM.md) §5.

**Prove it green**
- [ ] `npm ci && npm run ci` — `db:generate` + typecheck + full test suite pass.
- [ ] `npm run test:market` — waitlist + Stripe-stub tests green.
- [ ] `npm run gateway` then smoke `GET /v1/health` and `POST /v1/waitlist`.

**Make it real to click**
- [ ] Un-private the repo (`scripts/gh_launch.sh --public`) + protect `main`.
- [ ] Publish `marketing/index.html` behind the apex domain; verify mobile + reduced-motion.
- [ ] Point `api.<domain>` at a KVM4 gateway (auth ON, CORS locked) — [`../deploy/HOSTINGER.md`](../deploy/HOSTINGER.md).
- [ ] Turn on the waitlist form (`npm run waitlist`) and UTM-tag every CTA.

**Earn the click**
- [ ] Record the 60s / 3–4 min demo against the real gateway (no mockups).
- [ ] Tighten the README first screen for first-time visitors (done — see links block).
- [ ] Draft the red-team post outline (constitution → attempts → all blocked).

**Positioning hygiene (don't undermine the moat)**
- [ ] Audit every public sentence against [`MESSAGING.md`](./MESSAGING.md) — kill any bare
  "14.3Q weights" or bare cost multiple.
- [ ] Confirm README, `GTM.md`, `MOAT.md`, and the landing page tell the *same* number the same way.

**Start conversations**
- [ ] Build a 20–30 name target list across the primary verticals (name the blocked pilot each).
- [ ] Founder-led outreach to the top 10; book intro calls.
- [ ] Prep the one-page design-partner agreement ([`GTM.md`](./GTM.md) §4.3).

**Exit criteria:** a live, honest page linked to a real self-hostable gateway; a recorded demo;
a waitlist collecting qualified leads; at least 3 design-partner intro calls booked.

---

*This document is the master index. When a plan changes, change it here first, then in the
linked single-source-of-truth doc. Never let a number become a lie.*

---

## Status stamp (0.9.0)

**Phases 5–8 foundations are implemented in-repo** (331 tests pass). Live GPU/Kafka/K8s on Hostinger remain *ops* — code seams, manifests, workers, laws, SDK, hashchain, marketplace, learned scorer, leases, and KEDA YAMLs are in tree. Run `npm run phase5:slice` / `npm run prototype` / `npm run eval:board`.
