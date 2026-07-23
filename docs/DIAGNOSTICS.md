# HDV FOUNDATION — SYSTEM DIAGNOSTICS

> Operator's manual for proving the system is healthy. This document is two things at once:
>
> 1. **A repeatable diagnostics template** — the exact commands to run, what each one proves,
>    and the pass/fail criteria (§2–§6).
> 2. **A captured known-good baseline** — the actual outputs observed on a clean checkout, so
>    a future run has a reference to diff against (§7).
>
> Binding rules live in [`../.cursorrules`](../.cursorrules). The narrative plan is
> [`GAME_PLAN.md`](./GAME_PLAN.md); the forward path is [`ROADMAP.md`](./ROADMAP.md).

---

## 1. Environment fingerprint

Record this first — most "it broke" reports are environment drift.

| Component | Required | Baseline observed | How to check |
|-----------|----------|-------------------|--------------|
| Node.js   | ≥ 20 (dev on 22) | `v22.14.0` | `node -v` |
| Python    | ≥ 3.10 (stdlib only) | `3.12.3` | `python3 --version` |
| npm deps  | installed | `prisma`, `@prisma/client`, `tsx`, `typescript`, `@types/node` | `npm ls --depth=0` |
| Postgres  | optional | not required for green suite | `docker compose ps` |
| OS        | any POSIX | linux 6.12 | `uname -a` |

> **Baseline note.** Everything below is green with the **standard library + npm devDeps only**.
> No database, no GPU, no network. The single skipped test is the Postgres-only path (§4).

---

## 2. Fast path — one-shot health gate

Run these three in order. If all three pass, the backbone is sound.

```bash
npm run typecheck     # (A) types — MUST be zero errors
npm test              # (B) full suite — 127 pass / 1 skip / 0 fail
npm run demo          # (C) live backbone — ALLOWED:3 BLOCKED:2
```

Pass criteria:

- **(A)** exits `0`, prints nothing after the tsc banner (no diagnostics).
- **(B)** ends with `# pass 127`, `# fail 0`, `# skipped 1`.
- **(C)** ends with `DEMO COMPLETE — APEX+KNOLL gate enforced; DREAM<->VISION direct blocked.`

If any fail, jump to §6 (triage) before going further.

---

## 3. Full diagnostics matrix

Each row is an independent probe. Run the whole column to certify a release.

| # | Probe | Command | Proves | Pass signal |
|---|-------|---------|--------|-------------|
| D1 | Types | `npm run typecheck` | Strict TS, no `any` leaks | exit 0, no output |
| D2 | Unit/integration | `npm test` | All invariants under test | `pass 127 / fail 0 / skipped 1` |
| D3 | Backbone demo | `npm run demo` | Routing + KNOLL block + tamper block | `ALLOWED: 3  BLOCKED: 2` |
| D4 | Phase 2/3 demo | `npm run demo:phase2` | HOPE docs, DREAM trees, VISION tools, scoring | `PHASE 2/3 DEMO COMPLETE` |
| D5 | Phase 4 demo | `npm run demo:phase4` | Queue intake · worker re-ingest · params · health | `Ledger entries: 5 · total billed: $0.080000` |
| D6 | VISION sandbox | `npm run demo:vision` | http_fetch stub, timeout kill, session caps, audit | demo completes, exit 0 |
| D7 | DREAM energy | `npm run demo:dream-energy` | Stream-energy scheduling (accumulate/decay) | demo completes, exit 0 |
| D8 | HOPE UI render | `npm run demo:hope-ui` | Standalone brand HTML emitted | writes `/tmp/hope-console.html` |
| D9 | Gateway auth | `npm run demo:gateway-auth` | 401 → 200 → 429, public health | scripted walkthrough passes |
| D10 | Python persona loop | `npm run python:demo` | Persona loop + billing ledger | `RESULT: PASS` |
| D11 | Python scoring twin | `npm run python:scoring` | Behavioral scorer parity | `RESULT: PASS` |
| D12 | Python worker | `npm run python:worker` | Ephemeral claim→run→report→terminate | `RESULT: PASS` |
| D13 | Python GPU hook | `npm run python:gpu-hook` | Stub runs; transformers skips gracefully | `RESULT: PASS` |
| D14 | Python model backend | `npm run python:test-backend` | Backend seam (stub always) | `9 passed, 0 failed` |
| D15 | Gateway liveness | `npm run gateway` then `curl :8787/v1/health` | Always-on core answers | `200` JSON health body |

