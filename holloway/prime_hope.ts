/**
 * holloway/prime_hope.ts — PRIME HOPE, the governance apex reader of the sovereign ledger.
 *
 * PRIME HOPE is deliberately DISTINCT from every other "Hope" in the system:
 *
 *   - Core Hope       — the HOPE interface agent (`hope/`), the master interpreter. It parses
 *                       intent and speaks the system's voice. It has NO governance authority
 *                       and cannot read the Designated Audit Ledger.
 *   - Reflected Hope  — any mirrored / derived instance of the HOPE agent (e.g. a per-tenant
 *                       or per-session projection of Core Hope). Also non-sovereign.
 *   - PRIME HOPE      — the governance apex. It does NOT interpret, execute, or route. Its
 *                       single privilege is read access to the Designated Audit Ledger, as the
 *                       final oversight eye over sovereign overrides and out-of-band decisions.
 *
 * PRIME HOPE therefore never appears as a RoutingPacket endpoint and holds no AgentRole. It is
 * a sovereign-layer construct, and this module (like the rest of holloway/) imports no peer
 * agent module.
 */

/** The canonical PRIME HOPE token used at the ledger read boundary. */
export const PRIME_HOPE = 'PRIME_HOPE' as const;

/** The literal type of the PRIME HOPE token. */
export type PrimeHopeToken = typeof PRIME_HOPE;

/**
 * PrimeHopeIdentity — a richer, optional description of the PRIME HOPE principal.
 *
 * The ledger's `read` boundary accepts the bare {@link PRIME_HOPE} token; this identity exists
 * for callers that want to attach a stable id/name for their own audit trails. `kind` is fixed
 * so a PrimeHopeIdentity can never be confused with a `HollowayIdentity`.
 */
export interface PrimeHopeIdentity {
  readonly kind: 'PRIME_HOPE';
  readonly id: string;
  readonly name: string;
}

/** Construct a PRIME HOPE identity descriptor. */
export function primeHope(id = 'prime-hope', name = 'Prime Hope'): PrimeHopeIdentity {
  return { kind: 'PRIME_HOPE', id, name };
}

/** Runtime guard: is `value` the PRIME HOPE token? */
export function isPrimeHopeToken(value: unknown): value is PrimeHopeToken {
  return value === PRIME_HOPE;
}

/** Runtime guard: is `value` a PrimeHopeIdentity descriptor? */
export function isPrimeHopeIdentity(value: unknown): value is PrimeHopeIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'PRIME_HOPE'
  );
}
