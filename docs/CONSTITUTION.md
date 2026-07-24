# The HDV Constitution (Audited)

> **Status:** AUTHORITATIVE. This document is the audited constitution for the Big 5 Matrix
> (HDV Foundation). Where it conflicts with any earlier "HOPE = interpreter / interface layer"
> framing, **this document wins.** The binding, machine-enforced surface remains `.cursorrules`
> §0–§7, the `RoutingPacket` contract, and the KNOLL laws in `knoll/laws.ts`; this document is
> their narrative audit and rationale.

The system is governed by one prime directive — **absolute separation of concerns** — realized
through a **Primary Triad** under a **foundational enforcer** (KNOLL), an **orchestration
layer** (APEX), and a **sovereign layer** (HOLLOWAY) above them all. The six sections below are
the audited constitution.

---

## §1 — The Primary Triad (absolute separation of duty)

The Primary Triad is **HOPE, VISION, DREAM**. Each owns **exactly one duty at 100%** and is
**FORBIDDEN the other two**. There is no "temporary" or "for convenience" exception.

```
AUTHORITY FLOWS DOWNWARD                          MEMORY RETURNS UPWARD
─────────────────────────                        ─────────────────────
   HOPE   — 100% GOVERNANCE                                 ▲
     │      rule-making · policy · system direction         │  results,
     ▼      (CANNOT execute · CANNOT create)                 │  learnings,
   VISION — 100% EXECUTION                                   │  audit — all
     │      pipelines · processing · delivery                │  return upward
     ▼      (CANNOT govern · CANNOT create)                  │  to HOPE, which
   DREAM  — 100% CREATION                                    │  governs on them
            generative · UI · content                       │
            (CANNOT govern · CANNOT execute) ───────────────┘
```

| Role     | Duty (100%) | FORBIDDEN                | Lifecycle   |
| -------- | ----------- | ------------------------ | ----------- |
| `HOPE`   | GOVERNANCE  | EXECUTION, CREATION      | `ALWAYS_ON` |
| `VISION` | EXECUTION   | GOVERNANCE, CREATION     | `EPHEMERAL` |
| `DREAM`  | CREATION    | GOVERNANCE, EXECUTION    | `EPHEMERAL` |

- **HOPE is the governance voice.** Interpreting a user utterance into structured intent and
  documenting it is a *governance* function — deciding *what the user means* and *what the
  system should be directed to do*. HOPE never runs a tool (execution) and never fabricates an
  artifact (creation). Direction flows down to APEX, which routes it.
- **VISION is execution.** It runs sandboxed pipelines and returns results upward via APEX. It
  sets no policy and creates no generative content.
- **DREAM is creation.** It renders generative / UI / content possibilities and returns them
  upward via APEX. It sets no policy and executes nothing.

**Machine enforcement.** KNOLL LAW 8 `PRIMARY_TRIAD_DUTY` blocks any packet that asks a triad
destination to perform a forbidden duty (HOPE to execute/create, VISION to govern/create, DREAM
to govern/execute). The duty vocabulary — `PRIMARY_TRIAD`, `AUTHORITY_FLOW`, `ROLE_DUTY`,
`ROLE_DUTY_PERCENT`, and the per-role `FORBIDDEN` map — is the single source of truth in
[`config/duty.ts`](../config/duty.ts) and is re-exported by the public kit
[`@big5-matrix/constitution`](../packages/constitution/index.ts).

---

## §2 — KNOLL: the foundational entity (34% active-router threshold)

KNOLL (Kinetic Node of Operational Locks and Limiters) is **not** a member of the Primary
Triad. It is an **independent foundational entity** performing **active routing enforcement**
on every packet. APEX MUST call `KNOLL.intercept(packet)` **before** every route; a
`isAllowed: false` verdict drops the packet and logs it BLOCKED. KNOLL never mutates a packet
to make it pass — it only allows or denies (`.cursorrules` §2).

KNOLL is an **active router, not a passive observer.** Its behavioral scorer applies an
aggressive **34% (0.34) deny threshold**: any packet whose behavioral-anomaly score reaches
34% is denied and escalated (system FREEZE + packet QUARANTINE). The Shannon-entropy feature
(`knoll/features.ts` `intentEntropy`) is a key contributor that can push a high-entropy,
exfiltration-shaped blob across the 34% line. See `knoll/scoring.ts` and `knoll/freeze.ts`.

> **Boundary note (this change).** The 34% threshold and its wiring are owned by a **sibling
> workstream** and are **not modified here**. This section documents the threshold for the
> audit record only; do not lower it in this changeset.

KNOLL is monitor-only with respect to business work: it governs no policy, executes no task,
and creates no artifact. Its authority is purely to **permit or deny transport** and to emit
the tamper-evident `SecurityAudit` record for every verdict.

---

## §3 — HOLLOWAY: the sovereign authority layer

Above the Big Five sits **HOLLOWAY**, the sovereign layer (`holloway/`). It is **not a peer
agent**; by constitution it imports no peer-agent module and is dependency-free (`node:crypto`
only), so it can never be captured by, or coupled to, the layers it governs.

There are exactly two sovereign roles:

- **Acting Prime Holloway** — the single, currently-serving sovereign. Issues directives with
  command over the governed layers. The ONLY check on that command is a Former Prime's
  countermand.
- **Former Prime Holloway** — a past sovereign holding no command authority but retaining the
  **sovereign veto** (countermand) and read access to the **Designated Audit Ledger**.

Authority is derived from a stable, unforgeable `id` and verified against the `PrimeRegistry`
(live membership), **never** from a display name. Overrides are gated by unforgeable tokens
(`holloway/override.ts`); a forged or tampered identity/token is rejected. See
[`holloway/types.ts`](../holloway/types.ts) and `holloway/sovereign.ts`.

