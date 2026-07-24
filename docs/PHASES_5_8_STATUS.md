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
| Task queue (Kafka) | 🟡 | **WIRED** — `persistence/kafka_real.ts` `KafkaTaskQueue` (real `kafkajs`, now a declared dep) implements the same `TaskQueue` as the in-memory stub; `createTaskQueue`/`resolveQueueMode`/`brokersFromEnv` exported from `persistence/index.ts`. `gateway/cli.ts` wires it into `ApexOrchestrator` and starts the intake consumer when `HDV_QUEUE=kafka`. Adapter tested offline via an injected fake broker; real-broker round-trip skips without `KAFKA_TEST_BROKERS` (`tests/phase5_queue.test.ts`). Default stays in-memory. Next: default-on in prod. |
| Persistence (Postgres/Prisma) | 🟡 | **WIRED** — Repository interfaces + Prisma impl real (`persistence/`, `config/schema.prisma`). `gateway/cli.ts` now uses `createRepositories('prisma')` when `DATABASE_URL` is set: it **hydrates** on boot and **flushes + closes** on SIGTERM/SIGINT; the ledger + KNOLL audit mirror to Postgres. Default is in-memory. `persistence_prisma.test.ts` runs only when `DATABASE_URL` is set (skipped in bare CI). Next: flip Postgres default in prod. |
| VISION sandbox | 🟡 | **REAL ADAPTER** — `vision/sandbox_gvisor.ts` `GvisorSandboxSession` implements the same `SandboxSession` API over gVisor (Docker `--runtime=runsc`, CPU/mem caps, `--network=none`, timeout kill). `isGvisorAvailable()` probes for `runsc`; `createSandboxSession('gvisor', …)` transparently **falls back to the stub** when it is absent. Real-runtime tests skip without `runsc` (`tests/vision_gvisor.test.ts`). Next: Firecracker option + real-runtime CI lane. |
| DREAM/VISION GPU workers | 🟡 | **PRODUCTION WORKER** — `colab/worker_job.py` + `deploy/Dockerfile.worker`: one-shot ephemeral worker loads a `WorkerManifest`, runs the persona batch through `personamatrix` with `TransformersBackend` **when torch/transformers are importable** (else the deterministic stub), and POSTs its `WorkerReport` to `GATEWAY_URL/v1/worker/report` (→ APEX → KNOLL → HOPE). Offline demo path prints the payload with zero infra. Tested offline (`tests/worker_job.test.ts`). Next: real 7B on one GPU. |
| Provider/model layer (BYOK) | ✅ | `providers/` (pure text providers, key redaction) + `tenancy/` (BYOK vs subscription, nearest-param routing) real and tested (`test:providers`, `test:tenancy`). |
| Product surface (gateway/billing) | ✅ | HOPE HTTP gateway (`gateway/`), metering by active-parameter-seconds (`billing/`, `config/pricing.json`), MCP server (`mcp/`) — all real and tested. |

**Phase 5 exit (one documented command spins up Kafka + Postgres + one GPU worker):** 🟡 —
`scripts/phase5_slice.sh` (`npm run phase5:slice`) is that command: with Docker it brings up
Postgres + Kafka, applies the Prisma schema, boots the gateway on the durable + Kafka-intake
paths, runs one ephemeral worker, and reads back the ledger + audit; with no Docker it prints a
clear fallback and runs the same slice fully offline (in-memory queue + persistence). A live GPU
worker (real 7B) is the remaining productionization.

---

## Phase 6 — scale the fleet (K8s · KEDA · vLLM · cost)

See [`SCALE.md`](./SCALE.md) for the concrete PR list. **Foundations landed** — manifests +
code seams are in place and offline-tested (`npm run test:phase6`); a live cluster/GPU is the
remaining productionization.

