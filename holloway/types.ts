/**
 * holloway/types.ts — identity types for the HOLLOWAY sovereign authority layer.
 *
 * HOLLOWAY is the sovereign layer that sits ABOVE the Big 5 (Hope/Dream/Vision/KNOLL/APEX).
 * It is NOT a peer agent and, by constitution, imports no peer agent module (no hope/dream/
 * vision/knoll/apex imports). It is dependency-free (node:crypto only) so it can never be
 * captured by, or coupled to, the layers it governs.
 *
 * There are exactly two kinds of sovereign identity:
 *   - the single ActingPrimeHolloway (currently holding command), and
 *   - zero or more FormerPrimeHolloways (past holders, retaining a countermand veto).
 */

/** The two sovereign roles. There is no third; agents are NOT Holloways. */
export type HollowayRole = 'ACTING_PRIME' | 'FORMER_PRIME';

/**
 * HollowayIdentity — the base identity of a sovereign Prime Holloway.
 *
 * `id` is a stable, unforgeable handle used for all authority checks (ledger reads,
 * countermands, override tokens). Authority is derived from `role` and, where a registry is
 * available, from membership — never from a display `name`.
 */
export interface HollowayIdentity {
  /** Stable sovereign identifier (used for every authority check). */
  readonly id: string;
  /** Which sovereign role this identity currently holds. */
  readonly role: HollowayRole;
  /** Human-facing display name (never used for authorization). */
  readonly name: string;
  /** Epoch milliseconds when this identity assumed its current role. */
  readonly since: number;
}

/**
 * ActingPrimeHolloway — the single, currently-serving sovereign.
 *
 * The Acting Prime issues directives with unconstrained command over the governed layers.
 * The ONLY check on that command is a countermand from a Former Prime (see sovereign.ts).
 */
export interface ActingPrimeHolloway extends HollowayIdentity {
  readonly role: 'ACTING_PRIME';
}

/**
 * FormerPrimeHolloway — a past sovereign who has stepped down.
 *
 * A Former Prime holds no command authority but retains the sovereign veto: it may
 * countermand an Acting Prime's directive. It may also read the Designated Audit Ledger.
 */
export interface FormerPrimeHolloway extends HollowayIdentity {
  readonly role: 'FORMER_PRIME';
  /** Epoch milliseconds when this Prime stepped down / handed over authority. */
  readonly steppedDownAt: number;
}

/**
 * PrimeRegistry — the authority source of truth for id-based membership checks.
 *
 * When the Designated Audit Ledger is constructed with a registry it verifies a reader's
 * `id` against live membership (defense against a forged identity that merely *claims* a
 * sovereign role). `SovereignAuthority` implements this interface.
 */
export interface PrimeRegistry {
  /** True iff `id` is the current Acting Prime. */
  isActingPrime(id: string): boolean;
  /** True iff `id` is a registered Former Prime. */
  isFormerPrime(id: string): boolean;
}
