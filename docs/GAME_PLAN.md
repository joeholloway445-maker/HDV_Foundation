# BIG 5 MATRIX — GAME PLAN

> The authoritative game plan. This is the "north star" document: what the system is, how
> its parts relate, what is built vs. what is next, and the rules that must never bend.
> The binding constitution is [`../.cursorrules`](../.cursorrules); this document explains
> and extends it without weakening it. Architecture diagrams live in
> [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. Vision

Build a **14.3-quadrillion-parameter** cognitive matrix out of five specialized "Big AI"
that cooperate under a strict hierarchy but **never talk to each other directly**. Every
exchange is routed by **APEX** and audited by **KNOLL** using a single, tamper-evident
`RoutingPacket` contract. Intelligence emerges from a vast fleet of small, ephemeral
personas — not from one monolith — so the system is horizontally scalable, auditable, and
cheap at rest.

The headline number is *conceptual capacity*, computed (not asserted) in
[`../nodes/parameters.ts`](../nodes/parameters.ts) and its Python twin
[`../personamatrix/parameters.py`](../personamatrix/parameters.py):

```
20,480 nodes × 100 personas/node × 7,000,000,000 params
  = 1.4336 × 10^16 parameters   (~14.3 quadrillion)
```

The fleet is *idle-cheap*: personas are ephemeral (spawn → execute → terminate) and nodes
are materialized on demand, so **active** parameters (the ones that actually cost GPU) track
live personas only — the other 14.3Q sits dormant at ~zero compute.

---

## 2. The Big 5 — roles and constraints

| Agent  | Full name                                                     | Layer         | Job                                              | Hard constraint                            | Lifecycle  |
|--------|--------------------------------------------------------------|---------------|--------------------------------------------------|--------------------------------------------|------------|
| HOPE   | Holloway's Own Providential Enterprise                       | Interface     | Parse intent; be the UI/UX voice (interpreter)   | CANNOT execute or create                   | Always-on  |
| DREAM  | Dynamic Renderer of Ephemeral Art Model                     | Simulation    | Generate all possible outcomes                    | CANNOT govern or execute                   | Ephemeral  |
| VISION | Vectorized Infrastructure and Systems Ionic Operational Node| Action        | Tool usage / task implementation (sandboxed)     | CANNOT create or govern                     | Ephemeral  |
| KNOLL  | Kinetic Node of Operational Locks and Limiters             | Security      | Watch all traffic; enforce virtual laws; privacy | Always active, monitor-only                | Always-on  |
| APEX   | Automated Processor of Ephemeral eXchanges                 | Orchestration | Route tasks between agents (master router)        | Every route MUST pass through KNOLL first  | Always-on  |

**One sentence each:**
- **HOPE** understands you and speaks back; it never acts.
- **DREAM** imagines outcomes; it never governs or executes them.
- **VISION** does the work in a sandbox; it never invents work or governs.
- **KNOLL** watches everything and says allow/deny; it never does business work.
- **APEX** is the single legal road between agents; it always asks KNOLL first.

---

## 3. Matrix topology math

Constants live in [`../nodes/constants.ts`](../nodes/constants.ts) and
[`../config/matrix.json`](../config/matrix.json):

```
MANAGERS_PER_AGENT = 64
NODES_PER_MANAGER  = 64
NODES_PER_AGENT    = 64 × 64            = 4,096
TOTAL_NODES        = 4,096 × 5 (Big 5)  = 20,480
PERSONAS_PER_NODE  = 100
MODEL_PARAMS       = 7,000,000,000      (7B, conceptual)

TOTAL_PERSONAS     = 20,480 × 100       = 2,048,000
TOTAL_PARAMETERS   = 2,048,000 × 7B     = 1.4336e16  (~14.3 quadrillion)
```

Each Big AI owns an identical 4,096-node matrix, so each represents exactly **20%** of the
conceptual total. Nodes are lazily materialized (never all 20,480 at once); the number is a
*capacity*, not a row count.

---

## 4. Always-on vs ephemeral

Only **three of the five** Big AI need standby presence:

- **Always-on (standby):** HOPE, KNOLL, APEX — the interface, the guard, and the router are
  always up so the system can receive, gate, and route at any moment.
- **Ephemeral (spun up on demand, then self-terminate):** DREAM, VISION — and their node
  matrices. They claim a slice, run a batch, report back **through APEX**, and tear down.

This is why DREAM/VISION are a perfect fit for disposable, horizontally-scaled Colab/GPU
workers (see [`../colab/05_horizontal_worker.py`](../colab/05_horizontal_worker.py) and
[`../colab/worker_protocol.py`](../colab/worker_protocol.py)).

---

## 5. Phase status — built vs. next

| Capability                        | Phase 1     | Phase 2/3                              | Phase 4 (this release)                                  |
|-----------------------------------|-------------|----------------------------------------|--------------------------------------------------------|
| RoutingPacket contract            | ✅ enforced | ✅ unchanged                           | ✅ unchanged (still the only inter-agent contract)     |
| APEX router + KNOLL gate          | ✅          | ✅ orchestrator composition root        | ✅ unchanged; now also feeds an async queue path       |
| KNOLL 6 laws + behavioral score   | ✅ / —      | ✅ additive scoring gate                | ✅ unchanged                                           |
| HOPE interpret/document/voice     | ✅ basic    | ✅ entities/goals/urgency/clarify/voice | ✅ + **HTTP gateway** (forward-facing presence)        |
| DREAM outcome trees               | ✅ flat     | ✅ multi-branch + Pareto                | ✅ unchanged                                           |
| VISION sandboxed tools            | ✅ stub     | ✅ tool registry + sandbox sessions     | ✅ unchanged                                           |
| Node matrix + persona lifecycle   | ✅          | ✅ SubManager + fleet lifecycle         | ✅ + **parameter accounting module**                   |
| Task queue                        | —           | ⚠️ in-memory Redis-like priority stub  | ✅ **Kafka-like partitioned queue + consumer groups**  |
| Colab lab                         | ✅ 01/02    | ✅ 03/04                                | ✅ **05 horizontal worker + worker protocol**          |
| Persistence                       | ⚠️ schema   | ✅ repo interfaces + in-memory impls     | ⚠️ in-memory default; Prisma/Postgres still next       |
| Real 7B inference / real GPU      | ⚠️ conceptual | ⚠️ conceptual                         | ⚠️ conceptual (worker payloads are simulated)          |
| Real container sandbox            | ⚠️ stub     | ⚠️ realistic stub                      | ⚠️ still stub                                          |

**Built in Phase 4:**
1. Distributed task-queue abstraction (Kafka-shaped) — [`../persistence/kafka_stub.ts`](../persistence/kafka_stub.ts), wired optionally into `ApexOrchestrator` for async intake.
2. HOPE HTTP API gateway (node:http, no framework) — [`../gateway/`](../gateway).
3. Horizontal Colab worker protocol + ephemeral worker simulator — [`../colab/`](../colab).
4. Parameter accounting (TS + Python twins) — the formalized 14.3Q math.
5. Full documentation (this file + `ARCHITECTURE.md`) and a Phase 4 composition demo.

**Deliberately still next (not built):** real Kafka, real GPU workers, real container
sandboxes, and a Prisma/Postgres-backed persistence swap. See §10, and the full phased path
(Phases 5–8, with exact engineering steps) in [`ROADMAP.md`](./ROADMAP.md).

---

## 6. Operational rules (hard laws)

These mirror `.cursorrules §2` and are **non-negotiable**:

1. APEX is the master router. KNOLL is the master auditor. HOPE is the master interpreter.
2. No agent talks to another directly. All traffic flows `SOURCE → APEX → KNOLL → DEST`.
3. **DREAM and VISION can never communicate directly**, in either direction.
4. APEX **must** call `KNOLL.intercept(packet)` before routing; a deny drops + logs it.
5. No module imports another peer agent module. Peers get an APEX transport via DI only.
6. Every ephemeral execution is billed in the APEX ledger (`cost_usd`, SUCCESS/BLOCKED/FAILED).
7. KNOLL never mutates a payload to make it pass; it only allows or denies.

The Phase 4 additions **inherit** these rules: the gateway submits `HOPE → APEX` and never
addresses DREAM/VISION directly; the task queue is pure transport and is drained through the
same KNOLL-gated `dispatch`; worker results are re-ingested as `DREAM/VISION → APEX → HOPE`
(never DREAM ↔ VISION).

---

## 7. Colab vs. desktop boundaries

- **Colab / ML lab (`colab/`)** — GPU processing and persona spawning **only**. Simulation
  and compute. **No** webcam, microphone, or physical-world I/O (`.cursorrules §6`). This is
  where ephemeral DREAM/VISION workers run: claim a matrix slice, run a persona batch, emit
  an APEX-re-ingestable payload, self-terminate.
- **Desktop (Antigravity / OBS, etc.)** — out of scope for this repository. Any desktop
  orchestration, capture, or presentation layer must sit **outside** the matrix and speak to
  it only through HOPE's HTTP gateway (or a future authenticated API). It must never import
  agent internals or bypass APEX/KNOLL. The boundary is the `RoutingPacket` and the gateway.

---

## 8. Security model

Two layers, evaluated in a fixed order by KNOLL (see [`../knoll/validator.ts`](../knoll/validator.ts)):

1. **Structural + integrity** — the value must be a `RoutingPacket`; the SHA-256 hash over
   the canonical `header + payload` must match (tamper detection); rate limits per source.
2. **The six virtual laws** (hard rules), then **behavioral scoring** (additive anomaly gate):
   - `TOKEN_WELL_FORMED`, `VALID_ENDPOINTS`, `NO_DIRECT_DREAM_VISION`, `NO_KNOLL_FORGERY`,
     `HOPE_CANNOT_COMMAND`, `NO_MALICIOUS_INTENT`.
   - Behavioral score flags/denies high-anomaly traffic the hard laws can't express
     (entropy, secret-word density, oversized payloads, reputation of repeat offenders).

KNOLL is **monitor-only**: it emits `SecurityAudit` records and returns allow/deny; it never
executes or creates. Everything routed — sync or async, gateway or queue — passes this gate.

---

## 9. Billing / ledger model

Every packet APEX attempts to route produces exactly one ledger row
([`../apex/ledger.ts`](../apex/ledger.ts)); every successful ephemeral execution is billed
`cost_usd` with a `SUCCESS | BLOCKED | FAILED` status and a compact KNOLL signature.
BLOCKED packets are billed `$0`. The Python twin ([`../personamatrix/ledger.py`](../personamatrix/ledger.py))
bills by `personas × costPerPersona + modelSeconds × costPerModelSecond`. The ledger mirrors
the `RequestLog` Prisma model so an in-memory row is a drop-in for a durable table. The
gateway's `GET /v1/ledger` is a read-only projection of this ledger.

---

## 10. Scaling roadmap

> The full, phased path to a world-class platform (Phases 5–8) — with file-level engineering
> steps, acceptance tests, and sequencing — lives in [`ROADMAP.md`](./ROADMAP.md). The list
> below is the near-term dependency order that feeds it.

Ordered by dependency, each item slots behind an existing interface so callers don't change:

1. **Real Kafka** — replace `InMemoryKafkaStub` behind the `TaskQueue` interface. Partition
   key = destination `AgentRole`; `publish` → producer.send; `subscribe(group, …)` →
   consumer groups; `ack` → offset commit; `nack` → seek/DLQ. Add a schema registry for the
   serialized `RoutingPacket` (KNOLL still validates the deserialized packet). Migration
   notes live at the top of [`../persistence/kafka_stub.ts`](../persistence/kafka_stub.ts).
2. **Real GPU workers** — turn `colab/05_horizontal_worker.py` into a job that loads a real
   7B model, runs the persona batch on GPU, and POSTs its `to_apex_payload()` result to the
   gateway (or produces onto Kafka). The `WorkerManifest`/`WorkerReport` contract is stable.
3. **Real sandboxes** — swap VISION's stub sandbox for Docker/gVisor behind the existing
   `SandboxSession` interface; keep exit codes, logs, and billing fields identical.
4. **Prisma / Postgres** — implement the repository interfaces
   ([`../persistence/repositories.ts`](../persistence/repositories.ts)) against
   [`../config/schema.prisma`](../config/schema.prisma). The ledger, audit log, intent
   archive, and node identities already mirror those models field-for-field.
5. **Gateway hardening** — auth (API keys/JWT), rate limiting at the edge, TLS termination,
   and a swappable transport (the handlers are already transport-agnostic).

---

## 11. Next recommended engineering steps

1. Stand up a single-broker Kafka in docker-compose and implement the `TaskQueue` adapter;
   run the Phase 4 demo against it to prove consumer parity.
2. Add a Prisma repository package and a `DATABASE_URL`-driven switch in the composition
   roots (orchestrator/gateway) so persistence is durable in one flag.
3. Add authentication + per-client rate limiting to the gateway; expose `/v1/intent`
   streaming (Server-Sent Events) for long-running DREAM simulations.
4. Promote the behavioral scorer to a learned model trained on the audit trail; keep it
   additive to the six laws (never weaken the hard rules).
5. Wire a real GPU worker path end-to-end for one narrow task and measure active-parameter
   utilization against the accounting module.

---

## 12. Command reference

```bash
npm run typecheck       # tsc --noEmit — zero errors
npm test                # all phases (backbone + phase2 + phase3 + phase4)
npm run demo            # Phase 1 backbone: routing + KNOLL block + tampered hash
npm run demo:phase2     # Phase 2/3: HOPE docs, DREAM trees, VISION tools, KNOLL scoring
npm run demo:phase4     # Phase 4: queue intake · worker re-ingestion · params · health
npm run gateway         # start HOPE HTTP gateway on PORT (default 8787)
python3 personamatrix/demo.py            # persona loop + billing ledger
python3 colab/05_horizontal_worker.py    # ephemeral DREAM/VISION worker simulation
```