---

## §4 — Topology (the matrix)

The compute substrate is a fixed, auditable topology (`nodes/constants.ts`):

```
Under each of the 5 Big AI: 4,096 nodes = 64 sub-AI managers × 64 nodes each
Total across the Big 5:     20,480 nodes
Each node hosts:            100 ephemeral personas (spawn → execute → terminate)
Each persona:               a conceptual 7B model
20,480 × 100 × 7,000,000,000 ≈ 1.4336 × 10^16 ≈ 14.3 quadrillion parameters
```

The topology is a **scheduling substrate, not a resident cost.** The always-on trio — **HOPE,
KNOLL, APEX** — is tiny and cheap; **DREAM and VISION** (and their entire node matrix) are
**EPHEMERAL**, materializing per claim and scaling back to zero. Idle personas draw ≈ zero
compute, so billing is by **active-parameter-seconds**, not fleet size (`config/pricing.json`,
`apex/ledger.ts`). The lifecycle map (`AGENT_LIFECYCLE`, `ALWAYS_ON_ROLES`, `EPHEMERAL_ROLES`)
is exported by the public kit.

---

## §5 — Reflected Hopes

A **Reflected Hope** (`hope/reflected/`) is a per-user mirror of HOPE. Reflected Hopes are, by
default, **faithful mirrors** and are strictly isolated:

- **Segmentation.** Each Reflected Hope lives in its own storage namespace and may **never**
  write to the authoritative Core Hope or Prime Hope stores (`hope/reflected/segmentation.ts`).
- **Privacy (opt-in).** Reflected-Hope collection is **OFF by default** — opt-in, never
  opt-out (`hope/reflected/privacy.ts`).
- **The Tactical Intel Exception.** The ONE narrow, deliberate deviation from faithful
  mirroring is a slight manipulation permitted **only** for `SECURITY_VERIFICATION` or `AUDIT`
  (e.g. seeding a canary/honeytoken to detect exfiltration). Every use is logged with actor and
  mandatory justification; it can never be enabled for a non-security purpose and manipulation
  is refused unless the flag is currently enabled (`hope/reflected/intel_exception.ts`).

Because Reflected Hopes are extensions of HOPE, they inherit HOPE's duty: **governance only —
never execution or creation** — and remain subject to every KNOLL law at the gate.

---

## §6 — Legal gates

Only one structure and one path are legal.

**The RoutingPacket contract** (`config/routing_schema.ts`). All inter-agent data MUST be a
`RoutingPacket`. Any deviation = compromised system = packet BLOCKED + `SecurityAudit` entry. A
packet is valid only if `security.hash` is a correct SHA-256 over the canonical (header +
payload), `security.knoll_token` is present and well-formed, `header.source`/`header.destination`
form a legal pair (never DREAM↔VISION), and `header.source` is not forged.

**The legal flow.** No agent talks to another directly:

```
SOURCE ──▶ APEX.dispatch() ──▶ KNOLL.intercept() ──▶ (allowed?) ──▶ DESTINATION
                                     │
                                     └── (blocked) ──▶ SecurityAudit + ledger BLOCKED
```

**The virtual laws** (`knoll/laws.ts`), run in order, blocking on the first failure, plus the
structural guards around them (`STRUCTURE`, `HASH_INTEGRITY`, `RATE_LIMIT`, `BEHAVIORAL_SCORE`):

| #   | Law                      | Guarantee                                                              |
| --- | ------------------------ | --------------------------------------------------------------------- |
| 1   | `TOKEN_WELL_FORMED`      | `security.knoll_token` is present and structurally well-formed.        |
| 2   | `VALID_ENDPOINTS`        | source/destination are distinct, valid roles (no self-addressing).    |
| 3   | `NO_DIRECT_DREAM_VISION` | DREAM and VISION never communicate directly, in either direction.     |
| 4   | `NO_KNOLL_FORGERY`       | No agent may forge `KNOLL` as a packet source.                        |
| 5   | `HOPE_CANNOT_COMMAND`    | HOPE (governance) routes intent via APEX; it never commands DREAM/VISION. |
| 6   | `NO_MALICIOUS_INTENT`    | Heuristic block over the intent + string payload values.              |
| 7   | `NO_CROSS_TENANT`        | A packet may not cross a tenant boundary (Phase 8 isolation).         |
| 8   | `PRIMARY_TRIAD_DUTY`     | Absolute separation of duty: HOPE=govern, VISION=execute, DREAM=create. |

`PRIMARY_TRIAD_DUTY` reads the duty a packet asks its destination to perform — an explicit
`payload.data.duty` (a `DutyClass`) or, failing that, the `payload.data.kind` HOPE `IntentKind`
— and blocks it if that duty is in the destination role's `FORBIDDEN` set. It is additive and
backward-compatible: packets that declare no duty, or that address APEX/KNOLL (outside the
triad), pass — mirroring how `NO_CROSS_TENANT` treats tenant-less packets as dev mode. Like
every KNOLL law it is a pure verdict and never mutates the packet.

Every routed packet produces exactly one ledger row — SUCCESS, BLOCKED, or FAILED — with a
`cost_usd` and the KNOLL signature (`LEDGER_FIELDS`, `apex/ledger.ts`).

---

_Part of the Big 5 Agent Hierarchy (HDV Foundation). The Primary Triad + the eight laws +
`RoutingPacket` are the immovable core; the public kit `@big5-matrix/constitution` is the
inspectable, non-weakening face of that core. See also `.cursorrules`, `docs/GAME_PLAN.md`, and
`docs/ARCHITECTURE.md`._
