# Big 5 Matrix

A strict-separation-of-concerns agent hierarchy. Five "Big AI" agents cooperate, but
**never** talk to each other directly — every exchange is routed by **APEX** and audited
by **KNOLL** using a single, tamper-evident `RoutingPacket` contract.

> **Constitution:** see [`.cursorrules`](./.cursorrules) — the System Manifest. Its core
> rule: *"Strictly enforce the RoutingPacket interface. If any data is passed between
> agents that does not strictly adhere to this interface, the system is considered
> compromised."*
>
> **Game plan & architecture:** see [`docs/GAME_PLAN.md`](./docs/GAME_PLAN.md) (the
> authoritative full plan) and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (mermaid
> diagrams for packet flow, always-on vs ephemeral, the node matrix, and the HOPE voice loop).

---

## The Big 5

| Agent  | Full name                                                        | Layer         | Job                                              | Hard constraint                          | Lifecycle    |
|--------|-----------------------------------------------------------------|---------------|--------------------------------------------------|------------------------------------------|--------------|
| HOPE   | Holloway's Own Providential Enterprise                          | Interface     | Parse intent, be the UI/UX voice (interpreter)   | CANNOT execute or create                 | Always-on    |
| DREAM  | Dynamic Renderer of Ephemeral Art Model                         | Simulation    | Generate all possible outcomes                    | CANNOT govern or execute                 | Ephemeral    |
| VISION | Vectorized Infrastructure and Systems Ionic Operational Node    | Action        | Tool usage / task implementation (sandboxed)     | CANNOT create or govern                  | Ephemeral    |
| KNOLL  | Kinetic Node of Operational Locks and Limiters                 | Security      | Watch all traffic, enforce virtual laws, privacy | Always active, monitor-only              | Always-on    |
| APEX   | Automated Processor of Ephemeral eXchanges                     | Orchestration | Route tasks between agents (master router)        | Every route MUST pass through KNOLL first | Always-on    |

**Operational rule:** APEX is master router · KNOLL is master auditor · HOPE is master
interpreter. **DREAM and VISION cannot communicate directly.**

### Legal traffic flow

```
SOURCE agent ──▶ APEX.dispatch() ──▶ KNOLL.intercept() ──▶ (allowed?) ──▶ DESTINATION agent
                                          │
                                          └── (blocked) ──▶ SecurityAudit + ledger BLOCKED
```

No peer agent module imports another peer agent module. Agents only receive an APEX
transport (the router, or a `sendViaApex` callback) via dependency injection.

---

## Matrix math

- Under each of the 5 Big AI: **4,096 nodes** = 64 sub-AI managers × 64 nodes each.
- Total across the Big 5: **20,480 nodes**.
- Each node hosts **100 ephemeral personas** (spawn → execute → terminate).
- Each persona is tied to a conceptual **7B** model → ~**14.3 quadrillion** parameters.
- Always-on standby: **HOPE, KNOLL, APEX**. Ephemeral: **DREAM, VISION** (+ their matrices).

```
20,480 nodes × 100 personas × 7,000,000,000 params ≈ 1.4336 × 10^16 ≈ 14.3 quadrillion
```

---

## Repository layout

```
big5-matrix/
├── apex/           Orchestrator & routing (router, ledger, packet, orchestrator, dispatchAsync)
├── hope/           Intent interpreter + documenter (IntentArchive) + voice
├── dream/          Multi-branch simulation engine (outcome trees, ranking) + scheduler
├── vision/         Sandboxed tool library (tools registry + sandbox sessions + reports)
├── knoll/          Security guardrails: 6 virtual laws + behavioral scoring (scoring/features)
├── nodes/          20,480-node topology + lifecycle + persona pipeline + parameter accounting
├── gateway/        Phase 4 HOPE HTTP API (node:http): server + CLI (no framework)
├── persistence/    Repository interfaces + in-memory impls + Redis stub + Kafka-like queue
├── colab/          Notebooks for GPU processing & persona spawning (ML lab only) + worker protocol
├── config/         routing_schema.ts, matrix.json, filters.json, schema.prisma
├── personamatrix/  Python: persona loop + billing ledger + scoring twin + parameter twin
├── demo/           TypeScript end-to-end demos (Phase 1 + Phase 2/3 + Phase 4)
├── docs/           GAME_PLAN.md + ARCHITECTURE.md (mermaid diagrams)
├── tests/          Automated tests (backbone + phase2 + phase3 + phase4)
├── package.json
├── tsconfig.json
├── README.md
├── .cursorrules    System Manifest / Constitution
└── .gitignore
```

