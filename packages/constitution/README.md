# `@big5-matrix/constitution`

> The public **law book** of the Big 5 Matrix (HDV Foundation) — the open-core seam.

This package is the small, dependency-free surface every integrator must honor: the
**RoutingPacket** contract, the **AgentRole** vocabulary, the **KNOLL law names**, the
**ledger field list**, and the **always-on / ephemeral lifecycle map**. It contains **no
agent internals** — no router, no KNOLL engine, no node fleet, no scorer. You can build a
fully compliant client on top of it, and you can *read and verify* the rules, but you can
never *weaken* them from here.

It exists to make the project **open-core**:

- **Open** — the constitution (this kit) and the contracts anyone must speak to interoperate.
- **Core (proprietary)** — the engine that enforces them: `apex/` (router), `knoll/`
  (auditor + behavioral scorer), `dream/` · `vision/` (workers), `nodes/` (the 20,480-node
  fleet), billing, and tenancy.

Publishing this kit lets third parties, auditors, and downstream SDKs depend on a stable,
inspectable governance surface **without** shipping — or being able to fork and defang — the
enforcement engine.

---

## Why this is safe to open

The constitution is **declarative and additive-only**. Nothing in this package can allow a
packet that the engine would block; it only *describes* what "legal" means. The actual gate
(`KNOLL.intercept` in `knoll/validator.ts`) is the sole authority, and it is not in this
package. See [`docs/MOAT.md`](../../docs/MOAT.md) for why the moat survives being open.

---

## The four public artifacts

### 1. `RoutingPacket` — the one legal transport structure

Every byte that moves between agents is a `RoutingPacket`. If data passed between agents does
not strictly adhere to this interface, **the system is considered compromised** and the packet
is blocked. Source of truth: [`config/routing_schema.ts`](../../config/routing_schema.ts).

```ts
enum AgentRole { HOPE = 'HOPE', DREAM = 'DREAM', VISION = 'VISION', KNOLL = 'KNOLL', APEX = 'APEX' }

type PacketPriority = 'CRITICAL' | 'STANDARD' | 'BACKGROUND';
type RoutingStatus  = 'SUCCESS'  | 'BLOCKED'  | 'FAILED';

interface RoutingPacket {
  header: {
    packetId: string;
    timestamp: number;
    source: AgentRole;
    destination: AgentRole;
    priority: PacketPriority;
  };
  payload: {
    intent: string;
    data: Record<string, unknown>;
  };
  security: {
    knoll_token: string; // present + well-formed (LAW 1)
    hash: string;        // SHA-256 over canonical (header + payload) — tamper detection
  };
}

interface KnollValidationResponse {
  isAllowed: boolean;
  reasoning?: string;
  enforcedConstraints?: string[]; // e.g. ['NO_DIRECT_DREAM_VISION'], ['HASH_INTEGRITY']
}
```

### 2. `AgentRole` — the only legal packet endpoints

The five Big AI roles. These are the **only** values allowed in `header.source` /
`header.destination`.

| Role     | Layer         | Lifecycle   | May execute | May create | May govern |
| -------- | ------------- | ----------- | ----------- | ---------- | ---------- |
| `HOPE`   | interface     | `ALWAYS_ON` | ✗           | ✗          | ✗          |
| `KNOLL`  | security      | `ALWAYS_ON` | ✗           | ✗          | ✓ (audit)  |
| `APEX`   | orchestration | `ALWAYS_ON` | ✗           | ✗          | ✓ (route)  |
| `DREAM`  | simulation    | `EPHEMERAL` | ✗           | ✓          | ✗          |
| `VISION` | action        | `EPHEMERAL` | ✓           | ✗          | ✗          |

The kit exports this as `AGENT_LIFECYCLE`, `ALWAYS_ON_ROLES`, and `EPHEMERAL_ROLES`.

### 3. KNOLL law names — the stable verdict vocabulary

The six hard "virtual laws" run in order; KNOLL blocks on the first failure. Their names
appear verbatim in `KnollValidationResponse.enforcedConstraints`. Exported as
`KNOLL_LAW_NAMES`.

