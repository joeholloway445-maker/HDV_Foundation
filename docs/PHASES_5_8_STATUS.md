# PHASES 5–8 STATUS — what's real vs. stub

An honest, file-referenced ledger of where the Big 5 Matrix actually stands across Phases 5–8.
Companion to [`ROADMAP.md`](./ROADMAP.md) (the plan) and [`SCALE.md`](./SCALE.md) (Phase 6
build sheet). The rule from the constitution holds everywhere: **additive only** — new work
slots behind existing seams and never weakens the six laws.

> **North star:** always-on trio (HOPE · KNOLL · APEX) stays tiny; DREAM/VISION workers and the
> 20,480-node fleet are ephemeral and scale to **zero**. Metering is by **active**-parameter-
> seconds, so idle ≈ $0. Every claim below is measured, not asserted — run `npm run eval:board`.

## Legend

| Mark | Meaning |
| ---- | ------- |
| ✅ **real** | Implemented and tested; runs in the default offline suite. |
| 🟡 **partial / scaffold** | Real seam + working slice, but not production-grade or not wired end-to-end. |
| 🟥 **stub / contract-only** | Interface/protocol exists; implementation is simulated or skips gracefully. |
| ⬜ **planned** | Designed in the roadmap; not started. |

---

## Phase 5 — make one slice real (simulation → inference)

| Item | Status | Evidence / next step |
| ---- | ------ | -------------------- |
| Task queue (Kafka) | 🟡 | Interface + in-memory `InMemoryKafkaStub` real (`persistence/kafka_stub.ts`); `kafka_real.ts` + `docker-compose.yml` `kafka` service exist and **skip gracefully** without a broker. Next: default-on in prod. |
| Persistence (Postgres/Prisma) | 🟡 | Repository interfaces + Prisma impl real (`persistence/`, `config/schema.prisma`); default is in-memory. `persistence_prisma.test.ts` runs only when `DATABASE_URL` is set (1 skipped in bare CI). Next: flip Postgres default in prod. |
| VISION sandbox | 🟥 | Contract real; execution is a process-level stub (`vision/`). Next: gVisor/Firecracker. |
| DREAM/VISION GPU workers | 🟥 | Worker **protocol** real (`colab/worker_protocol.py`, `colab/05_horizontal_worker.py`); payloads simulated. Next: real 7B on one GPU. |
| Provider/model layer (BYOK) | ✅ | `providers/` (pure text providers, key redaction) + `tenancy/` (BYOK vs subscription, nearest-param routing) real and tested (`test:providers`, `test:tenancy`). |
| Product surface (gateway/billing) | ✅ | HOPE HTTP gateway (`gateway/`), metering by active-parameter-seconds (`billing/`, `config/pricing.json`), MCP server (`mcp/`) — all real and tested. |

**Phase 5 exit (one documented command spins up Kafka + Postgres + one GPU worker):** ⬜ not yet
— the pieces exist behind seams; the single end-to-end real slice is the remaining work.

---

## Phase 6 — scale the fleet (K8s · KEDA · vLLM · cost)

See [`SCALE.md`](./SCALE.md) for the concrete PR list. Nothing here is built yet.

| Item | Status | Evidence / next step |
| ---- | ------ | -------------------- |
| K8s manifests (always-on trio + worker Jobs) | ⬜ | Prod runbook + Dockerfile exist (`deploy/`); no Helm/Kustomize yet. PR `deploy/k8s`. |
| KEDA `ScaledJob` scale-to-zero on queue lag | ⬜ | Depends on Kafka lag (5.1). PR `deploy/keda`. **The literal "workers to zero" enforcement.** |
| Node-slice leasing (no double-claim) | ⬜ | Redis is in compose; lease not implemented. PR `nodes/lease`. |
| vLLM shared 7B + per-persona LoRA/prompt deltas | ⬜ | `model_backend` seam ready. PR `serving/vllm`, `serving/persona-adapters`. |
| Truthful active-vs-base param accounting | 🟡 | `nodes/parameters.ts` computes the conceptual ~1.4336e16 and an active figure; base-vs-delta split for shared serving is pending. See [`MOAT.md`](./MOAT.md). |
| Observability: metrics + tracing | 🟡 | `observability/metrics.ts` (Prometheus exposition) + `observability/trace.ts` (`PacketTracer`) real and tested via the read-only `DispatchObserver` seam; `/v1/metrics` served. OTel distributed traces ⬜. |
| Real cost ledger (GPU-seconds × $/s) | 🟥 | Ledger `cost_usd` field real; currently a constant/estimate. PR `apex/cost-real`. |
| Gateway hardening (Redis limiter, JWT, SSE, TLS) | 🟡 | Rate limiting + auth middleware exist (`gateway/`); shared Redis limiter, JWT tenancy, SSE streaming ⬜. TLS configs in `deploy/`. |