| Item | Status | Evidence / next step |
| ---- | ------ | -------------------- |
| K8s manifests (always-on trio + worker Jobs) | 🟡 | **NEW** `deploy/k8s/`: gateway `Deployment` (always-on, `minReplicas: 1` + HPA, never to 0), `Service` (ClusterIP), ConfigMap/Secret samples, worker `ServiceAccount`+`Role`/`RoleBinding`, `namespace.yaml`, `ingress.notes.md`. Render/apply against a real cluster is next. |
| KEDA `ScaledJob` scale-to-zero on queue lag | 🟡 | **NEW** `deploy/keda/`: `ScaledJob` per worker role (`dream`/`vision`) bound to Kafka lag on `hdv.routing.DREAM`/`.VISION` (the exact topics `KafkaTaskQueue.topicFor` produces), `minReplicaCount: 0`. **The literal "workers to zero" enforcement.** Load/chaos test on a cluster is next. |
| Node-slice leasing (no double-claim) | ✅ | **NEW** `nodes/lease.ts`: `NodeSliceLease` contract with `InMemoryNodeSliceLease` (injectable clock, TTL expiry, fencing tokens) + `RedisLeaseStub` (`SET NX PX` / compare-and-delete / `PEXPIRE`) over a minimal `RedisLike`. `claim`/`renew`/`release`, no double-claim, expiry re-open — all tested offline (`tests/phase6.test.ts`). |
| vLLM shared 7B + per-persona LoRA/prompt deltas | 🟡 | **NEW** `serving/`: `vllm_client.ts` (OpenAI-compatible `/v1/completions`, key-safe, `offlineVllmFetch()` mock) + `persona_adapters.ts` (persona = cheap `(LoRA, prompt, sampling)` delta over shared base; batch accounting). Runs offline in CI; wiring a real vLLM server is next. |
| Truthful active-vs-base param accounting | ✅ | `nodes/parameters.ts` now adds the base-vs-delta split for shared serving: `sharedBaseParams(replicas)` (7B once per replica), `deltaParamsPerPersona(rank)` (~8.4M LoRA delta), `activeCostParams`/`computeBaseVsDelta` (honest footprint that amortizes the naive per-persona figure). Conceptual ~1.4336e16 unchanged; both figures reconcile and are tested. See [`MOAT.md`](./MOAT.md). |
| Observability: metrics + tracing | 🟡 | `observability/metrics.ts` (Prometheus exposition) + `observability/trace.ts` (`PacketTracer`) real and tested via the read-only `DispatchObserver` seam; `/v1/metrics` served. OTel distributed traces ⬜. |
| Real cost ledger (GPU-seconds × $/s) | 🟡 | **NEW** `apex/cost.ts`: `GpuCostModel` = `gpuSeconds × ratePerSecond × (activeParams/1e9)`, clamps bad worker reports, optional `priceLogRequest(...)` wire into the ledger `LogRequestInput` path **without** changing `apex/ledger.ts` defaults (cost_usd still defaults to 0). Prices the honest `activeCostParams`. Wiring worker-reported GPU-seconds end-to-end is next. |
| Gateway hardening (Redis limiter, JWT, SSE, TLS) | 🟡 | Rate limiting + auth middleware exist (`gateway/`); shared Redis limiter, JWT tenancy, SSE streaming ⬜. TLS configs in `deploy/`. |

---

## Phase 7 — learn (the intelligence moat)

| Item | Status | Evidence / next step |
| ---- | ------ | -------------------- |
| Behavioral scorer (additive to the six laws) | ✅ | `knoll/scoring.ts` + `knoll/features.ts` real: heuristic, weighted, **strictly additive** (can deny more, never allow past a hard law). |
| Learned scorer (shadow-mode) | ✅ | **NEW.** `knoll/scoring_learned.ts` `LearnedBehavioralScorer` — pure-TS online logistic regression (no onnxruntime), trained from `exportAuditTrainingSet` over `SecurityAudit`-like packets. **shadow** (log only) vs **enforce** (additive deny). Wired into KNOLL AFTER laws + heuristic via `knoll/validator.ts` (`enableLearnedScoring`/`learnedScorer`), **default OFF**, **additive only** — it can raise a new deny but NEVER overrides a hard-law allow (`tests/phase7.test.ts`). Runs the real gate in `eval/fixtures/learned.json` (`npm run eval:board:learned`). Next: real `SecurityAudit` exports + threshold tuning. |
| Persona specialization & routing (mixture-of-personas) | ✅ | **NEW.** `nodes/specialization.ts` typed `PersonaSpecialization` (researcher\|writer\|critic\|coder\|analyst\|guardian) + `SpecialtyRouter` picking specialists for a task **under one Big AI** (never cross-agent; `guardian` is self-review, not governance). Python twin `personamatrix/specialization.py`. Next: learned (vs keyword) routing. |
| Memory: intent archive as context (pgvector) | ✅ | **NEW.** `hope/memory.ts` `IntentMemory` — deterministic hash-vector `embedIntent` stub, `remember`/`recall` by cosine similarity, **tenant-isolated** retrieval, `InMemoryVectorStore` default + contract-only `PgVectorStore` (pgvector DDL documented). Interpretation-only: **cannot execute** (no packet, no peer import). Next: wire a real embedding model + pgvector client. |
| **Evaluation harness (`eval/`)** | ✅ | `eval/run_board.ts` scores five headline metrics (governance_violation_rate, knoll_block_rate, p50/p95 latency, cost_per_active_param_second, routing_success_rate) against the **real** APEX→KNOLL gate; HTML+JSON report to `eval/out/`; `tests/eval.test.ts` green. Now also drives the **learned** scorer end-to-end (`eval/fixtures/learned.json`). Next: feed real run exports into `eval/fixtures/`. |

**Phase 7 exit (system improves on frozen benchmarks, security never weakened):** ✅ foundations
landed — learned scorer (shadow/enforce, additive-only), typed persona specialization + router,
and tenant-isolated intent memory, all measured by the eval board with the six laws never weakened.
Next: real labeled exports, a learned router, and a live embedding/pgvector backend.

---

## Phase 8 — platform (multi-tenant product & ecosystem)