---

## Phase status

Current release: **v0.3.0 (Phase 4 foundations)**. The backbone from Phase 1 and the Phase
2/3 capabilities are unchanged and still enforced; Phase 4 layers forward-facing presence
and scaling foundations on top **without breaking any invariant** (typecheck + all existing
tests still pass; new tests added). See [`docs/GAME_PLAN.md`](./docs/GAME_PLAN.md) for the
authoritative plan.

| Area                              | Phase 1        | Phase 2/3                                                     | Phase 4 (v0.3.0)                                          |
|-----------------------------------|----------------|--------------------------------------------------------------|----------------------------------------------------------|
| RoutingPacket contract            | ✅ Enforced    | ✅ Unchanged (SHA-256 hash + knoll_token)                    | ✅ Unchanged (only inter-agent contract)                 |
| APEX router                       | ✅ `dispatch`  | ✅ `dispatchAsync` + `ApexOrchestrator` composition root     | ✅ + optional async **queue intake** (same KNOLL gate)   |
| APEX billing ledger               | ✅ In-memory   | ✅ Optional repository mirror (RequestLog)                   | ✅ Unchanged; surfaced read-only via gateway `/v1/ledger` |
| KNOLL laws + behavioral scoring   | ✅ / —         | ✅ Additive anomaly gate (`BEHAVIORAL_SCORE`)                | ✅ Unchanged (gates sync + async + gateway paths)        |
| HOPE interpreter/document/voice   | ✅ Basic       | ✅ Entities/goals/urgency, clarify, voice                    | ✅ + **HTTP gateway** (`gateway/`) forward-facing        |
| DREAM simulation + scheduler      | ✅ Flat        | ✅ Multi-branch trees + Pareto + scheduler                   | ✅ Unchanged; also backs ephemeral Colab workers         |
| VISION execution                  | ✅ Stub        | ✅ Tool registry + sandbox + billable report                 | ✅ Unchanged                                             |
| Node matrix                       | ✅ Definitions | ✅ SubManager + fleet lifecycle + pipeline                   | ✅ + **parameter accounting** (`nodes/parameters.ts`)    |
| personamatrix (Python)            | ✅ Persona loop| ✅ + behavioral scoring twin                                 | ✅ + **parameter twin** (`personamatrix/parameters.py`)  |
| Colab lab                         | ✅ 01/02       | ✅ + 03 (scoring) + 04 (ipywidgets)                          | ✅ + **05 horizontal worker** + `worker_protocol.py`     |
| Real-time queue                   | —              | ⚠️ In-memory Redis-like stub                                | ✅ **Kafka-like partitioned queue + consumer groups**    |
| Docker/gVisor sandbox internals   | ⚠️ Stubbed     | ⚠️ Realistic stub                                           | ⚠️ Still stubbed                                         |
| Prisma runtime persistence        | ⚠️ In-memory   | ⚠️ DB-ready via repository interfaces                       | ⚠️ In-memory default; Prisma/Postgres still next         |
| Real 7B inference / real GPU      | ⚠️ Conceptual  | ⚠️ Conceptual                                               | ⚠️ Conceptual (worker payloads simulated)                |

---

## Requirements

- Node.js ≥ 20 (developed on Node 22)
- Python ≥ 3.10 (standard library only; `ipywidgets` optional for `colab/04`)

## Install

```bash
cd big5-matrix
npm install
```

## Commands