| #   | Name                     | Guarantee                                                             |
| --- | ------------------------ | -------------------------------------------------------------------- |
| 1   | `TOKEN_WELL_FORMED`      | `security.knoll_token` is present and structurally well-formed.       |
| 2   | `VALID_ENDPOINTS`        | source/destination are distinct, valid roles (no self-addressing).   |
| 3   | `NO_DIRECT_DREAM_VISION` | DREAM and VISION never communicate directly, in either direction.    |
| 4   | `NO_KNOLL_FORGERY`       | No agent may forge `KNOLL` as a packet source.                        |
| 5   | `HOPE_CANNOT_COMMAND`    | HOPE routes intent via APEX; it can't directly target DREAM/VISION.  |
| 6   | `NO_MALICIOUS_INTENT`    | Heuristic block over the intent + string payload values.             |

Structural / cross-cutting guards that run **around** the six laws (exported as
`KNOLL_GUARD_NAMES`): `STRUCTURE`, `HASH_INTEGRITY`, `RATE_LIMIT`, `BEHAVIORAL_SCORE`. The
behavioral scorer is **strictly additive** — it can raise suspicion and deny, but can never
turn a hard-law `BLOCK` into an `ALLOW`.

### 4. Ledger field list — the auditable accounting row

Every packet APEX attempts to route produces exactly one ledger row (`RequestLog`). Exported
as `LEDGER_FIELDS`; source of truth: [`config/schema.prisma`](../../config/schema.prisma) and
[`apex/ledger.ts`](../../apex/ledger.ts).

```
id · packetId · timestamp · source · destination · status · cost_usd · knollSignature
```

`status ∈ { SUCCESS, BLOCKED, FAILED }`. `cost_usd` is metered by **active-parameter-seconds**
(see the pricing model in [`config/pricing.json`](../../config/pricing.json)).

---

## Usage

```ts
import {
  AgentRole,
  KNOLL_LAW_NAMES,
  LEDGER_FIELDS,
  AGENT_LIFECYCLE,
  EPHEMERAL_ROLES,
  type RoutingPacket,
  type KnollValidationResponse,
} from '@big5-matrix/constitution';

// Build a compliant envelope your client will hand to the gateway (HOPE → APEX only).
function draft(intent: string): Pick<RoutingPacket, 'header' | 'payload'> {
  return {
    header: {
      packetId: crypto.randomUUID(),
      timestamp: Date.now(),
      source: AgentRole.HOPE,
      destination: AgentRole.APEX,
      priority: 'STANDARD',
    },
    payload: { intent, data: {} },
  };
}

// EPHEMERAL_ROLES scale to zero when idle — the always-on trio stays tiny.
console.log('workers that scale to zero:', EPHEMERAL_ROLES); // [DREAM, VISION]
```

> The kit deliberately does **not** compute `security.hash` or mint `knoll_token` for you —
> those are stamped by APEX (`apex/packet.ts`) so no external party can forge a valid
> envelope. Clients submit intent to the gateway; the engine mints the legal packet.

---

## Infinite-scale narrative (why the split works commercially)

The always-on trio — **HOPE, KNOLL, APEX** — is deliberately tiny and cheap: three resident
processes. Everything expensive is **EPHEMERAL** and scales to **zero** when idle:

- DREAM/VISION workers materialize per claim and are torn down on completion.
- The 20,480-node fleet (× 100 personas × conceptual 7B ⇒ ~14.3 quadrillion parameters) is a
  **scheduling substrate**, not a resident cost. Idle personas draw ≈ zero compute, so you
  bill by **active**-parameter-seconds, not by fleet size.

Open-sourcing the constitution grows the ecosystem (SDKs, tools, audits) while the metered,
always-on-tiny / workers-to-zero engine stays the commercial core. See
[`docs/SCALE.md`](../../docs/SCALE.md) and [`docs/GTM.md`](../../docs/GTM.md).

---

## Publishing

This kit lives inside the monorepo and re-exports from `config/` so it can **never drift**
from what the running app enforces. To publish it standalone:

1. Vendor the source-of-truth file: copy `config/routing_schema.ts` →
   `packages/constitution/routing_schema.ts`.
2. Repoint `index.ts` re-exports from `../../config/routing_schema.js` to
   `./routing_schema.js`.
3. `npm publish` (the package is already `type: module`, dependency-free, and `access: public`).

A CI check should diff the vendored copy against `config/routing_schema.ts` and fail on
divergence, and `tests/eval.test.ts` already asserts `KNOLL_LAW_NAMES` matches the real laws
in `knoll/laws.ts`.

---

_Part of the Big 5 Agent Hierarchy (HDV Foundation). The six laws + `RoutingPacket` are the
immovable core; this kit is the public face of that core._
