# Big 5 Matrix

A strict-separation-of-concerns agent hierarchy. Five "Big AI" agents cooperate, but
**never** talk to each other directly — every exchange is routed by **APEX** and audited
by **KNOLL** using a single, tamper-evident `RoutingPacket` contract.

> **Constitution:** see [`.cursorrules`](./.cursorrules) — the System Manifest. Its core
> rule: *"Strictly enforce the RoutingPacket interface. If any data is passed between
> agents that does not strictly adhere to this interface, the system is considered
> compromised."*

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
├── nodes/          20,480-node topology: SubManager orchestration, lifecycle, persona pipeline
├── persistence/    Repository interfaces + in-memory impls + Redis-like task queue stub
├── colab/          Notebooks for GPU processing & persona spawning (ML lab only)
├── config/         routing_schema.ts, matrix.json, filters.json, schema.prisma
├── personamatrix/  Python: persona loop (filter_director) + billing ledger + scoring twin
├── demo/           TypeScript end-to-end demos (Phase 1 + Phase 2/3)
├── tests/          Automated tests (backbone + phase2 + phase3)
├── package.json
├── tsconfig.json
├── README.md
├── .cursorrules    System Manifest / Constitution
└── .gitignore
```

---

## Phase status

Current release: **v0.2.0 (Phase 2/3)**. The backbone from Phase 1 is unchanged and still
enforced; Phase 2/3 layer richer capabilities on top without breaking any invariant.

| Area                              | Phase 1        | Phase 2/3                                                     |
|-----------------------------------|----------------|--------------------------------------------------------------|
| RoutingPacket contract            | ✅ Enforced    | ✅ Unchanged (SHA-256 hash + knoll_token)                    |
| APEX router                       | ✅ `dispatch`  | ✅ `dispatchAsync` + `ApexOrchestrator` composition root     |
| APEX billing ledger               | ✅ In-memory   | ✅ Optional repository mirror (RequestLog)                   |
| KNOLL 6 virtual laws              | ✅             | ✅ Unchanged (laws run first, always)                        |
| KNOLL behavioral scoring          | —              | ✅ Additive anomaly gate (`BEHAVIORAL_SCORE`) + Python twin  |
| HOPE interpreter                  | ✅ Basic       | ✅ Entities/goals/constraints/urgency, multi-intent, clarify |
| HOPE documentation + voice        | —              | ✅ `IntentDocument` archive + user-facing voice              |
| DREAM simulation                  | ✅ Flat        | ✅ Multi-branch outcome trees + risk/reward/feasibility + Pareto |
| DREAM scheduler                   | —              | ✅ Energy/event hooks (schedules via APEX only)              |
| VISION execution                  | ✅ Stub        | ✅ Tool registry + sandbox sessions + billable `ExecutionReport` |
| Node matrix                       | ✅ Definitions | ✅ SubManager orchestration + fleet lifecycle + persona pipeline |
| Persistence                       | ⚠️ Schema only | ✅ Repository interfaces + in-memory impls + Redis queue stub |
| personamatrix (Python)            | ✅ Persona loop| ✅ + behavioral scoring twin (`personamatrix.scoring`)       |
| Colab lab                         | ✅ 01/02       | ✅ + 03 (scoring) + 04 (ipywidgets tuning w/ CLI fallback)   |
| Docker/gVisor sandbox internals   | ⚠️ Stubbed     | ⚠️ Still stubbed (realistic session IDs/logs/exit codes)     |
| Prisma runtime persistence        | ⚠️ In-memory   | ⚠️ In-memory default; DB-ready via repository interfaces     |
| Real-time queue                   | —              | ⚠️ In-memory Redis-like stub (Kafka deferred to Phase 4)     |
| Real 7B model inference           | ⚠️ Conceptual  | ⚠️ Conceptual only                                           |

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
npm test              # all tests (backbone + phase2 + phase3)
npm run python:demo   # persona loop + billing ledger (python3)
npm run python:scoring# behavioral scoring twin validation (python3)
```

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

## License

UNLICENSED — internal Phase 2/3 scaffold.
