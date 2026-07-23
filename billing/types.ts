/**
 * billing/types.ts — shared vocabulary for the PRODUCT metering layer (HDV Foundation).
 *
 * This package is the commercial skin on top of the APEX ledger. Where the ledger records
 * what the *system* spent (micro-USD per gated dispatch), billing turns that into a
 * customer-facing ALLOWANCE: a parameter-usage budget with clear cost + occurrence metrics,
 * per tenant, per plan tier.
 *
 * INVARIANTS (constitution-safe): billing NEVER routes, gates, executes, creates, or
 * interprets. It only prices and accounts. The MeterService plugs into APEX's read-only
 * `DispatchObserver` seam (see apex/router.ts) and can never influence a KNOLL verdict or a
 * routing decision — it only meters what already happened.
 */

/** The five commercial plan tiers. BYOK = "Bring Your Own Keys" (pass-through, $0 platform fee). */
export type PlanTier = 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE' | 'BYOK';

/** All plan tiers, in marketing/upgrade order (cheapest → richest, BYOK last). */
export const PLAN_TIERS: readonly PlanTier[] = ['FREE', 'STARTER', 'PRO', 'ENTERPRISE', 'BYOK'] as const;

/** Narrow an arbitrary value to a PlanTier (case-sensitive; callers should upper-case first). */
export function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === 'string' && (PLAN_TIERS as readonly string[]).includes(value);
}

/**
 * What a metered occurrence represents. DISPATCH/SIMULATION/EXECUTION come from the APEX
 * dispatch observer (by destination); ESTIMATE/MANUAL are for the API + admin adjustments;
 * BYOK_PASSTHROUGH marks a $0-platform-fee pass-through occurrence.
 */
export type OccurrenceKind =
  | 'DISPATCH'
  | 'SIMULATION'
  | 'EXECUTION'
  | 'ESTIMATE'
  | 'MANUAL'
  | 'BYOK_PASSTHROUGH';

export const OCCURRENCE_KINDS: readonly OccurrenceKind[] = [
  'DISPATCH',
  'SIMULATION',
  'EXECUTION',
  'ESTIMATE',
  'MANUAL',
  'BYOK_PASSTHROUGH',
] as const;

/**
 * A single billable event on an allowance account — the atomic row of the occurrence log.
 * Carries both the COST view (costUsd) and the OCCURRENCE view (activeParams, durationSec,
 * activeParamSeconds) so a customer can always answer "what did this cost, and why?".
 */
export interface OccurrenceRecord {
  /** Epoch milliseconds when the occurrence was recorded. */
  at: number;
  kind: OccurrenceKind;
  /** ACTIVE parameters lit up (not the 14.3Q conceptual total). */
  activeParams: number;
  /** Billed duration in seconds. */
  durationSec: number;
  /** activeParams × durationSec — the core metering unit. */
  activeParamSeconds: number;
  /** USD attributed to this occurrence (0 for BYOK pass-through with no platform fee). */
  costUsd: number;
  /** Which rate applied: the included rate, the overage rate, a flat charge, or BYOK. */
  rate: RateApplied;
  /** Provider that served the work (e.g. "big5-matrix", "openai", "byok:acme"). */
  provider: string;
  /** Model identifier / size the occurrence ran on (e.g. "7B"). */
  model: string;
  /** False when the occurrence was rejected by the hard cap (logged, not billed). */
  accepted: boolean;
}

/** Which pricing rate produced an occurrence's cost. */
export type RateApplied = 'included' | 'overage' | 'byok';

/** Input to `consume` — describe the work, and billing attributes the cost. */
export interface ConsumeInput {
  /** ACTIVE parameters lit up for this occurrence. */
  activeParams: number;
  /** Billed duration in seconds. */
  durationSec: number;
  /** Occurrence classification. Defaults to 'DISPATCH'. */
  kind?: OccurrenceKind;
  provider?: string;
  model?: string;
  /**
   * Force pass-through billing for this occurrence (BYOK semantics: $0 platform fee). Also
   * implied when the account's tier is BYOK.
   */
  byokPassthrough?: boolean;
  /**
   * When set, use this USD figure instead of the pricing formula. Used by the MeterService
   * fallback: "attribute cost using active-persona estimate × model params when available,
   * else use the ledger cost_usd".
   */
  costOverrideUsd?: number;
  /** Override the record timestamp (tests / replay). Defaults to Date.now(). */
  at?: number;
}

/** Set/adjust an allowance for a tenant. Missing fields fall back to the tier's pricing defaults. */
export interface SetAllowanceInput {
  tier?: PlanTier;
  /** Override the included (prepaid/covered) budget in USD. */
  includedAllowanceUsd?: number;
  /** Override the hard cap in USD. Pass null for "unlimited" (soft cap). */
  hardCapUsd?: number | null;
}

/** A point-in-time projection of a tenant's allowance — the shape returned by GET /v1/billing/usage. */
export interface AllowanceSnapshot {
  tenantId: string;
  tier: PlanTier;
  displayName: string;
  currency: string;
  /** Prepaid / covered budget for the period. */
  includedAllowanceUsd: number;
  /** Absolute ceiling; null = unlimited (soft cap). Over this, non-BYOK consume is rejected. */
  hardCapUsd: number | null;
  /** Total USD attributed to accepted occurrences. */
  spentUsd: number;
  /** hardCap − spent (null when unlimited). */
  remainingUsd: number | null;
  /** How much of the included allowance is left before overage rates kick in. */
  includedRemainingUsd: number;
  /** Spend beyond the included allowance (billed at overage rates). */
  overageUsd: number;
  /** Total occurrences logged (accepted + rejected). */
  occurrenceCount: number;
  acceptedCount: number;
  /** Occurrences refused by the hard cap (logged for visibility, never billed). */
  rejectedCount: number;
  /** Accepted occurrences broken down by kind. */
  occurrencesByKind: Record<string, number>;
  /** Sum of activeParamSeconds across accepted occurrences — the core usage metric. */
  totalActiveParamSeconds: number;
  /** totalActiveParamSeconds / modelParams — usage expressed as "persona-seconds". */
  activePersonaSeconds: number;
  /** True for BYOK tiers (unlimited, $0 platform fee). */
  byok: boolean;
}

/** Result of a single `consume` — did it bill, what did it cost, and the fresh balance. */
export interface ConsumeResult {
  accepted: boolean;
  /** Human-readable reason when rejected (e.g. hard-cap breach). */
  reason?: string;
  costUsd: number;
  record: OccurrenceRecord;
  balance: AllowanceSnapshot;
}