---

## Phase 7 — learn (the intelligence moat)

| Item | Status | Evidence / next step |
| ---- | ------ | -------------------- |
| Behavioral scorer (additive to the six laws) | 🟡 | `knoll/scoring.ts` + `knoll/features.ts` real: heuristic, weighted, **strictly additive** (can deny more, never allow past a hard law). Not learned. |
| Learned scorer (ONNX, shadow-mode) | ⬜ | Needs a labeled `SecurityAudit` export. PR `knoll/scoring-onnx`. |
| Persona specialization & routing (mixture-of-personas) | ⬜ | `personamatrix/` twin exists; typed specializations + learned router pending. |
| Memory: intent archive as context (pgvector) | ⬜ | `hope/` IntentArchive exists; vector index + tenant-isolated retrieval pending. |
| **Evaluation harness (`eval/`)** | 🟡 | **NEW — this deliverable.** `eval/run_board.ts` scores five headline metrics (governance_violation_rate, knoll_block_rate, p50/p95 latency, cost_per_active_param_second, routing_success_rate) against the **real** APEX→KNOLL gate; HTML+JSON report to `eval/out/`; `tests/eval.test.ts` green. Next: wire `npm run eval:board` as a CI quality gate and feed real run exports into `eval/fixtures/`. |

**Phase 7 exit (system improves on frozen benchmarks, security never weakened):** 🟡 the eval
board makes "world-class" **measurable**; learned components are the remaining work.

---

## Phase 8 — platform (multi-tenant product & ecosystem)

| Item | Status | Evidence / next step |
| ---- | ------ | -------------------- |
| Multi-tenancy & isolation (`NO_CROSS_TENANT`) | 🟡 | Model/plan tenancy real (`tenancy/`), per-tenant billing allowances real (`billing/`). Packet-level `tenant_id` header + KNOLL hard law + row-level security ⬜. |
| Public API + SDK (OpenAPI, typed client) | 🟡 | `/v1` gateway API real; MCP server real (`mcp/`). **Open-core surface NEW:** `packages/constitution/` publishes the `RoutingPacket` contract, `AgentRole`, KNOLL law names, ledger fields, and lifecycle map — the seam a typed SDK builds on. Generated OpenAPI SDK ⬜. |
| Tool & persona marketplace (signed manifests) | 🟥 | VISION tool registry exists with capability allowlists (`mcp/`, tests assert no create/govern escalation); signed third-party registry ⬜. |
| Security & compliance (hash-chain audit, SBOM, KMS) | 🟡 | Per-packet SHA-256 + `SecurityAudit` real; CI security workflow present (`.github/workflows/security.yml`). Merkle hash-chain over the audit log, KMS secrets, pen-test ⬜. |
| HOPE product surface (browser app, SSE) | 🟡 | `showcase/` + `marketing/` static pages + `hope/ui` real; a live front-end talking only to `/v1` (zero agent imports) ⬜. |

**Phase 8 exit (multi-tenant, documented, SDK-driven, audited platform):** 🟡 — the open-core
constitution kit and the eval gate are foundational; tenancy-in-packet, SDK generation, and the
signed marketplace remain.

---

## What this PR set adds (Phases 6–8 starter kits)

- ✅ **`eval/`** — public eval board scaffold (Phase 7.4): `run_board.ts`, `fixtures/sample.json`,
  HTML/JSON report, `tests/eval.test.ts`, `npm run eval:board`.
- ✅ **`packages/constitution/`** — open-core kit (Phase 8.2 precursor): publishable public
  surface re-exported from `config/` so the app never breaks and the kit never drifts.
- ✅ **`docs/SCALE.md`** — Phase 6 K8s/KEDA/vLLM build sheet with concrete next PRs.
- ✅ **`docs/PHASES_5_8_STATUS.md`** — this checklist.

None of it changes routing, KNOLL, the ledger, or the node fleet. It **measures** and
**publishes** the existing core — and keeps the "always-on-tiny / workers-to-zero" story honest.
