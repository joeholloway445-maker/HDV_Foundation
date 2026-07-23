# SCALE.md — Phase 6: scale the fleet (K8s · KEDA · vLLM)

> **Thesis: always-on trio tiny; workers to zero.**
> HOPE · KNOLL · APEX are three small resident processes. DREAM & VISION — and the entire
> 20,480-node / ~14.3-quadrillion-parameter fleet — are **ephemeral**: they materialize per
> claim and drain to **zero** when idle. Scale is "infinite" precisely because idle costs ≈ $0
> and you meter **active**-parameter-seconds, not fleet size. Phase 6 makes the cluster enforce
> that promise.

This doc is the concrete build plan for Phase 6 of [`ROADMAP.md`](./ROADMAP.md) §"Phase 6 —
Scale the fleet". It turns the topology diagram into a **scheduling substrate**. Nothing here
weakens the constitution: every new path still flows `SOURCE → APEX → KNOLL → DEST`, every
packet is hashed/gated/billed/audited, and new infra **skips gracefully** in CI (like the
Prisma/Kafka tests do today — see [`DIAGNOSTICS.md`](./DIAGNOSTICS.md)).

---

## The shape we are building

```
                       ┌──────────────────────────────────────────────┐
   internet ──TLS──▶   │  ALWAYS-ON CORE (tiny, cheap, never scales to 0)│
                       │   HOPE gateway ·  APEX router ·  KNOLL auditor  │   Deployments (HPA 1..n)
                       └───────────────┬───────────────────────────────┘
                                       │ publishes claims to Kafka (per-AgentRole topic)
                                       ▼
                       ┌──────────────────────────────────────────────┐
                       │  KEDA ScaledJob  (lag on hdv.routing.DREAM/…)  │
                       │   0 lag ⇒ 0 workers ⇒ 0 GPU $                   │
                       └───────────────┬───────────────────────────────┘
                                       │ materializes N ephemeral Jobs on demand
                                       ▼
        DREAM / VISION worker Jobs  ──gRPC/HTTP──▶  shared vLLM 7B (base weights, once)
        (claim a {agent,manager,node[]} slice)      + per-persona LoRA/prompt deltas
                                       │ result re-ingested → APEX → HOPE (never DREAM↔VISION)
                                       ▼
                       Postgres (ledger/audit/intent) · Redis (leases/rate-limit) · OTel/Prom
```

The always-on core already exists (`gateway/`, `apex/`, `knoll/`). The queue seam exists
(`persistence/kafka_stub.ts` + `kafka_real.ts`, `docker-compose.yml` `kafka` service). The
worker protocol exists (`colab/worker_protocol.py`, `colab/05_horizontal_worker.py`). Phase 6
is: **a scheduler that owns worker lifecycle, a shared model server, and real cost/observability.**

---

## 6.1 — Kubernetes-native ephemeral workers  ·  *the "to zero" enforcement*

**Goal:** APEX publishes a claim → a controller creates a worker Job → it claims a matrix
slice, runs, reports through APEX, and is torn down. Zero pending work ⇒ zero workers.

**Concrete next PRs**
1. **PR `deploy/k8s`: base manifests.** Add a Helm chart (or Kustomize) under `deploy/k8s/`:
   - `Deployment`s (with HPA) for `hope-gateway`, `apex`, `knoll` — the always-on trio. Small
     requests/limits; these never scale to zero.
   - `docker/worker.Dockerfile` for DREAM/VISION (reuse `deploy/Dockerfile` multi-stage build;
     entrypoint = the worker runner that reads a `WorkerManifest`).
   - A `ServiceAccount` + `Role` letting the scheduler create/delete `Job`s in its namespace.
   - *Acceptance:* `helm template` renders; the trio comes up; no worker runs at rest.
2. **PR `dream/scheduler`: claim → Job.** A thin controller (or APEX sidecar) that turns a
   published claim into a `Job` from `worker.Dockerfile`, passing the `WorkerManifest`
   (`{agent, manager, node[]}` slice + intent ref) as env/args. On completion, `ttlSecondsAfterFinished`
   reaps the Job. *Acceptance:* a single intent creates exactly one Job that exits and is reaped.
3. **PR `deploy/keda`: autoscale on queue lag.** A **KEDA `ScaledJob`** per worker role bound to
   Kafka consumer lag on `hdv.routing.DREAM` / `hdv.routing.VISION` (topics already produced by
   `KafkaTaskQueue`). `minReplicaCount: 0`, `maxReplicaCount: N`, cooldown → drains to 0.
   *Acceptance:* a load test pushing N intents materializes ≤ N workers and returns to **0
   running workers** within the cooldown window.
4. **PR `nodes/lease`: no double-claims.** Two workers must never claim the same node. Add a
   lease via a **Postgres advisory lock** or a **Redis lease key** (Redis is already in
   `docker-compose.yml`). *Acceptance:* a chaos test that kills a worker mid-run re-leases the
   claim with no lost/duplicated node.

**Invariant guard:** the scheduler is *transport plumbing* — it may not inspect, mutate, or
route packets; workers still send results `→ APEX → HOPE`, and DREAM/VISION never address each
other (KNOLL LAW 3 holds at the edge *and* the gate).

---

## 6.2 — Model serving that fits the persona model  ·  *the honest big-number*

