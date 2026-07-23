# HDV FOUNDATION — ROADMAP (Phases 5 → 8)

> The path from **today (Phase 4.2: a correct, fully-tested backbone with simulated compute)**
> to a **world-class, real-inference, horizontally-scaled agent platform**. This document is
> deliberately concrete: every step names the file/interface it touches, the acceptance test
> that proves it, and the invariant it must not break.
>
> **Ground rule that never bends:** every phase below is *additive*. The
> [`.cursorrules`](../.cursorrules) constitution and the `RoutingPacket` contract are load-bearing
> and take precedence over any feature here. If a step would let DREAM talk to VISION directly,
> or let anything bypass `KNOLL.intercept()`, the step is wrong — not the rule.
>
> Companion docs: [`GAME_PLAN.md`](./GAME_PLAN.md) (what exists), [`DIAGNOSTICS.md`](./DIAGNOSTICS.md)
> (how to prove health), [`MOAT.md`](./MOAT.md) (why this wins), [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 0. Where we are (honest starting line)

| Layer | Real today | Simulated / stubbed today | Made real in |
|-------|-----------|---------------------------|--------------|
| Routing / security / ledger | ✅ real, enforced, tested | — | (stays real) |
| RoutingPacket + SHA-256 integrity | ✅ real | — | (stays real) |
| Topology math (14.3Q conceptual) | ✅ computed | model weights are conceptual | Phase 5 (narrow real slice) |
| Task queue | interface real | `InMemoryKafkaStub` transport | Phase 5 (real Kafka) |
| Persistence | interfaces + Prisma impl real | in-memory default | Phase 5 (Postgres default in prod) |
| VISION sandbox | contract real | process-level stub | Phase 5 (gVisor/Firecracker) |
| DREAM/VISION workers | protocol real | payloads simulated | Phase 5 (real GPU 7B) |
| Behavioral scoring | real, rule+heuristic | not learned | Phase 7 (learned model) |
| Persona specialization | uniform personas | no routing/experts | Phase 7 |
| Multi-tenant product | single-tenant | no auth tenancy | Phase 8 |

The backbone is the asset. Phases 5–8 replace *simulated compute* with *real compute* behind
the **already-stable interfaces** — callers never change.

---

## Phase 5 — MAKE ONE SLICE REAL (from simulation to inference)

**Goal:** one end-to-end path that is 100% real — a natural-language intent enters via the
gateway, HOPE interprets, APEX routes (KNOLL-gated), a **real GPU DREAM worker** runs a **real
7B model** on a real persona batch, the result is re-ingested via APEX, and every row lands in
**real Postgres**. No new architecture — just swap stubs for real adapters behind existing seams.

**Definition of done:** `npm run demo:phase4` semantics, but the worker payload is produced by a
real model and persisted to Postgres, with `activeParameters` reported from actual GPU work.

### 5.1 Real Kafka behind `TaskQueue`
- **Touch:** `persistence/kafka_stub.ts` (migration notes already at file top), add
  `persistence/kafka_real.ts` implementing the same `TaskQueue` interface.
- **Steps:**
  1. Add `kafkajs` as a dependency. Create `KafkaTaskQueue implements TaskQueue`.
  2. `publish(role, packet)` → `producer.send({ topic: 'hdv.routing', messages: [{ key: role, value: serialize(packet) }] })`. Partition key = destination `AgentRole` (preserves ordering per agent).
  3. `subscribe(group, handler)` → `consumer.subscribe` + `consumer.run` with `eachMessage`; `ack` → offset commit; `nack` → seek back or route to `hdv.routing.dlq`.
  4. Add a **schema-registry step**: register the serialized `RoutingPacket` JSON schema; on consume, deserialize **then** call the existing `KNOLL.intercept()` — the queue never trusts the wire.
  5. Composition root: `createTaskQueue(kind)` factory (`'memory' | 'kafka'`) mirroring `createRepositories`.
- **docker-compose:** add a single-broker `bitnami/kafka` (KRaft mode, no ZooKeeper) with a healthcheck.
- **Acceptance:** the Phase 4 demo runs unchanged against `HDV_QUEUE=kafka`; consumer-group parity test in `tests/queue_kafka.test.ts` (skips gracefully with no broker, exactly like the Prisma tests skip with no DB).
- **Invariant:** queue is pure transport; draining still calls the same KNOLL-gated `dispatch` (`.cursorrules §7`).

### 5.2 Real GPU DREAM/VISION worker (real 7B)
- **Touch:** `colab/05_horizontal_worker.py`, `colab/worker_protocol.py`, `personamatrix/model_backend.py` (the seam already exists).
- **Steps:**
  1. Promote `colab/05_horizontal_worker.py` from simulator to a job: read `WorkerManifest`, `set PERSONAMATRIX_BACKEND=transformers`, load the model **once** per worker, run the persona batch on GPU.
  2. Keep the `to_apex_payload()` / `WorkerReport` shape **byte-identical** so re-ingestion code is untouched.
  3. Report **real** `activeParameters = live_personas × MODEL_PARAMS` and real GPU-seconds; write them into the report's cost fields.
  4. Result delivery: worker POSTs its payload to the gateway `POST /v1/worker/report` (new, auth-gated) **or** produces onto Kafka `hdv.routing` with key=`HOPE`. Either way it re-enters as `DREAM → APEX → HOPE` — never `DREAM ↔ VISION`.
  5. Package the worker as an OCI image (`docker/worker.Dockerfile`, CUDA base) so it runs on any GPU host, not just Colab.
- **Acceptance:** on a GPU box, one intent produces a report whose `activeParameters` is nonzero and whose text came from the model; off-GPU it still skips to stub (D13 stays green).
- **Invariant:** DREAM/VISION stay ephemeral (claim → run → report → self-terminate); HOPE/KNOLL/APEX never become workers (`.cursorrules §7`).

### 5.3 Add `POST /v1/worker/report` ingestion endpoint
- **Touch:** `gateway/server.ts`, `gateway/handlers/*`.
- **Steps:** new authenticated route that accepts a `WorkerReport`, validates it, and submits it **through APEX** (`DREAM|VISION → APEX → HOPE`). It must reject any report whose `source`/`destination` implies a direct DREAM↔VISION edge (KNOLL will also block it — defense in depth).
- **Acceptance:** `tests/gateway_worker.test.ts` — a legal report re-ingests; an illegal one is `401`/`BLOCKED`.

### 5.4 Postgres as the production default
- **Touch:** `persistence/factory.ts`, composition roots (orchestrator + gateway).
- **Steps:** when `DATABASE_URL` is set, `createRepositories()` defaults to `'prisma'`; add `hydrate()` on boot and `flush()`/`close()` on shutdown (SIGTERM handler in `gateway/cli.ts`). Add a `prisma migrate deploy` step (move off `db push` for prod).
- **Acceptance:** gateway boots against Postgres; ledger/audit/intent rows survive a restart; D2's skipped Prisma test runs green with a DB.

### 5.5 Real sandbox for VISION
- **Touch:** `vision/sandbox.ts` (the `SandboxSession` interface is stable).
- **Steps:** add `vision/sandbox_gvisor.ts` (or Firecracker microVM) implementation: same `start/exec/logs/stop`, same exit codes, same billing fields. Enforce no-network by default; allowlist mirrors the existing `http_fetch` allowlist. Keep the process-stub as the default for CI.
- **Acceptance:** `tests/vision_sandbox.test.ts` parameterized over `{stub, gvisor}`; gVisor path skips gracefully where `runsc` is absent.

**Phase 5 exit criteria:** a single documented command spins up Kafka + Postgres + one GPU
worker and runs a real intent end-to-end, with all `.cursorrules` invariants intact and every
existing test still green (skips where infra is absent).

---

## Phase 6 — SCALE THE FLEET (horizontal, observable, cost-aware)

**Goal:** go from "one real worker" to "a scheduler that materializes hundreds of ephemeral
DREAM/VISION workers on demand, each claiming a matrix slice, all idle-cheap." This is where
the 20,480-node topology stops being a diagram and becomes a **scheduling substrate**.

### 6.1 Kubernetes-native ephemeral workers
- **New:** `deploy/` (Helm chart or Kustomize). Always-on `Deployment`s for HOPE gateway, KNOLL, APEX; DREAM/VISION as **`Job`s** (or KEDA `ScaledJob`s) created per claim and torn down on completion.
- **Steps:**
  1. APEX (or a thin `dream/scheduler` sidecar) publishes a claim → a controller creates a Job from `docker/worker.Dockerfile` with the `WorkerManifest` as env/args.
  2. **KEDA** scales worker Jobs off Kafka consumer lag on `hdv.routing` partitions (per-`AgentRole` topic). Zero lag ⇒ zero workers ⇒ zero GPU cost — the "idle-cheap" promise, enforced by the cluster.
  3. Node matrix slices map to worker replicas: a `WorkerManifest` names the `{agent, manager, node[]}` slice; two workers never claim the same node (lease via a Postgres advisory lock or Redis lease key).
- **Acceptance:** a load test that pushes N intents materializes ≤N workers and returns to **0 running workers** within the cool-down; a chaos test kills a worker mid-run and the claim is re-leased (no lost/duplicated node).

### 6.2 Model serving that fits the persona model
- **Decision:** don't load a 7B per persona. Personas are *prompts/adapters* over shared base weights.
- **Steps:**
  1. Stand up **vLLM** (or TGI) as a shared 7B inference server; workers call it over gRPC/HTTP.
  2. Represent a persona as `(base_model, LoRA/prompt-profile, sampling params)`. This is the honest bridge from "2,048,000 personas" to real compute: **shared base weights + cheap per-persona deltas**, not 2M full models. Document this explicitly in `nodes/parameters.ts` comments and `MOAT.md`.
  3. Batch personas per node into a single continuous-batching request to maximize GPU utilization.
- **Acceptance:** GPU utilization > 70% under a full-node persona batch; `activeParameters` accounting still reconciles (base params counted once per replica, not once per persona) — add a `computeActiveParameters` variant that separates **base-resident** vs **delta** params so the number is truthful.

### 6.3 Observability + real cost ledger
- **Steps:**
  1. **OpenTelemetry** traces spanning `gateway → APEX → KNOLL → worker → APEX → HOPE`; the trace id rides in the `RoutingPacket` header (additive field, still hashed).
  2. **Prometheus** metrics: packets/s, KNOLL allow/deny rate, queue lag, live personas, active parameters, GPU-seconds, $/intent.
  3. Rewire the APEX ledger `cost_usd` from a constant to **measured GPU-seconds × instance $/s** (the ledger schema already has the field).
- **Acceptance:** a Grafana dashboard shows a request's full span and its real dollar cost; the ledger total matches the cloud bill within tolerance.

### 6.4 Gateway hardening for scale
- **Steps:** move rate-limit state to Redis (already in `docker-compose`); add JWT/API-key tenancy (see Phase 8); add SSE streaming for long DREAM sims (`GET /v1/intent/stream`); TLS termination via ingress.
- **Acceptance:** k6/vegeta load test sustains target RPS with p99 within budget; health probe stays public and cheap.

**Phase 6 exit criteria:** push traffic → fleet scales up on GPU → drains → scales to zero;
every intent is traced end-to-end and billed at real cost; no invariant regressions under load
or chaos.

---

## Phase 7 — LEARN (the intelligence that becomes the moat)

**Goal:** turn the audit trail and intent archive — which the backbone has been faithfully
recording since Phase 1 — into **learned behavior**: a smarter KNOLL, specialized personas, and
a DREAM that gets better at ranking outcomes. This is where "correct plumbing" becomes "a
system that improves with use."

### 7.1 Learned behavioral scorer (KNOLL stays additive)
- **Touch:** `knoll/scoring/*`, `personamatrix` twin.
- **Steps:**
  1. Export the `SecurityAudit` history (Postgres) as a labeled dataset (allowed/blocked + outcomes).
  2. Train a small classifier (gradient-boosted trees → later a tiny transformer) offline; ship it as an ONNX artifact loaded by KNOLL.
  3. Keep it **strictly additive to the six hard laws** — the learned score can *raise* suspicion and deny, but can **never** override a hard-law `BLOCK` into an `ALLOW` (`.cursorrules §0`). Wire it behind the existing `BEHAVIORAL_SCORE` gate so nothing upstream changes.
  4. Shadow-mode first: log what the model *would* do vs. the heuristic; promote only when precision/recall beat the heuristic on held-out data.
- **Acceptance:** learned scorer ≥ heuristic on a frozen eval set; adversarial red-team suite (prompt-injection, packet-forgery attempts) shows no hard-law bypass.

### 7.2 Persona specialization & routing (mixture-of-personas)
- **Touch:** `nodes/*`, `dream/`, model-serving layer.
- **Steps:**
  1. Give personas typed **specializations** (domain adapters/LoRAs): finance, code, planning, etc.
  2. Add a **router** inside DREAM's node matrix that selects which persona specializations to spawn for a given intent (learned from which personas historically produced top-ranked outcomes). This is the honest, real version of "2M personas": a *library of specializations* dynamically composed, not 2M static models.
  3. Feedback loop: HOPE/user acceptance of an outcome updates persona reputation → routing weights (store in the existing repositories).
- **Acceptance:** on a benchmark task set, specialized routing beats uniform-persona baseline on a task-success metric; routing decisions are logged and explainable.

### 7.3 Memory: the intent archive becomes context
- **Touch:** `hope/` (IntentArchive), persistence.
- **Steps:** add a vector index (pgvector on the existing Postgres) over the intent archive; HOPE retrieves relevant prior intents/outcomes to enrich interpretation. Privacy stays under KNOLL: retrieval requests are packets too, and KNOLL enforces tenant isolation on the vector store.
- **Acceptance:** repeated/related intents get measurably better first-shot interpretations; a cross-tenant retrieval attempt is BLOCKED.

### 7.4 Evaluation harness (so "world-class" is measurable)
- **New:** `eval/` — a golden set of intents with expected routing, expected KNOLL verdicts, and rubric-scored DREAM outcomes. Run it in CI as a **quality gate**, not just a correctness gate.
- **Acceptance:** every PR reports deltas on {routing accuracy, block precision/recall, outcome-rank quality, $/intent, p99 latency}. Regressions block merge.

**Phase 7 exit criteria:** the system demonstrably improves on frozen benchmarks as it ingests
more audit/intent data, with security never weakened and every improvement measured by `eval/`.

---

## Phase 8 — PLATFORM (world-class product & ecosystem)

**Goal:** package the whole thing as a **multi-tenant platform** others build on — the point at
which HDV stops being a repo and becomes infrastructure.

### 8.1 Multi-tenancy & isolation
- **Steps:** add `tenant_id` to the `RoutingPacket` header (hashed) and to every persistence row; KNOLL enforces tenant isolation as a hard law (`NO_CROSS_TENANT`); per-tenant quotas in the ledger; per-tenant rate limits at the gateway. Row-level security in Postgres.
- **Acceptance:** a tenant can never read another tenant's ledger/audit/intent; quota exhaustion returns `429` and bills `$0`.

### 8.2 Public API + SDK
- **Steps:** stabilize and version the gateway API (`/v1` frozen, `/v2` for streaming/tenancy); publish a typed client SDK (TS first, then Python) generated from an OpenAPI spec; ship API docs from the same spec.
- **Acceptance:** a third party integrates in <30 lines using only the SDK; contract tests pin the API surface.

### 8.3 Tool & persona marketplace (extend VISION/DREAM safely)
- **Steps:** a signed-manifest registry for third-party VISION tools and DREAM persona specializations. Every third-party tool runs in the Phase-5 real sandbox, declares its capability/allowlist, and is KNOLL-gated. No tool can escalate to create/govern.
- **Acceptance:** an installed third-party tool executes only within its declared allowlist; a manifest that requests governance is rejected at install time.

### 8.4 Security & compliance posture
- **Steps:** threat model doc; secrets via KMS/Vault (never in env for prod); audit-log immutability (append-only + hash chain over `SecurityAudit`, extending the existing per-packet SHA-256 to a per-log Merkle chain); SBOM + dependency scanning in CI; pen-test; SOC 2 controls mapped to the six laws + tenancy.
- **Acceptance:** external audit passes; tamper of any historical audit row is detectable via the hash chain.

### 8.5 The HOPE product surface
- **Steps:** turn `hope/ui` + the `showcase/` page into a real front-end app talking only to the gateway (never importing agent internals — `.cursorrules §7` boundary holds). Real-time transcript via SSE; live matrix stats; the atmospheric HDV brand as the product identity.
- **Acceptance:** a user completes an intent end-to-end in the browser; the front-end imports **zero** agent modules — only the public API.

**Phase 8 exit criteria:** multi-tenant, documented, SDK-driven, audited platform where the six
laws + `RoutingPacket` remain the immovable core, and third parties can safely extend DREAM and
VISION without ever touching the router or the guard.

---

## Cross-cutting engineering discipline (all phases)

1. **Interfaces first, implementations behind them.** Every "real" thing in Phases 5–8 slots
   behind a seam that already exists (`TaskQueue`, `SandboxSession`, repository interfaces,
   `model_backend`, `WorkerManifest/Report`). Callers must not change.
2. **Graceful skips, not hard deps.** New infra (Kafka, GPU, gVisor, pgvector) must **skip
   gracefully** in CI exactly like the Prisma tests do today, so the bare-checkout suite stays
   green (see [`DIAGNOSTICS.md`](./DIAGNOSTICS.md) §4).
3. **The constitution wins ties.** Any feature that pressures a hard law loses. Additions to
   KNOLL are additive; they can deny more, never allow more.
4. **Every packet still hashed, gated, billed, audited.** No new path (queue, worker, SDK,
   tool) may bypass `APEX → KNOLL`. Defense in depth: validate at the edge *and* at the gate.
5. **Truthful numbers.** As compute becomes real, keep the CONCEPTUAL vs ACTIVE parameter split
   honest and update `nodes/parameters.ts` to separate base-resident from per-persona delta
   params (Phase 6.2). See [`MOAT.md`](./MOAT.md) §"Honest accounting".

---

## Sequencing & dependencies (what unblocks what)

```
Phase 5  (real slice)  ──┬─▶ 5.1 Kafka ─┐
                         ├─▶ 5.4 Postgres┼─▶ Phase 6 (scale: K8s + serving + otel + cost)
                         ├─▶ 5.2 GPU 7B ─┘        │
                         └─▶ 5.5 sandbox          ▼
                                          Phase 7 (learn: scorer, personas, memory, eval)
                                                  │
                                                  ▼
                                          Phase 8 (platform: tenancy, SDK, marketplace, compliance)
```

- Phase 6 **requires** 5.1 (queue lag drives autoscaling), 5.2 (a real worker to scale), 5.4 (durable state).
- Phase 7 **requires** 5.4 + 6.3 (durable audit/intent data + observability to build datasets).
- Phase 8 **requires** 7.4 (an eval harness) so "world-class" is measured, not asserted.

Recommended first PRs (smallest real wins): **5.4** (flip Postgres default) → **5.1**
(Kafka adapter, skip-if-absent) → **5.2** (real 7B worker on one GPU) → **7.4** (eval harness,
which pays back in every later phase).
