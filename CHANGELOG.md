# Changelog

All notable changes to **HDV_Foundation** (the Big 5 Agent Matrix — Hope · Dream · Vision ·
KNOLL · APEX) are documented here for public readers.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0.0
minor versions track the project's build **phases**; the constitution
([`.cursorrules`](./.cursorrules)) and the `RoutingPacket` contract are load-bearing and every
release below is **additive** — new capability slots behind existing seams and never weakens the
six security laws.

> **What "release" means here.** These are development milestones of an open, self-hostable
> prototype. The routing laws, metering math, gateway, and marketing funnel are real and tested
> today; heavy GPU inference is still simulated behind stable seams (see
> [`docs/PROTOTYPE.md`](./docs/PROTOTYPE.md) and
> [`docs/PHASES_5_8_STATUS.md`](./docs/PHASES_5_8_STATUS.md) for the honest real-vs-stub ledger).

## [Unreleased]

### Added

- **CI quality gate.** `.github/workflows/ci.yml` now runs `npm run eval:board` (must PASS — the
  board exits non-zero on any escaped governance violation or blocked legal packet) and
  `npm run smoke` after the test suite, so every push/PR proves the real APEX→KNOLL gate and the
  gateway's public handlers, not just unit tests.
- **Release workflow.** `.github/workflows/release.yml` — an optional, idempotent workflow that
  fires only on a pushed `v*` tag. It re-runs the full `npm run ci` gate on the tagged commit,
  then creates a GitHub Release **only if one does not already exist** for the tag (re-pushing or
  re-running a tag creates nothing and never clobbers an existing release).
- **This changelog.**

### Changed

- `npm run ci` now includes `eval:board` + `smoke` so the local gate matches CI exactly
  (`db:generate → typecheck → test → eval:board → smoke`).

## [0.9.0] — 2026-07-24 — Phase 8 foundations (platform)

Multi-tenant platform foundations, all additive and tested.

### Added

- **Tenancy in the packet.** Optional `header.tenantId` on `RoutingPacket` and a new KNOLL
  **LAW 7 `NO_CROSS_TENANT`** that denies cross-tenant traffic (no-ops in single-tenant/dev
  mode). The field is folded into the tamper hash only when present, so every prior tenant-less
  packet remains byte-identical and valid.
- **Typed SDK + OpenAPI.** `packages/sdk/` ships a fetch-based `HdvClient` (zero agent imports)
  for `/v1/intent`, `/v1/health`, `/v1/metrics`, `/v1/billing/*`, and `/v1/waitlist`, documented
  by `docs/openapi.yaml`.
- **Audit hash-chain.** `knoll/hashchain.ts` — an append-only Merkle/hash-chain over the
  `SecurityAudit` log; any edit, reorder, or deletion is detectable.
- **Signed tool marketplace.** `marketplace/` — `SignedToolManifest` + Ed25519/HMAC verification
  and a registry VISION can `list()`, with a hard anti-escalation gate (no create/govern/route).
- **Live HOPE app.** `hope/app/` — a self-contained HTML+JS console that talks **only** to the
  gateway `/v1`, importing zero agent internals.

## [0.8.0] — 2026-07-23 — Phases 6–7 foundations (scale & learn)

Fleet-scaling and learning seams, offline-tested; live cluster/GPU remains an ops task.

### Added

- **Scale substrate.** `deploy/k8s/` (always-on trio Deployments + worker Jobs) and
  `deploy/keda/` (`ScaledJob` scale-to-zero on Kafka lag), plus node-slice leasing
  (`nodes/lease.ts`, no double-claim, TTL + fencing tokens).
- **Model serving seam.** `serving/vllm_client.ts` (OpenAI-compatible, offline mock) and
  `serving/persona_adapters.ts` (persona = cheap LoRA/prompt/sampling delta over a shared base).
- **Truthful parameter accounting.** `nodes/parameters.ts` gains a base-resident vs per-persona
  delta split so the honest active footprint reconciles with the conceptual 14.3Q figure.