**Goal:** don't load a 7B per persona. Personas are **prompts/adapters over shared base
weights** — this is the truthful bridge from "2,048,000 personas" to real compute.

**Concrete next PRs**
1. **PR `serving/vllm`: shared inference server.** Stand up **vLLM** (or TGI) serving one 7B
   base model; workers call it over gRPC/HTTP. Add a `vllm` service to a `deploy/` compose
   profile and a `serving/client.ts` behind the existing `model_backend` seam so callers don't
   change. *Acceptance:* a worker gets a completion from vLLM through the seam; missing server
   ⇒ graceful skip in CI.
2. **PR `serving/persona-adapters`: `(base, LoRA/prompt-profile, sampling)`.** Represent a
   persona as a cheap delta over shared weights, not a full model. Batch a node's personas into
   one **continuous-batching** request to keep the GPU hot. *Acceptance:* GPU utilization > 70%
   under a full-node persona batch.
3. **PR `nodes/parameters`: truthful active-vs-base accounting.** Extend
   `nodes/parameters.ts` with a `computeActiveParameters` variant that separates
   **base-resident** params (counted **once per replica**) from **per-persona delta** params, so
   the ~1.4336e16 conceptual figure and the **active** figure are both honest. Update
   [`MOAT.md`](./MOAT.md) §"Honest accounting". *Acceptance:* the accounting reconciles; the
   billing meter (active-parameter-seconds) still matches.

> This is what makes the cost line in the **eval board** (`cost_per_active_param_second`, see
> [`../eval/run_board.ts`](../eval/run_board.ts)) real: base weights are amortized per replica,
> deltas are cheap, and idle personas contribute **zero** active-param-seconds.

---

## 6.3 — Observability + real cost ledger  ·  *measure, don't assert*

**Goal:** trace every intent end-to-end and bill it at **measured** dollars, not a constant.

The out-of-band metering seam already exists: `observability/metrics.ts` (`MetricsCollector`,
Prometheus exposition) and `observability/trace.ts` (`PacketTracer`) consume the router's
read-only `DispatchObserver` and can never alter routing.

**Concrete next PRs**
1. **PR `observability/otel`: distributed traces.** OpenTelemetry spans across
   `gateway → APEX → KNOLL → worker → APEX → HOPE`. Carry the trace id as an **additive**
   `RoutingPacket` header field (still inside the hashed region). *Acceptance:* one request's
   full span tree is visible in a collector.
2. **PR `observability/prom-scrape`: fleet metrics.** Export packets/s, KNOLL allow/deny rate,
   Kafka lag, live personas, active parameters, GPU-seconds, $/intent. Wire the existing
   `toPrometheus()` output behind `/v1/metrics?format=prometheus` (already served) into a
   ServiceMonitor. Ship a Grafana dashboard JSON under `deploy/observability/`.
3. **PR `apex/cost-real`: measured ledger cost.** Rewire `ApexRouter` `defaultCostUsd` from a
   constant to **GPU-seconds × instance $/s** reported by the worker (the ledger `cost_usd`
   field already exists; billing already prices active-parameter-seconds). *Acceptance:* ledger
   total matches the cloud bill within tolerance; the eval board's `cost_per_active_param_second`
   is computed from real runs.

---

## 6.4 — Gateway hardening for scale

**Concrete next PRs**
1. **PR `gateway/redis-ratelimit`: shared limiter.** Move rate-limit state to Redis (already in
   compose) so horizontally-scaled gateway replicas share a window.
2. **PR `gateway/tenancy-auth`: JWT/API-key.** Per-tenant keys at the edge (feeds Phase 8.1
   `NO_CROSS_TENANT`). See `tenancy/`.
3. **PR `gateway/sse-stream`: `GET /v1/intent/stream`.** Server-sent events for long DREAM sims.
4. **PR `deploy/ingress-tls`:** TLS termination via ingress (Caddy/nginx configs already in
   `deploy/`). *Acceptance:* a k6/vegeta load test sustains target RPS with p99 in budget; the
   health probe stays public and cheap.

---

## Phase 6 exit criteria

- Push traffic → the fleet scales **up** on GPU → drains → scales to **zero** within cooldown.
- Every intent is **traced** end-to-end and **billed at real cost**.
- **No invariant regressions** under load or chaos — verified by the public eval board
  (`npm run eval:board`; `governance_violation_rate` must stay `0`) run as a CI gate.

## Recommended order

`6.1 KEDA ScaledJob (scale-to-zero)` → `6.2 vLLM shared serving` → `6.3 real cost + OTel` →
`6.4 gateway hardening`. Each slots behind a seam that already exists, so callers don't change.

## Dependencies & references

- Requires Phase 5.1 (Kafka queue), 5.2 (a real worker), 5.4 (durable Postgres). Status:
  [`PHASES_5_8_STATUS.md`](./PHASES_5_8_STATUS.md).
- Local infra: [`../docker-compose.yml`](../docker-compose.yml) (postgres · redis · kafka).
- Prod runbook: [`../deploy/README.md`](../deploy/README.md) · [`../deploy/HOSTINGER.md`](../deploy/HOSTINGER.md).
- Quality gate: [`../eval/run_board.ts`](../eval/run_board.ts) · open-core surface:
  [`../packages/constitution/README.md`](../packages/constitution/README.md).
