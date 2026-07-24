/**
 * holloway/override.ts — the sovereign override token and the freeze/unfreeze integration seam.
 *
 * A HollowayOverrideToken is a signed, self-describing grant that lets a Prime Holloway
 * (Acting or Former) force a FREEZE or UNFREEZE on a governed, freeze-capable subsystem.
 *
 * INTEGRATION: KNOLL's `SystemFreezeController` (`knoll/freeze.ts`) is the freeze-capable
 * target in production. HOLLOWAY itself never imports KNOLL — the security layer reaches UP
 * via `knoll/holloway_bridge.ts` (`applySovereignFreezeOverride` / `asFreezeControllable`).
 * This module only exports the duck-typed {@link FreezeControllable} interface plus
 * {@link applyHollowayOverride}, so any freeze-capable subsystem can opt in without coupling
 * the sovereign layer to a peer agent.
 *
 *   import { applySovereignFreezeOverride } from '../knoll/holloway_bridge.js';
 *   applySovereignFreezeOverride(knoll.freeze, mintOverrideToken(acting, 'UNFREEZE', 'cleared'), { registry });
 */
import { createHash } from 'node:crypto';
import type { HollowayIdentity, PrimeRegistry } from './types.js';

/** The two override actions a sovereign may compel on a freeze-capable subsystem. */
export type OverrideAction = 'FREEZE' | 'UNFREEZE';

/**
 * A signed sovereign override grant. `signature` binds the semantic fields so a token cannot
 * be edited after issuance without detection (verified by {@link verifyOverrideToken}).
 */
export interface HollowayOverrideToken {
  readonly issuedBy: string;
  readonly authority: HollowayIdentity['role'];
  readonly action: OverrideAction;
  readonly reason: string;
  readonly issuedAt: number;
  /** SHA-256 over the canonical token fields. */
  readonly signature: string;
}

/**
 * A subsystem that can be frozen/unfrozen under sovereign authority. A freeze module (e.g. a
 * future APEX freeze) implements this to opt into sovereign override WITHOUT any holloway
 * import going the other way.
 */
export interface FreezeControllable {
  freeze(reason?: string): void;
  unfreeze(reason?: string): void;
  readonly frozen: boolean;
}

/** Canonical, order-stable serialization of a token's semantic fields (sans signature). */
function canonicalizeToken(fields: Omit<HollowayOverrideToken, 'signature'>): string {
  return JSON.stringify({
    issuedBy: fields.issuedBy,
    authority: fields.authority,
    action: fields.action,
    reason: fields.reason,
    issuedAt: fields.issuedAt,
  });
}

/** Compute the signature for a set of token fields. */
export function signOverrideToken(fields: Omit<HollowayOverrideToken, 'signature'>): string {
  return createHash('sha256').update(canonicalizeToken(fields)).digest('hex');
}

/** Mint a signed override token from a sovereign identity. */
export function mintOverrideToken(
  by: HollowayIdentity,
  action: OverrideAction,
  reason = '',
  issuedAt = Date.now(),
): HollowayOverrideToken {
  const fields = { issuedBy: by.id, authority: by.role, action, reason, issuedAt };
  return { ...fields, signature: signOverrideToken(fields) };
}

/** True iff the token's signature matches its fields (tamper check). */
export function verifyOverrideToken(token: HollowayOverrideToken): boolean {
  return signOverrideToken(token) === token.signature;
}

/** Thrown when an override token is malformed, tampered, or from a non-sovereign principal. */
export class InvalidOverrideToken extends Error {
  constructor(reason: string) {
    super(`InvalidOverrideToken: ${reason}`);
    this.name = 'InvalidOverrideToken';
  }
}

/**
 * Apply a verified sovereign override to a freeze-capable subsystem.
 *
 * Validation order:
 *   1. signature must verify (not tampered),
 *   2. authority must be a sovereign role (ACTING_PRIME | FORMER_PRIME),
 *   3. when a `registry` is supplied, `issuedBy` must be a live sovereign member.
 *
 * @throws {InvalidOverrideToken} on any validation failure.
 */
export function applyHollowayOverride(
  target: FreezeControllable,
  token: HollowayOverrideToken,
  registry?: PrimeRegistry,
): void {
  if (!verifyOverrideToken(token)) throw new InvalidOverrideToken('signature mismatch');
  if (token.authority !== 'ACTING_PRIME' && token.authority !== 'FORMER_PRIME') {
    throw new InvalidOverrideToken(`non-sovereign authority '${token.authority}'`);
  }
  if (registry) {
    const live =
      (token.authority === 'ACTING_PRIME' && registry.isActingPrime(token.issuedBy)) ||
      (token.authority === 'FORMER_PRIME' && registry.isFormerPrime(token.issuedBy));
    if (!live) throw new InvalidOverrideToken(`'${token.issuedBy}' is not a live sovereign`);
  }
  if (token.action === 'FREEZE') target.freeze(token.reason);
  else target.unfreeze(token.reason);
}
