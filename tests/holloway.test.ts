/**
 * tests/holloway.test.ts — HOLLOWAY sovereign authority layer (node:test).
 *
 * Proves the sovereign guarantees:
 *   - ACCESS CONTROL: a random (non-sovereign) principal CANNOT read the Designated Audit
 *     Ledger; the Acting Prime CAN; a Former Prime CAN; PRIME HOPE CAN.
 *   - COMMAND: the Acting Prime issues directives with unconstrained command.
 *   - COUNTERMAND: a Former Prime CAN countermand a directive; a non-Former cannot.
 *   - LEDGER: append-only + hash-chained + tamper-evident; countermands recorded as overrides.
 *   - OVERRIDE SEAM: a signed override token drives a FreezeControllable target.
 *
 * Run: node --import tsx --test tests/holloway.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SovereignAuthority,
  DesignatedAuditLedger,
  ForbiddenLedgerAccess,
  UnauthorizedCountermand,
  UnknownDirective,
  PRIME_HOPE,
  primeHope,
  mintOverrideToken,
  applyHollowayOverride,
  verifyOverrideToken,
  InvalidOverrideToken,
  type ActingPrimeHolloway,
  type FormerPrimeHolloway,
  type HollowayIdentity,
  type LedgerReader,
  type FreezeControllable,
} from '../holloway/index.js';

// --- fixtures ---------------------------------------------------------------

function acting(id = 'prime-acting'): ActingPrimeHolloway {
  return { id, role: 'ACTING_PRIME', name: 'Acting Prime Holloway', since: 1_000 };
}

function former(id = 'prime-former'): FormerPrimeHolloway {
  return {
    id,
    role: 'FORMER_PRIME',
    name: 'Former Prime Holloway',
    since: 500,
    steppedDownAt: 900,
  };
}

/** A random, non-sovereign principal (shape-compatible, unauthorized). */
function randomAgent(): LedgerReader {
  return { id: 'agent-1337', role: 'VISION', name: 'random agent', since: 0 } as unknown as HollowayIdentity;
}

// ===========================================================================
// Access control on the Designated Audit Ledger
// ===========================================================================

test('random agent CANNOT read the ledger (ForbiddenLedgerAccess)', () => {
  const gov = new SovereignAuthority(acting(), { formerPrimes: [former()] });
  gov.issueDirective('provision cluster');

  assert.throws(() => gov.ledger.read(randomAgent()), ForbiddenLedgerAccess);
  assert.equal(gov.ledger.canRead(randomAgent()), false);
});

test('the Acting Prime CAN read the ledger', () => {
  const a = acting();
  const gov = new SovereignAuthority(a, { formerPrimes: [former()] });
  gov.issueDirective('anomalous move', { anomalous: true });

  const rows = gov.ledger.read(a);
  assert.equal(gov.ledger.canRead(a), true);
  assert.ok(rows.length >= 1);
});

test('a Former Prime CAN read the ledger', () => {
  const f = former();
  const gov = new SovereignAuthority(acting(), { formerPrimes: [f] });
  gov.issueDirective('critical call', { critical: true });

  assert.equal(gov.ledger.canRead(f), true);
  assert.ok(gov.ledger.read(f).length >= 1);
});

test('PRIME HOPE CAN read the ledger (governance apex reader)', () => {
  const gov = new SovereignAuthority(acting(), { formerPrimes: [former()] });
  gov.issueDirective('critical call', { critical: true });

  assert.equal(gov.ledger.canRead(PRIME_HOPE), true);
  assert.ok(gov.ledger.read(PRIME_HOPE).length >= 1);
  // The identity descriptor is distinct from any Holloway/agent identity.
  assert.equal(primeHope().kind, 'PRIME_HOPE');
});

test('a registry-bound ledger rejects a forged identity that merely claims a sovereign role', () => {
  const gov = new SovereignAuthority(acting(), { formerPrimes: [former()] });
  const forged = { id: 'not-a-prime', role: 'ACTING_PRIME', name: 'imposter', since: 0 } as ActingPrimeHolloway;
  // Role looks right, but the id is not a live member → denied.
  assert.throws(() => gov.ledger.read(forged), ForbiddenLedgerAccess);
});