- **Learned behavioral scorer.** `knoll/scoring_learned.ts` — a pure-TS logistic-regression
  scorer trained from audit exports, wired **after** the hard laws (shadow or enforce, default
  off, additive-only — it can deny more but never override a hard-law block).
- **Persona specialization & memory.** Typed `PersonaSpecialization` + `SpecialtyRouter`
  (`nodes/specialization.ts`) and tenant-isolated intent memory (`hope/memory.ts`).

## [0.7.0] — 2026-07-23 — Prototype & launch polish

### Added

- **One-command prototype.** `scripts/prototype.sh` (`npm run prototype`) boots and live-verifies
  the whole marketable stack over HTTP; `--ci` boots, verifies, and exits.
- **Master launch plan** (`docs/MASTER_PLAN.md`) and founder quick-list
  (`docs/FOUNDER_ACTIONS.md`).

### Changed

- **Honest marketing math** across `marketing/` and `docs/` (active-parameter-second pricing;
  conceptual vs. real compute stated plainly — no fake 14.3Q "weights" claim).

## [0.6.0] — 2026-07-23 — Phase 5 real slice + eval board

### Added

- **Public eval board.** `eval/run_board.ts` (`npm run eval:board`) scores five headline metrics
  — governance-violation rate, KNOLL block rate, p50/p95 latency, cost per active-param-second,
  routing-success rate — against the **real** APEX→KNOLL gate, emitting an HTML + JSON report and
  exiting non-zero if the gate fails.
- **Real Phase 5 adapters (skip-gracefully).** `KafkaTaskQueue` (`persistence/kafka_real.ts`),
  Prisma/Postgres wiring in `gateway/cli.ts` (hydrate on boot, flush/close on shutdown), a gVisor
  VISION sandbox adapter (`vision/sandbox_gvisor.ts`), and a production worker job
  (`colab/worker_job.py` + `deploy/Dockerfile.worker`) — each defaults to the offline/in-memory
  path and skips cleanly when the real infra is absent.
- **`scripts/phase5_slice.sh`** (`npm run phase5:slice`) — one command that runs the slice with
  Docker (Postgres + Kafka) or fully offline.

## [0.5.0] — 2026-07-23 — Product surface

### Added

- **Metered billing.** `billing/` + `config/pricing.json` — active-parameter-second pricing
  across five tiers (`FREE · STARTER · PRO · ENTERPRISE · BYOK`), per-tenant allowances with hard
  caps, and public `/v1/billing/*` gateway routes.
- **BYOK tenancy.** `tenancy/` and `providers/` — bring-your-own-key model routing with key
  redaction and a $0 platform fee for BYOK.
- **MCP server.** `mcp/` — drive the matrix from Cursor or any MCP client
  (`hdv_intent`, `hdv_estimate_cost`, `hdv_health`, `hdv_models`, `hdv_usage`); see
  [`docs/MCP.md`](./docs/MCP.md).
- **Deploy runbooks + GTM.** `deploy/` (Hostinger VPS, systemd, Docker, Caddy/nginx, Ollama) and
  go-to-market docs (`docs/GTM.md`, `docs/LAUNCH_CHECKLIST.md`, `docs/MESSAGING.md`).

## [0.4.0] — 2026-07-23 — Phase 5 foundations

### Added

- **Continuous integration** (`.github/workflows/ci.yml`) and an advisory security workflow
  (`.github/workflows/security.yml`).
- **Observability** (`observability/`) — a strictly out-of-band `MetricsCollector` +
  `PacketTracer` on a read-only dispatch-observer seam; served at `/v1/metrics`
  (JSON + Prometheus text). It only meters what already happened; it never routes or gates.
- **Pluggable LLM providers** and the Phases 5–8 `docs/ROADMAP.md`.

## [0.3.0] — 2026-07-23 — Phase 4 (forward-facing presence & scaling foundations)

### Added

- **HOPE HTTP gateway** (`gateway/`, zero-framework `node:http`): `/v1/intent`, `/v1/health`,
  `/v1/ledger`, `/v1/audit`, `/v1/matrix/stats`. Every routed packet is still KNOLL-gated.