| Item | Status | Evidence / next step |
| ---- | ------ | -------------------- |
| Multi-tenancy & isolation (`NO_CROSS_TENANT`) | ✅ | Model/plan tenancy real (`tenancy/`), per-tenant billing allowances real (`billing/`). **NEW:** additive packet-level `header.tenantId?` (`config/routing_schema.ts`, folded into the tamper hash only when present so Phase 1 packets are byte-identical), KNOLL **LAW 7 `NO_CROSS_TENANT`** (`knoll/laws.ts`) enforced via an optional `intercept(packet, context)` — denies when source-tenant ≠ packet-tenant, passes in dev/single-tenant mode. `createPacket` accepts `tenantId`; cross-tenant deny + backward-compat tested (`tests/phase8.test.ts`). Row-level DB security ⬜. |
| Public API + SDK (OpenAPI, typed client) | ✅ | `/v1` gateway API real; MCP server real (`mcp/`); `packages/constitution/` open-core surface. **NEW:** `packages/sdk/` — a typed, fetch-based `HdvClient` (zero agent imports) for `/v1/intent`, `/v1/health`, `/v1/metrics`, `/v1/billing/*`, `/v1/waitlist`; `docs/openapi.yaml` documents the main routes. Codegen from the yaml ⬜. |
| Tool & persona marketplace (signed manifests) | 🟡 | VISION tool registry exists with capability allowlists (`mcp/`). **NEW:** `marketplace/` — `SignedToolManifest` + `verifyEd25519`-or-HMAC (`marketplace/verify.ts`) + a `ToolMarketplaceRegistry` VISION can `list()`; registration hard-rejects capability escalation (no create/govern/route/gate/knoll) and bad signatures (`tests/phase8.test.ts`). Persona manifests + on-chain publishing ⬜. |
| Security & compliance (hash-chain audit, SBOM, KMS) | 🟡 | Per-packet SHA-256 + `SecurityAudit` real; CI security workflow present (`.github/workflows/security.yml`). **NEW:** `knoll/hashchain.ts` — an append-only Merkle/hash-chain over the audit log (`append`/`verify`/`detectTamper`); any edit, reorder, or deletion is detectable. KMS secrets, SBOM, pen-test ⬜. |
| HOPE product surface (browser app, SSE) | 🟡 | `showcase/` + `marketing/` static pages + `hope/ui` real. **NEW:** `hope/app/` — a live, self-contained HTML+JS console that talks **only** to the gateway `/v1` (intent form + polled `/v1/health` + `/v1/metrics`), zero agent imports (serve note in `hope/app/README.md`). SSE streaming endpoint (vs. poll) ⬜. |

**Phase 8 exit (multi-tenant, documented, SDK-driven, audited platform):** 🟡 → the foundations
are in: **tenancy-in-packet** with a hard KNOLL law, a **typed SDK + OpenAPI**, a **signed tool
marketplace** with anti-escalation, an **audit hash-chain**, and a **live `/v1`-only HOPE app**.
Remaining: row-level DB isolation, SDK codegen, persona manifests, KMS/SBOM, and SSE.

---

## What this PR set adds (Phases 6–8 starter kits)

- ✅ **`eval/`** — public eval board scaffold (Phase 7.4): `run_board.ts`, `fixtures/sample.json`,
  HTML/JSON report, `tests/eval.test.ts`, `npm run eval:board`.
- ✅ **`packages/constitution/`** — open-core kit (Phase 8.2 precursor): publishable public
  surface re-exported from `config/` so the app never breaks and the kit never drifts.
- ✅ **`docs/SCALE.md`** — Phase 6 K8s/KEDA/vLLM build sheet with concrete next PRs.
- ✅ **`docs/PHASES_5_8_STATUS.md`** — this checklist.

### Phase 8 foundations (this drop — all additive, all tested)

- ✅ **Tenancy-in-packet** — optional `header.tenantId?` + KNOLL **LAW 7 `NO_CROSS_TENANT`**.
  Additive by construction: the field is folded into the tamper hash *only when present*, so
  every existing Phase 1 (tenant-less) packet still validates and every prior test stays green.
- ✅ **`packages/sdk/`** — typed, fetch-based `HdvClient` (zero agent imports) + **`docs/openapi.yaml`**.
- ✅ **`knoll/hashchain.ts`** — Merkle/hash-chain over the `SecurityAudit` log (append/verify/detect-tamper).
- ✅ **`marketplace/`** — `SignedToolManifest` + Ed25519/HMAC verify + a registry VISION can `list()`,
  with a hard anti-escalation gate (no create/govern).
- ✅ **`hope/app/`** — a live HTML+JS console talking only to the gateway `/v1` (serve note in its README).
- ✅ **`tests/phase8.test.ts`** — cross-tenant deny + backward-compat + hash-chain + marketplace + SDK.

Routing, the ledger, and the node fleet are untouched; the six original laws are unchanged (LAW 7
only *adds* denials and no-ops in dev mode). `npm test` stays green.

---

## Status stamp (0.9.0)

**Phases 5–8 foundations are implemented in-repo** (331 tests pass). Live GPU/Kafka/K8s on Hostinger remain *ops* — code seams, manifests, workers, laws, SDK, hashchain, marketplace, learned scorer, leases, and KEDA YAMLs are in tree. Run `npm run phase5:slice` / `npm run prototype` / `npm run eval:board`.