```bash
npm run typecheck     # tsc --noEmit — MUST be zero errors
npm run demo          # Phase 1: routing + KNOLL block + tampered-hash demo
npm run demo:phase2   # Phase 2/3: HOPE docs, DREAM trees, VISION tools, KNOLL scoring
npm run demo:phase4   # Phase 4: queue intake · worker re-ingestion · params · health
npm run gateway       # start HOPE HTTP gateway on PORT (default 8787)
npm test              # all tests (backbone + phase2 + phase3 + phase4)
npm run python:demo   # persona loop + billing ledger (python3)
npm run python:scoring# behavioral scoring twin validation (python3)
npm run python:worker # ephemeral DREAM/VISION Colab worker simulation (python3)
```

### Phase 4 highlights & how to start the gateway

Phase 4 gives HOPE a forward-facing HTTP presence and lays the fleet-scaling foundations:

```bash
npm run gateway              # binds PORT env or 8787
PORT=9090 npm run gateway    # custom port
```

Endpoints (all JSON; every routed packet is still gated by KNOLL — the gateway never
bypasses APEX):

| Method | Path                | Purpose                                                        |
|--------|---------------------|---------------------------------------------------------------|
| POST   | `/v1/intent`        | `{ "utterance" }` → HOPE interpret + document + submit via APEX |
| GET    | `/v1/health`        | Always-on (HOPE/KNOLL/APEX) + ephemeral Dream/Vision idle flags |
| GET    | `/v1/ledger`        | Recent APEX billing entries (read-only)                        |
| GET    | `/v1/audit`         | Recent KNOLL verdicts (read-only)                              |
| GET    | `/v1/matrix/stats`  | Node/persona topology + 14.3Q parameter accounting            |

Example:

```bash
curl -s localhost:8787/v1/intent -H 'content-type: application/json' \
  -d '{"utterance":"simulate three outcomes for launching the product early"}'
curl -s localhost:8787/v1/health
```

Other Phase 4 pieces: a **Kafka-like partitioned task queue** (`persistence/kafka_stub.ts`,
optional async intake in `ApexOrchestrator`), **parameter accounting** (`nodes/parameters.ts`
+ `personamatrix/parameters.py`), and the **horizontal Colab worker protocol**
(`colab/worker_protocol.py` + `colab/05_horizontal_worker.py`). Only HOPE/KNOLL/APEX need
standby; DREAM/VISION workers are ephemeral and self-terminating.

### What the Phase 1 demo shows

1. HOPE parses a natural-language request into a structured intent.
2. APEX wraps it in a `RoutingPacket`, calls KNOLL, and (if allowed) routes to DREAM.
3. DREAM simulates outcomes; results return **via APEX** (never directly).
4. The APEX ledger records `cost_usd` for the ephemeral execution.
5. KNOLL **blocks** an illegal direct `DREAM → VISION` packet.
6. KNOLL **blocks** a packet with a tampered SHA-256 hash.

### What the Phase 2/3 demo adds

1. HOPE **interprets + documents** an intent (entities/goals/constraints/urgency) and speaks.
2. APEX **orchestrates** it to DREAM; a ranked **outcome tree** returns via APEX.
3. APEX orchestrates a task to VISION's **sandboxed tool registry**; a billable report returns.
4. A low-confidence utterance triggers a **clarification** (no dispatch).
5. The **DREAM scheduler** schedules a speculative sim on a stream `ENERGY_SPIKE` (via APEX).
6. KNOLL **blocks** an illegal direct `DREAM → VISION` packet.
7. KNOLL **blocks** a high **behavioral-anomaly** packet (`BEHAVIORAL_SCORE`, additive to the laws).
8. Persistence repositories mirror the ledger + audit + intent-archive rows.

---

### What the Phase 4 demo adds

1. **Parameter accounting** — the ~14.3 quadrillion figure computed (not asserted), with a
   per-agent breakdown and an ACTIVE snapshot (idle personas draw ~zero compute).
2. **Async intake** — an intent is *published* to a partitioned, consumer-group task queue
   and drained by a consumer that dispatches it through the **same KNOLL gate**.
3. **Worker re-ingestion** — a simulated ephemeral DREAM worker's result is re-ingested via
   APEX (`DREAM → HOPE`, legal), and an illegal `DREAM → VISION` route is **BLOCKED**.
4. **Health snapshot** — always-on (HOPE/KNOLL/APEX) vs ephemeral (DREAM/VISION) status.

## License

UNLICENSED — internal Phase 4 scaffold.