> `npm run gateway` is long-running; start it in a tmux/background session, probe, then stop it.
> It is the only probe here that binds a port. Everything else is self-contained and exits.

---

## 4. Optional / conditional probes (Postgres, GPU)

These are **expected to skip** on a bare checkout — that is a pass, not a failure.

| Probe | Command | Bare-checkout behavior | Full behavior (deps present) |
|-------|---------|------------------------|------------------------------|
| Prisma/Postgres | `npm test` (`tests/persistence_prisma.test.ts`) | **skips** without `DATABASE_URL` | runs against `postgres:16` once `docker compose up -d` + `db:push` |
| Real 7B model | `npm run python:gpu-hook` | stub only, prints install hints | drives `transformers` on a CUDA runtime |

To exercise the Postgres path:

```bash
cp .env.example .env
docker compose up -d
npm run db:generate && npm run db:push
npm test               # the 1 skipped test now runs
```

---

## 5. Invariant checks (the constitution, as assertions)

These are the rules that must **never** regress. Every one is covered by a probe above; this
table maps rule → where it is proven, so a reviewer can audit coverage.

| Invariant (`.cursorrules`) | Proven by | Failure looks like |
|----------------------------|-----------|--------------------|
| §2.2 All traffic `SOURCE → APEX → KNOLL → DEST` | D2, D3 | a route with no audit row |
| §2.3 DREAM↔VISION never direct | D2, D3, D5 | a `BLOCKED` that becomes `ALLOWED` |
| §2.4 APEX calls KNOLL before every route | D2, D3 | ledger row with no matching audit |
| §2.5 No peer imports another peer module | D1 + review | a peer `import` in a peer dir |
| §2.6 Every ephemeral exec billed | D2, D5, D10 | execution with no ledger row |
| §2.7 KNOLL never mutates to pass | D2 | payload hash changes across gate |
| §3 RoutingPacket hash integrity | D2, D3 | tampered packet routes anyway |
| §4 Topology math = 14.3Q | D5, D10 | `computeParameterAccounting()` ≠ `1.4336e16` |

Quick structural check for §2.5 (no peer-to-peer imports) — should return **no matches**:

```bash
# each peer dir must not import a sibling peer dir
grep -rnE "from ['\"](\.\.?/)+(dream|vision|hope|knoll)/" apex hope dream vision knoll \
  | grep -vE "/(index|types)\.ts" || echo "OK: no illegal peer imports"
```

---

## 6. Triage decision tree

- **D1 (typecheck) fails** → a type/interface drifted. Fix types first; a red D1 invalidates
  every other probe. Never suppress with `any` (violates `.cursorrules §5`).
- **D2 fails, D1 green** → read the first failing subtest name; each test is named after the
  invariant it guards (see §5). A newly-`BLOCKED`→`ALLOWED` flip is a security regression: stop.
- **D2 skip count ≠ 1** → either Postgres deps leaked in (skip→run is fine) or a test was
  silently disabled (bad). Confirm the skip is only `persistence_prisma`.
- **D3–D9 fail, D2 green** → demo wiring/composition-root drift, not core logic. Compare the
  demo's tail line to §7.
- **D10–D14 fail** → Python drift. All are stdlib-only; a failure here usually means a Python
  version < 3.10 or an edited `personamatrix` twin diverging from the TS source of truth.
- **D15 fails** → port already bound (`PORT=9090 npm run gateway`) or the composition root
  can't construct the always-on core.

---

## 7. Known-good baseline (captured reference)

Captured on a clean checkout, `node v22.14.0` / `python 3.12.3`, no DB, no GPU, no network.
Diff future runs against these anchors.

