# HDV FOUNDATION — GO-TO-MARKET (GTM)

> The plan to take HDV Foundation from a tested backbone to a marketed product. This is the
> operational companion to [`MOAT.md`](./MOAT.md) (the strategic case) and
> [`ROADMAP.md`](./ROADMAP.md) (the engineering path). It stays **honest**: we market
> *governance + metered active parameters*, never fake "14.3-quadrillion trained weights."
>
> Surfaces this doc drives:
> - Landing page: [`../marketing/index.html`](../marketing/index.html) (`npm run marketing`)
> - Deploy runbook: [`../deploy/HOSTINGER.md`](../deploy/HOSTINGER.md)
> - Product API: the HOPE gateway (`npm run gateway`)

---

## 1. Positioning (honest, one paragraph)

**HDV Foundation is a governed agent platform: five specialized AI agents under one
constitution, where every action is routed by APEX, gated by KNOLL, billed by the ledger,
and recorded in a tamper-evident audit trail.** It is idle-cheap by construction (only
three roles stay always-on; DREAM/VISION are ephemeral and scale to zero) and auditable by
design. We charge for the compute that actually runs — **active-param-seconds** — not for a
model sitting at rest.

What we will **never** claim:

- ❌ "14.3 quadrillion trained parameters." → ✅ "~14.3-quadrillion-persona **conceptual
  capacity** (20,480 nodes × 100 personas × 7B), where only active personas cost compute."
- ❌ "Smarter than GPT/Claude." → ✅ "The governance, audit, and cost layer **around** any
  model you already use."
- ❌ "Fully autonomous." → ✅ "Autonomy **inside enforced constraints** — HOPE can't execute,
  VISION can't govern, DREAM and VISION can't talk."

> The honest headline, verbatim for every deck and page:
> **"A governed matrix where only active personas cost compute — routed, gated, billed, and
> auditable by design."**

### One-liners by audience
- **Engineering leader:** "Separation of concerns your framework only *suggests* — here it's a
  law the router enforces, with a tamper-evident audit trail per packet."
- **Security / compliance:** "Prove what your agents *can't* do — in code and an audit log,
  not a policy PDF."
- **Finance / procurement:** "No idle tax. You're metered in active-param-seconds; an idle
  matrix costs ~nothing."

---

## 2. ICP (ideal customer profile)

### Primary ICP — regulated, agent-curious mid-market/enterprise
- **Who:** platform/AI-infra teams in **fintech ops, healthcare back-office, insurance, and
  public sector**; 50–2,000 employees; already piloting agents but blocked by security review.
- **Pain:** "Our compliance team won't approve an agent that can do anything." Frameworks give
  advisory guardrails; incident review can't answer "why did it do that / what did it cost?"
- **Why HDV:** enforced constraints + per-packet audit + billing ledger = the artifact the
  security review actually gates on. Self-host/on-prem/BYOK keeps data in their boundary.
- **Buyer:** Head of Platform / Eng, CISO or security architect (technical champion first).
- **Trigger:** a stalled agent pilot, an audit finding, or a "we need this on-prem" mandate.

### Secondary ICP — safety-conscious AI-native startups & dev tooling teams
- **Who:** teams building agentic products who want governance/billing/audit **without
  building it themselves**; value open-core + SDK + fast self-host.
- **Why HDV:** drop-in governed gateway (HOPE) in front of their existing models/tools; land
  small, expand along the five roles.
- **Buyer:** founding/staff engineer; low-friction, bottoms-up adoption from the MIT repo.

### Explicitly **not** our ICP (for now)
- Consumers / chat-app users (no governance pain).
- Teams whose only need is model routing/fallback (LiteLLM territory) with no audit/compliance driver.
- Anyone shopping purely on raw model capability — that's the monolith race we don't fight.

---

## 3. Pricing (aligned to active-param-seconds)

The meter is the architecture. The APEX ledger already records `cost_usd` per ephemeral
execution; the honest unit is the **active-param-second (APS)**:

```
1 APS = active_parameters × 1 second of real compute
active_parameters = live_personas × MODEL_PARAMS   (7B today)
```

Idle personas ⇒ ~0 APS. This is the "no idle tax" promise, and it's already instrumented.

### Tier sketch (early — validate with the first 10 design partners)

| Tier | Price | APS allowance | For | Notes |
|------|-------|---------------|-----|-------|
| **Free** | $0 | 100K APS / mo | evaluators, self-hosters | MIT backbone, full audit + ledger, community support. Enough for a governed prototype. |
| **Starter** | $49 / mo | 25M APS / mo, then metered | small teams shipping one governed workflow | managed gateway, Postgres, auth/rate-limit/CORS, email support. |
| **Pro** | $299 / mo | 500M APS / mo, then metered | teams in production | priority DREAM/VISION capacity, higher limits, SSO-ready, red-team report, priority support. |
| **BYOK** | from $99 / mo + your keys | unlimited governed calls; **no APS meter on your inference** | teams with their own model contracts / on-prem | flat governance platform fee; inference billed by *your* vendor. Self-host or managed. |
| **Enterprise** | custom | custom + committed-use discount | regulated buyers | on-prem/VPC, SSO/DPA, audit-log export, SLA, compliance mapping (Phase 8). |