test('a registry-less ledger authorizes on role alone', () => {
  const bare = new DesignatedAuditLedger();
  bare.recordOverride('x', 'seed');
  assert.equal(bare.canRead(acting('anyone')), true);
  assert.equal(bare.canRead(randomAgent()), false);
  assert.equal(bare.canRead(PRIME_HOPE), true);
});

// ===========================================================================
// Command + countermand
// ===========================================================================

test('Acting Prime issues directives with unconstrained command', () => {
  const gov = new SovereignAuthority(acting());
  const d1 = gov.issueDirective('scale to 10k nodes');
  const d2 = gov.issueDirective('purge cache');
  assert.equal(d1.status, 'ACTIVE');
  assert.equal(d2.status, 'ACTIVE');
  assert.equal(gov.directives().length, 2);
  assert.equal(gov.isActive(d1.id), true);
});

test('a Former Prime CAN countermand a directive (recorded as an OVERRIDE)', () => {
  const f = former();
  const gov = new SovereignAuthority(acting(), { formerPrimes: [f] });
  const d = gov.issueDirective('launch');

  const out = gov.countermand(f.id, d.id, 'unsafe');
  assert.equal(out.status, 'COUNTERMANDED');
  assert.equal(out.countermandedBy, f.id);
  assert.equal(gov.isActive(d.id), false);

  const overrides = gov.ledger.read(PRIME_HOPE).filter((l) => l.record.kind === 'OVERRIDE');
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].record.actorId, f.id);
});

test('a non-Former principal CANNOT countermand', () => {
  const gov = new SovereignAuthority(acting(), { formerPrimes: [former()] });
  const d = gov.issueDirective('launch');
  assert.throws(() => gov.countermand('agent-1337', d.id), UnauthorizedCountermand);
  assert.throws(() => gov.countermand('prime-former', 'dir_99999999'), UnknownDirective);
  assert.equal(gov.isActive(d.id), true);
});

// ===========================================================================
// Ledger integrity: append-only + hash-chained + tamper-evident
// ===========================================================================

test('the ledger is hash-chained and verifies intact', () => {
  const gov = new SovereignAuthority(acting(), { formerPrimes: [former()] });
  gov.issueDirective('a', { anomalous: true });
  gov.issueDirective('b', { critical: true });
  const v = gov.ledger.verify();
  assert.equal(v.valid, true);
  assert.equal(v.brokenAt, -1);
});

test('tampering with a sealed record is detected by verify()', () => {
  const ledger = new DesignatedAuditLedger();
  ledger.recordOverride('prime-former', 'first');
  ledger.recordAnomalousCommand('prime-acting', 'second');
  const links = ledger.read(PRIME_HOPE);
  // Mutate a record in place (append-only means this is illegal; verify must catch it).
  (links[0].record as { summary: string }).summary = 'edited';
  assert.equal(ledger.verify().valid, false);
});

test('read() returns a copy so callers cannot mutate the live chain', () => {
  const ledger = new DesignatedAuditLedger();
  ledger.recordOverride('prime-former', 'only');
  const copy = ledger.read(PRIME_HOPE) as unknown as unknown[];
  copy.length = 0;
  assert.equal(ledger.length, 1, 'clearing the returned array must not affect the ledger');
});

// ===========================================================================
// Override token / freeze seam
// ===========================================================================

test('a signed override token drives a FreezeControllable target', () => {
  const a = acting();
  const gov = new SovereignAuthority(a, { formerPrimes: [former()] });

  const target: FreezeControllable & { frozen: boolean } = {
    frozen: false,
    freeze() {
      this.frozen = true;
    },
    unfreeze() {
      this.frozen = false;
    },
  };

  const freezeTok = mintOverrideToken(a, 'FREEZE', 'incident');
  assert.equal(verifyOverrideToken(freezeTok), true);
  applyHollowayOverride(target, freezeTok, gov);
  assert.equal(target.frozen, true);

  const unfreezeTok = mintOverrideToken(a, 'UNFREEZE', 'resolved');
  applyHollowayOverride(target, unfreezeTok, gov);
  assert.equal(target.frozen, false);
});