> **On the pass count.** The absolute test total grows as new phases add tests (e.g. it was
> `128` when this backbone snapshot was first taken). Treat the *counts* as a point-in-time
> anchor; the **durable** criteria are the ones that must never regress: `# fail 0`, and
> `# skipped` accounted for entirely by the Postgres-only `persistence_prisma` path (§4).

### D1 — typecheck

```
> tsc -p tsconfig.json --noEmit
(no diagnostics; exit 0)
```

### D2 — full test suite

```
1..128
# tests 128
# suites 0
# pass 127
# fail 0
# cancelled 0
# skipped 1     ← persistence_prisma (no DATABASE_URL); expected
# todo 0
```

### D3 — backbone demo

```
ALLOWED: 3
BLOCKED: 2
DEMO COMPLETE — APEX+KNOLL gate enforced; DREAM<->VISION direct blocked.
```

### D5 — Phase 4 demo

```
Queue drained: 1 · results delivered to HOPE: 2
Ledger entries: 5 · total billed: $0.080000
KNOLL audit: 5 (ALLOWED 4, BLOCKED 1)
Queue high-water APEX partition: 1
PHASE 4 DEMO COMPLETE — queue intake gated by KNOLL; DREAM↔VISION blocked; ephemeral workers re-ingested via APEX.
```

### D10 — Python persona loop + ledger

```
[3] APEX ledger billing
    SUCCESS rows: 1  BLOCKED rows: 1
    total billed: $0.010050 USD
RESULT: PASS -- persona loop and ledger verified.
```

### D11 — Python behavioral scoring twin

```
offense 3: score=0.7215 reputation(APEX)=0.75
BEHAVIORAL SCORING VALIDATION COMPLETE -- benign allowed, anomaly denied.
RESULT: PASS
```

### D12 — Python ephemeral worker

```
[worker …] claimed DREAM slice (1 node(s), gpu=T4)
[worker …] ran 50 personas · avg=0.4081 · active params=3.500e+11
[worker …] report ready for APEX: DREAM -> HOPE intent='worker-result:simulate'
[worker …] self-terminating (ephemeral).
RESULT: PASS -- ephemeral worker claimed, ran, reported via APEX, self-terminated.
```

### D14 — Python model backend seam

```
PASS  test_transformers_backend_optional
RESULT: PASS -- 9 passed, 0 failed
```

### Parameter accounting anchor (from D5 / `nodes/parameters.ts`)

```
TOTAL_NODES        = 20,480
PERSONAS_PER_NODE  = 100
TOTAL_PERSONAS     = 2,048,000
MODEL_PARAMS       = 7,000,000,000   (7B, CONCEPTUAL)
TOTAL_CONCEPTUAL_PARAMETERS = 1.4336e16   (~14.3 quadrillion)
ACTIVE parameters  = live_personas × 7B   (idle ≈ 0 compute)
```

> **Honesty marker.** The 14.3Q figure is a **conceptual capacity**, computed (not asserted)
> from topology × model size. It is not 14.3Q trained weights. ACTIVE parameters — the only
> ones that cost GPU — track live personas. See [`MOAT.md`](./MOAT.md) §"Honest accounting".

---

## 8. Release checklist (copy per release)

```
[ ] Environment fingerprint recorded (§1)
[ ] D1 typecheck ....... exit 0, no diagnostics
[ ] D2 tests .......... 127 pass / 1 skip / 0 fail
[ ] D3 backbone ....... ALLOWED:3 BLOCKED:2
[ ] D4 phase2 ......... COMPLETE
[ ] D5 phase4 ......... ledger $0.080000
[ ] D6 vision ......... COMPLETE
[ ] D7 dream-energy ... COMPLETE
[ ] D8 hope-ui ........ HTML written
[ ] D9 gateway-auth ... 401→200→429 walkthrough
[ ] D10–D14 python .... all PASS
[ ] D15 gateway ....... /v1/health 200
[ ] §5 invariants ..... no peer imports; no ALLOWED/BLOCKED flips
[ ] Baseline (§7) ..... diffed, no unexplained drift
```