### Two honest revenue mechanics
1. **Metered platform (Free/Starter/Pro):** APS overage above the included allowance, billed
   from the ledger. This aligns our revenue with the customer's real usage — no idle tax, no
   surprise on a quiet month.
2. **BYOK governance fee:** when the customer brings their own model keys (or runs local
   Ollama/vLLM per [`../deploy/OLLAMA.md`](../deploy/OLLAMA.md)), we don't double-charge for
   inference they already pay their vendor for. We charge a **flat fee for the governance
   layer** (routing, KNOLL gating, ledger, audit, multi-tenancy). This is the wedge for
   security-first buyers who insist their keys/data never touch our infra.

### Overage & metering integrity
- Overage rate expressed as **$ / million APS** (set after design-partner cost benchmark,
  ROADMAP 6.3 turns ledger `cost_usd` from a constant into measured GPU-seconds × $/s).
- The ledger is the single source of truth; customers can pull their own APS from
  `GET /v1/ledger`. Transparency is a feature — the meter is auditable, like everything else.

### Open-core boundary (what's free vs paid)
- **Free / MIT:** the backbone — RoutingPacket contract, APEX router, KNOLL laws, ledger,
  topology, gateway, provider seam, self-host. This *is* the standard-setting play (MOAT #1).
- **Paid / operated:** managed Kafka+GPU fleet, learned KNOLL, multi-tenancy, marketplace
  revenue share, compliance certification, support/SLA.

---

## 4. Soft-launch plan (private beta)

Goal of the soft launch: **10 design partners** using the governed gateway on real (even if
small) workloads, producing quotes, a cost benchmark, and a red-team credential — *not* a
big splashy public launch. We earn credibility before we earn reach.

### 4.1 Private beta waitlist
- **Mechanism:** the marketing page's "Start free / Talk to sales" CTAs. Start-free → the
  GitHub repo (self-host today). Talk-to-sales → `hello@hdvfoundation.dev` (swap for a real
  inbox/form). Add a lightweight waitlist form (Tally/Typeform) capturing: role, vertical,
  current agent stack, the blocked pilot, deploy preference (managed / self-host / BYOK).
- **Qualify for:** regulated vertical OR security-first posture OR explicit on-prem/BYOK need.
- **Gate access:** invite in cohorts of ~3–4 so support stays high-touch.
- **Instrument:** UTM on every CTA; track waitlist → activated (gateway running) → retained
  (second week of traffic).

### 4.2 Demo video script outline (3–4 min, honest)
> Recorded against the real gateway + demos, no mockups. Screen + voiceover.

1. **Hook (0:00–0:20):** "Every team wants agents. Every security team is terrified of them.
   Here's why." Show a one-line intent hitting `POST /v1/intent`.
2. **The problem (0:20–0:50):** frameworks *advise* separation of concerns. Show a prompt
   telling an agent "don't do X" — and note it's a suggestion, not a guarantee.
3. **The constitution (0:50–1:40):** the Big 5, each with one job and hard limits. Live:
   `npm run demo` — a legal `HOPE → APEX → KNOLL → DREAM` route succeeds and is **billed**;
   an illegal `DREAM → VISION` is **BLOCKED** with an audit row; a **tampered hash** is
   **BLOCKED**. "This is enforced by the router and the guard, not a system prompt."
4. **Idle-cheap (1:40–2:20):** `GET /v1/matrix/stats` — 20,480 nodes, conceptual capacity,
   and the **active** parameter snapshot near zero at rest. "You pay for what lights up:
   active-param-seconds. Say the number honestly — it's capacity, not trained weights."
5. **Deploy anywhere (2:20–3:00):** `deploy/HOSTINGER.md` — one KVM4, Node 22, reverse proxy,
   optional local Ollama so no key leaves the box. BYOK vs platform keys.
6. **Close (3:00–3:30):** the three CTAs — Start free (repo), BYOK, Talk to sales. "Governed,
   auditable, idle-cheap. Ship agents your compliance team will actually approve."

> Recording checklist: use `npm run demo`, `npm run demo:phase4`, `npm run gateway` +
> `curl` for `/v1/health`, `/v1/matrix/stats`, `/v1/ledger`, `/v1/audit`. Keep every number
> traceable to a command on screen.

### 4.3 First 10 design partners
- **Sourcing:** warm intros in the primary verticals; founder-led outreach to platform/security
  leaders; the two or three strongest inbound waitlist fits.
- **The offer:** free Pro-equivalent access during beta + hands-on setup, in exchange for
  (a) a real workload, (b) a 30-min feedback call every 2 weeks, (c) permission to use anonymized
  usage in a cost benchmark, and (d) a logo/quote if they're happy.
- **Definition of a good partner:** has a *blocked or nervous* agent initiative today, can name
  the compliance/security objection, and can deploy within their own boundary (self-host/BYOK).
- **Success metric per partner:** one governed workflow live end-to-end, with a ledger they
  trust and at least one KNOLL block they *wanted* to happen.
- **What we harvest:** 3 case-study quotes, 1 public cost benchmark ($/intent vs. always-on
  monolith on bursty traffic), 1 red-team report (attempts to make HOPE execute / DREAM reach
  VISION / forge a KNOLL token — all blocked). These become the public-launch assets.

---

## 5. Launch checklist — next 14 days

Two-week sprint to get HDV **marketable ASAP**: a live page, a working self-host path, a demo,
and the first design-partner conversations. (No calendar-day promises — this is the ordered
dependency list; parallelize where the team allows.)

### Track A — Product surface (make it real to click)
- [ ] Publish `marketing/index.html` (host on the apex domain via Caddy/nginx; see
      `deploy/Caddyfile` commented block). Verify mobile + desktop + reduced-motion.
- [ ] Wire real CTAs: Start free → repo; BYOK → deploy guide; Talk to sales → real inbox/form.
- [ ] Stand up a waitlist form and attach it to the CTAs (UTM-tagged).
- [ ] Point `api.<domain>` at a KVM4 running the gateway (auth ON, CORS locked to the site) —
      follow `deploy/HOSTINGER.md` end to end and complete its §10 post-deploy checklist.
- [ ] Smoke test from a clean machine: `/v1/health` public, `/v1/matrix/stats` 401→200 with key.

### Track B — Proof & content (earn the click)
- [ ] Record the 3–4 min demo video (script §4.2) against the real gateway/demos.
- [ ] Draft the red-team blog post outline (constitution → attempts → all blocked).
- [ ] One-page "honest math" explainer (reuse the landing page's honesty callout + `MOAT.md` §2).
- [ ] Tighten the repo README's first screen for first-time visitors arriving from the page.

### Track C — Pipeline (start conversations)
- [ ] Build a 20–30 name target list across the primary verticals (name the blocked pilot each).
- [ ] Founder-led outreach to the top 10; book intro calls.
- [ ] Prep the design-partner agreement (the §4.3 offer, one page).
- [ ] Set up basic analytics (page → waitlist → activation → retention) and a simple CRM/sheet.

### Track D — Positioning hygiene (don't undermine the moat)
- [ ] Audit every public sentence for the honest-claim rules (§1). Kill any bare "14.3Q weights."
- [ ] Ensure `docs/GTM.md`, `MOAT.md`, and the landing page tell the *same* number the same way.
- [ ] Confirm pricing footnotes define APS and mark tiers as an early sketch.

**Exit criteria for the 14-day sprint:** a live, honest marketing page linked to a real
self-hostable gateway; a recorded demo; a waitlist collecting qualified leads; and at least
3 design-partner intro calls booked.

---

## 6. Messaging guardrails (for everyone who writes copy)

1. **Say the number honestly, every time.** Conceptual capacity ≠ trained weights. If a
   sentence could make an engineer ask "show me the weights," fix it.
2. **Lead with governance and cost, not raw intelligence.** We win on the layer *around* the
   model, and on idle-cheap unit economics.
3. **Enforced, not advised.** The word that separates us from frameworks is *enforced*.
4. **Auditable is a verb.** Every claim should map to a command, a ledger row, or an audit
   entry the buyer can run themselves.
5. **BYOK is a feature, not a discount.** It's the trust posture for security-first buyers:
   your keys and data never touch our infra.


---

## Product end-state (user-facing)

What HDV becomes for every customer:

1. **Pick your scale** — choose a parameter allowance (or a specific model from the catalog: local TinyLlama/Phi/Mistral-7B, Hostinger-hosted 8B/70B, or cloud).
2. **Pick your money path** — **Subscribe** (platform keys on HDV Hostinger/local fleet) or **BYOK** (bring OpenAI-compatible keys; HDV platform fee $0, you pay your provider).
3. **See every dollar and every occurrence** — live usage, active-param-seconds, cost estimates, hard caps that refuse overspend.
4. **Plug in anywhere** — HTTP gateway **or** MCP server (`hdv_intent`, `hdv_estimate_cost`, `hdv_usage`, `hdv_models`, `hdv_health`) for Cursor/Claude/any agent host.
5. **Infinitely scalable shape** — always-on Hope/Knoll/Apex are tiny; Dream/Vision workers scale horizontally (Colab, KVM4, K8s) and idle to ~zero.

Marketing can start **now** on the governance + metering story; real Hostinger/Ollama inference is the first production slice behind the same seams.