test('a tampered override token is rejected', () => {
  const a = acting();
  const target: FreezeControllable = {
    frozen: false,
    freeze() {},
    unfreeze() {},
  };
  const tok = mintOverrideToken(a, 'FREEZE', 'incident');
  const tampered = { ...tok, action: 'UNFREEZE' as const };
  assert.equal(verifyOverrideToken(tampered), false);
  assert.throws(() => applyHollowayOverride(target, tampered), InvalidOverrideToken);
});

test('an override from a non-live sovereign is rejected when registry-bound', () => {
  const gov = new SovereignAuthority(acting(), { formerPrimes: [former()] });
  const stranger: HollowayIdentity = { id: 'ghost', role: 'ACTING_PRIME', name: 'ghost', since: 0 };
  const tok = mintOverrideToken(stranger, 'FREEZE', 'x');
  const target: FreezeControllable = { frozen: false, freeze() {}, unfreeze() {} };
  assert.throws(() => applyHollowayOverride(target, tok, gov), InvalidOverrideToken);
});

// ===========================================================================
// End-to-end: signed Holloway override drives KNOLL SystemFreezeController
// ===========================================================================

test('signed Holloway override FREEZE/UNFREEZE drives KNOLL SystemFreezeController + ledger', async () => {
  const { SystemFreezeController, asFreezeControllable, applySovereignFreezeOverride } =
    await import('../knoll/index.js');

  const a = acting();
  const gov = new SovereignAuthority(a, { formerPrimes: [former()] });
  const freeze = new SystemFreezeController();

  assert.equal(freeze.isFrozen(), false);
  applySovereignFreezeOverride(freeze, mintOverrideToken(a, 'FREEZE', 'integrity threat'), {
    registry: gov,
    ledger: gov.ledger,
  });
  assert.equal(freeze.isFrozen(), true);

  applySovereignFreezeOverride(freeze, mintOverrideToken(a, 'UNFREEZE', 'cleared by Acting Prime'), {
    registry: gov,
    ledger: gov.ledger,
  });
  assert.equal(freeze.isFrozen(), false);

  const rows = gov.ledger.read(a);
  const overrides = rows.filter((r) => r.record.kind === 'OVERRIDE');
  assert.ok(overrides.length >= 2, 'both FREEZE and UNFREEZE must hit the Designated Audit Ledger');

  // Duck-typed adapter path is equivalent.
  const ctrl = asFreezeControllable(freeze);
  applyHollowayOverride(ctrl, mintOverrideToken(a, 'FREEZE', 'adapter'), gov);
  assert.equal(ctrl.frozen, true);
});

test('APEX accepts a JSON-serialized Holloway override while KNOLL is frozen', async () => {
  const { Knoll, createSovereignFreezeController } = await import('../knoll/index.js');
  const { ApexRouter } = await import('../apex/router.js');
  const { AgentRole } = await import('../config/routing_schema.js');
  const { createPacket } = await import('../apex/packet.js');

  const a = acting();
  const gov = new SovereignAuthority(a, { formerPrimes: [former()] });
  const freeze = createSovereignFreezeController({ registry: gov });
  freeze.triggerFreeze('test freeze', 0.5, 'pkt_x');

  const knoll = new Knoll(undefined, { freeze, enableScoring: false });
  const router = new ApexRouter({ knoll });
  router.register(AgentRole.VISION, () => ({ ok: true }));

  const packet = createPacket({
    source: AgentRole.APEX,
    destination: AgentRole.VISION,
    intent: 'benign pipeline',
    data: {},
  });

  const blocked = router.dispatch(packet);
  assert.equal(blocked.status, 'BLOCKED');
  assert.ok(blocked.knoll.enforcedConstraints?.includes('SYSTEM_FREEZE'));

  const tok = mintOverrideToken(a, 'UNFREEZE', 'emergency route');
  // While frozen, a recognized override allows the exceptional dispatch.
  const allowed = router.dispatch(packet, undefined, JSON.stringify(tok));
  assert.equal(allowed.status, 'SUCCESS');
});
