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
├── apex/           Orchestrator & routing logic (master router, ledger, packet helpers)
├── hope/           User intent & interpretation interface
├── dream/          Simulation engines (ephemeral creation)
├── vision/         Task-execution tools (Docker/gVisor sandbox stubs)
├── knoll/          Middleware security & compliance guardrails
├── nodes/          The 20,480-node definitions & scaling logic
├── colab/          Notebooks for GPU processing & persona spawning (ML lab only)
├── config/         routing_schema.ts, matrix.json, filters.json, schema.prisma
├── personamatrix/  Python package: persona loop (filter_director) + APEX billing ledger
├── demo/           TypeScript end-to-end demo
├── tests/          Automated backbone tests
├── package.json
├── tsconfig.json
├── README.md
├── .cursorrules    System Manifest / Constitution
└── .gitignore
```

---

## Phase 1 status

Phase 1 delivers a **functional backbone**, not the full 20,480-node fleet:

| Area                              | Status                                                        |
|-----------------------------------|--------------------------------------------------------------|
| RoutingPacket contract            | ✅ Implemented & enforced (SHA-256 hash + knoll_token)        |
| APEX router                       | ✅ `dispatch()` calls KNOLL before every route                |
| APEX billing ledger               | ✅ In-memory, interface-ready, tracks cost_usd + status       |
| KNOLL validator / laws / audit    | ✅ Hash + token validation, virtual laws, audit trail          |
| HOPE / DREAM / VISION             | ✅ Skeletons that ONLY talk to APEX                            |
| Node matrix definitions           | ✅ Managers/nodes/personas + lifecycle + constants            |
| personamatrix (Python)            | ✅ filter_director spawn/execute/terminate + ledger           |
| Colab lab                         | ✅ Setup/validation script + parameter-tuning notes           |
| Docker/gVisor sandbox internals   | ⚠️ Stubbed (safe placeholders) — see limitations             |
| Prisma persistence                | ⚠️ Schema defined; runtime uses in-memory stores in Phase 1  |
| Real 7B model inference           | ⚠️ Conceptual only                                            |

---

## Requirements

- Node.js ≥ 20 (developed on Node 22)
- Python ≥ 3.10 (standard library only for Phase 1)

## Install

```bash
cd big5-matrix
npm install
```

## Commands

```bash
npm run typecheck    # tsc --noEmit — MUST be zero errors
npm run demo         # end-to-end routing + KNOLL block + tampered-hash demo
npm test             # automated backbone tests
npm run python:demo  # persona loop + billing ledger (python3)
```

### What the demo shows

1. HOPE parses a natural-language request into a structured intent.
2. APEX wraps it in a `RoutingPacket`, calls KNOLL, and (if allowed) routes to DREAM.
3. DREAM simulates outcomes; results return **via APEX** (never directly).
4. The APEX ledger records `cost_usd` for the ephemeral execution.
5. KNOLL **blocks** an illegal direct `DREAM → VISION` packet.
6. KNOLL **blocks** a packet with a tampered SHA-256 hash.

---

## License

UNLICENSED — internal Phase 1 scaffold.
