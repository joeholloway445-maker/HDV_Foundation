# HDV Foundation — 60-Second Demo (shot list + script)

> A single 60-second cut for the top of the landing page and cold outreach. It **opens on
> 14.3 quadrillion**, shows the **all-legs-firing** diagram, then proves the claim with live
> **governance → billing → BYOK** footage. Every number on screen maps to a command or a source
> file. No mockups; record against the real gateway/demos.
>
> Companion assets: [`math.md`](./math.md) (the numbers), [`comparison.ts`](./comparison.ts)
> (run it on screen), [`index.html`](./index.html) (the page), [`../docs/GTM.md`](../docs/GTM.md)
> (the longer 3–4 min cut).

**Format:** 1920×1080, 30fps · screen-record + voiceover · captions burned in · dark theme to
match the page · one accent motion per beat (no clutter). Target run time **58–60s**.

---

## Beat sheet (six shots, ~60s)

### Shot 1 — THE NUMBER (0:00–0:10)
- **On screen:** Black. `14.3` scales up in Fraunces amber→aqua gradient (the page's `.mega`),
  then the word **quadrillion** slides in beside it. Subline fades: `20,480 nodes × 100 personas × 7B`.
- **Lower third:** `2,867× the parameter capacity of a ~5-trillion frontier class`.
- **VO:** *"Fourteen-point-three quadrillion parameters of addressable capacity. That's roughly
  two-thousand-eight-hundred-sixty-seven times a five-trillion-parameter frontier class —
  when all five legs fire."*
- **Motion:** number breathes once; aurora drifts behind. Nothing else moves.

### Shot 2 — ALL LEGS FIRING (0:10–0:22)
- **On screen:** The matrix diagram lights up leg by leg: **HOPE · APEX · KNOLL · DREAM · VISION**,
  each fanning into its 4,096-node grid (20,480 total) with personas sparking on.
- **Overlay callouts:** `always-on: HOPE · KNOLL · APEX` / `ephemeral: DREAM · VISION`.
- **VO:** *"Five specialized agents, each over a 4,096-node matrix. Only three stay always-on;
  Dream and Vision are ephemeral — they spawn, run, and terminate."*
- **Honesty caption (small, persistent):** *capacity = topology × 7B, not a single trained
  weight file.*

### Shot 3 — GOVERNANCE, ENFORCED (0:22–0:36)
- **On screen:** Terminal. Run `npm run demo`. Highlight three outcomes:
  1. Legal `HOPE → APEX → KNOLL → DREAM` route **SUCCEEDS** (green).
  2. Illegal `DREAM → VISION` is **BLOCKED** with a `SecurityAudit` row (red).
  3. A **tampered hash** is **BLOCKED** (red).
- **VO:** *"Every action is routed by APEX and gated by KNOLL. A legal route succeeds. Dream
  reaching Vision? Blocked. A tampered packet? Blocked. Enforced by code — not a system prompt."*
- **Motion:** each verdict stamps in with a quick check/cross.

### Shot 4 — BILLING, IDLE-CHEAP (0:36–0:48)
- **On screen:** `npm run gateway` → `curl GET /v1/matrix/stats` shows **conceptual 1.4336e16**
  vs **active params ≈ 0 at rest**. Then `GET /v1/ledger` shows a billed run in
  **active-param-seconds**.
- **Overlay:** the cost formula `E = (1 / utilization) × (R_on / R_eph)` with the worked
  chip `5% utilization → 400× cheaper` (from `math.md`).
- **VO:** *"You pay for what lights up — active-param-seconds, read straight from the ledger.
  At rest the fourteen-point-three quadrillion sits idle at near-zero cost. On bursty workloads
  that's tens to thousands of times cheaper than renting a monolith 24/7."*

### Shot 5 — BYOK / DEPLOY ANYWHERE (0:48–0:56)
- **On screen:** split card — **BYOK** (`OpenAI / Groq / Together / local Ollama · $0 inference
  meter`) and **Deploy** (`Hostinger KVM4 · Docker/systemd · fully local`).
- **VO:** *"Bring your own keys and your inference never touches our infra — we charge a flat
  governance fee. Self-host on a single KVM4, or run it fully offline."*

### Shot 6 — CLOSE (0:56–1:00)
- **On screen:** logo lockup `HDV Foundation — HOPE · The Governed Matrix`, three CTAs:
  **Start free · Bring your own keys · Talk to sales**. URL/QR.
- **VO:** *"Fourteen-point-three quadrillion. Governed, auditable, idle-cheap. HDV Foundation."*

---

## On-screen text (exact strings)

| Time | Text |
|------|------|
| 0:00 | `14.3 quadrillion` |
| 0:03 | `parameters of addressable capacity · 20,480 × 100 × 7B` |
| 0:05 | `2,867× a ~5-trillion frontier class — when all five legs fire` |
| 0:12 | `always-on: HOPE · KNOLL · APEX   |   ephemeral: DREAM · VISION` |
| 0:24 | `HOPE → APEX → KNOLL → DREAM   ✓ SUCCESS (billed)` |
| 0:28 | `DREAM → VISION   ✗ BLOCKED (audit row)` |
| 0:31 | `tampered hash   ✗ BLOCKED` |
| 0:38 | `conceptual 1.4336e16 · active ≈ 0 at rest` |
| 0:42 | `E = (1 / utilization) × (R_on / R_eph)   ·   5% → 400×` |
| 0:50 | `BYOK: $0 inference meter · Deploy: Hostinger / Docker / local` |
| 0:57 | `Start free · Bring your own keys · Talk to sales` |

---

## Recording checklist (keep every number traceable)

- [ ] `npx tsx marketing/comparison.ts` — capture the printed 2,867× / 12,380× and cost table.
- [ ] `npm run demo` — legal route SUCCESS, `DREAM→VISION` BLOCKED, tampered hash BLOCKED.
- [ ] `npm run gateway` + `curl` `/v1/health`, `/v1/matrix/stats`, `/v1/ledger`, `/v1/audit`.
- [ ] Confirm the honesty caption (topology × 7B, not trained weights) is visible in Shot 2.
- [ ] Lower thirds use the **2,867× vs 5T** primary figure; show 12,380× only labeled `vs ~1.16T`.

## Guardrails (do not violate — see `../docs/MESSAGING.md`)

- ✅ "14.3-quadrillion **conceptual capacity** — topology × 7B — when all five legs fire."
- ✅ "**2,867×** the parameter capacity of a ~5T frontier class." (Primary.)
- ❌ Never say "we trained 14.3 quadrillion weights."
- ❌ Never say "12,380× the frontier/Claude" (that ratio is only vs ~1.16T).
- ❌ Never show a bare cost multiple without the formula/labels on screen.
