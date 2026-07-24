# HOLLOWAY — Sovereign Authority Layer

HOLLOWAY is the **sovereign layer** that sits *above* the Big 5 agents
(Hope / Dream / Vision / KNOLL / APEX). It is **not** a peer agent: it never appears as a
`RoutingPacket` endpoint, holds no `AgentRole`, and — by constitution — imports **no** peer
agent module (`hope/`, `dream/`, `vision/`, `knoll/`, `apex/`). It depends only on
`node:crypto`, so it can never be captured by, or coupled to, the layers it governs.

## Identities (`holloway/types.ts`)

- **`HollowayIdentity`** — base sovereign identity (`id`, `role`, `name`, `since`). Authority is
  derived from `id`/`role` (and, where a registry is present, membership) — never from `name`.
- **`ActingPrimeHolloway`** — the single, currently-serving sovereign.
- **`FormerPrimeHolloway`** — a past sovereign who stepped down; holds no command but retains
  the countermand veto (`steppedDownAt`).
- **`PrimeRegistry`** — id-based membership source of truth; implemented by `SovereignAuthority`.

## Command & countermand (`holloway/sovereign.ts`)

`SovereignAuthority` models the authority relationship:

- The **Acting Prime** issues directives with **unconstrained command** —
  `issueDirective(command, { data?, anomalous?, critical? })`. There is no approval gate,
  quorum, or rate limit on issuance.
- The **only** check on that command is a **countermand from a Former Prime** —
  `countermand(formerId, directiveId, reason?)`. A Former Prime holds no command power of its
  own but may veto any active directive. A non-Former principal throws `UnauthorizedCountermand`;
  an unknown directive throws `UnknownDirective`.
- Countermands are **overrides** and are written to the Designated Audit Ledger. Directives
  flagged `anomalous` or `critical` are recorded too.
- `succeed(successor)` performs succession: the outgoing Acting Prime becomes a Former Prime
  (retaining the veto), recorded as a critical out-of-band decision.

## Designated Audit Ledger (`holloway/designated_ledger.ts`)

The tamper-evident record of sovereign action. It records three event classes: `OVERRIDE`,
`ANOMALOUS_COMMAND`, and `CRITICAL_OOB_DECISION`.

- **Append-only** — the only mutating method is `record()` (plus the `recordOverride` /
  `recordAnomalousCommand` / `recordCriticalOutOfBand` helpers). There is no update or delete
  surface.
- **Hash-chained** — each link commits to the canonical record content *and* the prior link
  hash (`hash = SHA256(index | prevHash | recordHash)`), the same Merkle-spine pattern as
  `knoll/hashchain.ts`, re-implemented with `node:crypto` to keep HOLLOWAY dependency-free of
  peer modules. `verify()` detects any edit, reorder, insertion, or deletion.
- **Access-controlled read** — `read(reader)` / `readRecords(reader)` accept a
  `HollowayIdentity | 'PRIME_HOPE'`. **Only** the Acting Prime, a Former Prime, or **PRIME
  HOPE** may read; every other principal throws `ForbiddenLedgerAccess`. When constructed with
  a `PrimeRegistry`, a reader's `id` must also be a live member (defends against a forged
  identity that merely *claims* a sovereign role). `read()` returns a copy of the chain so
  callers cannot splice the live log.

## Prime Hope (`holloway/prime_hope.ts`)

**PRIME HOPE** is the governance apex reader of the ledger and is **distinct** from every other
"Hope":

| Name             | What it is                                             | Ledger read? |
| ---------------- | ------------------------------------------------------ | ------------ |
| Core Hope        | the `hope/` interface agent (master interpreter)       | No           |
| Reflected Hope   | any mirrored / derived instance of the HOPE agent      | No           |
| **Prime Hope**   | governance apex; final oversight eye over the ledger   | **Yes**      |

PRIME HOPE does not interpret, execute, or route. Its single privilege is read access to the
Designated Audit Ledger, presented at the read boundary as the `PRIME_HOPE` token.

## Freeze / unfreeze override seam (`holloway/override.ts`)

A `HollowayOverrideToken` is a **signed** grant (`mintOverrideToken`, `verifyOverrideToken`)
that lets a Prime Holloway force a `FREEZE` / `UNFREEZE` on a governed subsystem.

**Integration (live):** KNOLL's `SystemFreezeController` is the freeze-capable target.
HOLLOWAY never imports KNOLL — the security layer reaches up via
`knoll/holloway_bridge.ts`:

- `FreezeControllable` — `{ freeze(reason?), unfreeze(reason?), frozen }`. Duck-typed so any
  freeze module can opt in without HOLLOWAY importing a peer agent.
- `asFreezeControllable(knoll.freeze)` — adapts KNOLL's freeze controller.
- `applySovereignFreezeOverride(freeze, token, { registry?, ledger? })` — verifies the signed
  token, applies FREEZE/UNFREEZE, and optionally records an `OVERRIDE` on the Designated Audit
  Ledger (Acting / Former / Prime Hope only).
- `createSovereignTokenRecognizer(registry?)` — injected into KNOLL by default so APEX can
  accept a signed override (object or JSON string) while the system is frozen.

```ts
import { mintOverrideToken } from '../holloway/index.js';
import { applySovereignFreezeOverride } from '../knoll/holloway_bridge.js';

applySovereignFreezeOverride(
  knoll.freeze,
  mintOverrideToken(actingPrime, 'UNFREEZE', 'integrity restored'),
  { registry: authority, ledger: authority.ledger },
);
```

## Tests

`tests/holloway.test.ts` covers access control (random agent denied; Acting / Former / Prime
Hope allowed), command + countermand (Former can countermand; non-Former cannot), ledger
integrity (hash-chained, tamper-evident, append-only), and the override/freeze seam.