- **Gateway hardening (4.1).** Optional API-key auth, per-IP rate limiting, CORS, and request
  logging — all env-configurable, with `/v1/health` always public.
- **Parameter accounting** (`nodes/parameters.ts` + `personamatrix/parameters.py`) — the
  conceptual ~14.3-quadrillion figure computed with an ACTIVE snapshot (idle personas ≈ $0).
- **Async intake** — a Kafka-like partitioned task queue with consumer groups
  (`persistence/kafka_stub.ts`) feeding an optional `ApexOrchestrator` intake through the same
  KNOLL gate.
- **Horizontal Colab worker protocol** (`colab/worker_protocol.py`,
  `colab/05_horizontal_worker.py`) and a **real GPU/7B model hook**
  (`personamatrix/model_backend.py`, `colab/06_gpu_model_hooks.py`) that skips to a deterministic
  stub off-GPU.
- **VISION sandbox expansion (4.2).** Hermetic `http_fetch` (allowlisted, mocked) and safe
  `json_transform`, a per-session resource monitor + tool audit, a concurrent-session limit, and
  timeout kill.
- **DREAM stream-energy scheduling (4.2)** (`dream/energy.ts`, `dream/scenario_bank.ts`) and a
  **HOPE console** (`hope/ui/`).
- **Prisma/Postgres backend** behind the repository interfaces (in-memory stays the default).

## [0.2.0] — 2026-07-23 — Phase 2/3 (depth in every agent)

### Added

- **HOPE** interpret + document + voice: entities, goals, constraints, urgency, clarification on
  low confidence, and an `IntentArchive`.
- **DREAM** multi-branch outcome trees with Pareto ranking and a scheduler.
- **VISION** sandboxed tool registry with billable execution reports.
- **KNOLL** additive behavioral-anomaly scoring (`BEHAVIORAL_SCORE`) layered on top of the six
  hard laws.
- **Persistence** repository interfaces with in-memory and Prisma implementations mirroring the
  ledger, audit trail, and intent archive.
- **personamatrix** behavioral-scoring twin and Colab notebooks `03` (scoring) + `04`
  (ipywidgets).

## [0.1.0] — 2026-07-23 — Phase 1 (the backbone)

### Added

- **The constitution** (`.cursorrules`) and the tamper-evident `RoutingPacket` contract
  (SHA-256 integrity + `knoll_token`) — the single, enforced inter-agent interface.
- **APEX** master router (`dispatch`) with a billing ledger; no peer agent imports another peer.
- **KNOLL** six virtual laws with monitor-only interception; blocks illegal direct
  `DREAM → VISION` hand-offs and any packet with a tampered hash.
- **HOPE / DREAM / VISION** first implementations (interpret / simulate / sandboxed execute).
- **20,480-node topology** with lifecycle + persona pipeline and the 14.3Q parameter model.
- First end-to-end demos (`npm run demo`) and the automated test backbone (`npm test`).

[Unreleased]: https://github.com/joeholloway445-maker/HDV_Foundation/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/joeholloway445-maker/HDV_Foundation/releases/tag/v0.9.0
[0.8.0]: https://github.com/joeholloway445-maker/HDV_Foundation/releases/tag/v0.8.0
[0.7.0]: https://github.com/joeholloway445-maker/HDV_Foundation/releases/tag/v0.7.0
[0.6.0]: https://github.com/joeholloway445-maker/HDV_Foundation/releases/tag/v0.6.0
[0.5.0]: https://github.com/joeholloway445-maker/HDV_Foundation/releases/tag/v0.5.0
[0.4.0]: https://github.com/joeholloway445-maker/HDV_Foundation/releases/tag/v0.4.0
[0.3.0]: https://github.com/joeholloway445-maker/HDV_Foundation/releases/tag/v0.3.0
[0.2.0]: https://github.com/joeholloway445-maker/HDV_Foundation/releases/tag/v0.2.0
[0.1.0]: https://github.com/joeholloway445-maker/HDV_Foundation/releases/tag/v0.1.0
