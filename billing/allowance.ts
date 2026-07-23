/**
 * billing/allowance.ts — per-tenant allowance accounts and their in-memory store.
 *
 * An AllowanceAccount is a customer's parameter-usage budget: a plan tier, an included
 * allowance, a hard cap, a running spend, and an occurrence log. `consume()` prices a unit of
 * work through the PricingBook and either bills it or REJECTS it when it would breach the hard
 * cap — the enforcement point that makes the allowance real. BYOK accounts are unlimited and
 * pass-through ($0 platform fee), so they are never rejected.
 *
 * All state is in-memory: the default `demo` tenant works fully offline with no database.
 * Nothing here routes, gates, or executes — it only prices and accounts.
 */
import type { PricingBook } from './pricing.js';
import type {
  AllowanceSnapshot,
  ConsumeInput,
  ConsumeResult,
  OccurrenceKind,
  OccurrenceRecord,
  PlanTier,
  RateApplied,
  SetAllowanceInput,
} from './types.js';

/** Default cap on how many occurrence records a single account retains (ring-buffer). */
export const DEFAULT_MAX_OCCURRENCES = 1000;

export interface AllowanceAccountOptions {
  /** Override the included allowance (USD). Defaults to the tier's pricing default. */
  includedAllowanceUsd?: number;
  /** Override the hard cap (USD). Pass null for "unlimited". Defaults to the tier's default. */
  hardCapUsd?: number | null;
  /** Ring-buffer size for the occurrence log. */
  maxOccurrences?: number;
}

export class AllowanceAccount {
  readonly tenantId: string;
  private _tier: PlanTier;
  private readonly pricing: PricingBook;
  private includedOverride?: number;
  private hardCapOverride?: number; // Infinity == unlimited
  private readonly maxOccurrences: number;

  private _spentUsd = 0;
  private _acceptedCount = 0;
  private _rejectedCount = 0;
  private _totalActiveParamSeconds = 0;
  private readonly byKind = new Map<OccurrenceKind, number>();
  private readonly log: OccurrenceRecord[] = [];

  constructor(tenantId: string, tier: PlanTier, pricing: PricingBook, options: AllowanceAccountOptions = {}) {
    this.tenantId = tenantId;
    this._tier = tier;
    this.pricing = pricing;
    this.maxOccurrences = options.maxOccurrences && options.maxOccurrences > 0 ? Math.floor(options.maxOccurrences) : DEFAULT_MAX_OCCURRENCES;
    if (options.includedAllowanceUsd !== undefined) this.includedOverride = Math.max(0, options.includedAllowanceUsd);
    if (options.hardCapUsd !== undefined) this.hardCapOverride = options.hardCapUsd === null ? Infinity : Math.max(0, options.hardCapUsd);
  }

  get tier(): PlanTier {
    return this._tier;
  }

  /** Effective included allowance (override or the tier default). */
  get includedAllowanceUsd(): number {
    return this.includedOverride ?? this.pricing.tier(this._tier).includedAllowanceUsd;
  }

  /** Effective hard cap in USD (Infinity == unlimited). */
  get hardCapUsd(): number {
    return this.hardCapOverride ?? this.pricing.tier(this._tier).hardCapUsd;
  }

  get spentUsd(): number {
    return round6(this._spentUsd);
  }

  /** True for BYOK tiers (unlimited, $0 platform fee). */
  get byok(): boolean {
    return this.pricing.tier(this._tier).byokPassthrough;
  }

  /**
   * Set or adjust this account's allowance. Switching tier resets any prior included/hard-cap
   * overrides UNLESS this call also specifies them, so a plan change lands on clean defaults.
   */
  setAllowance(input: SetAllowanceInput): this {
    if (input.tier !== undefined) {
      this._tier = input.tier;
      // Tier change: drop stale overrides so the new tier's published defaults take effect.
      this.includedOverride = undefined;
      this.hardCapOverride = undefined;
    }
    if (input.includedAllowanceUsd !== undefined) this.includedOverride = Math.max(0, input.includedAllowanceUsd);
    if (input.hardCapUsd !== undefined) this.hardCapOverride = input.hardCapUsd === null ? Infinity : Math.max(0, input.hardCapUsd);
    return this;
  }

  /**
   * Price and (if within the hard cap) bill a unit of work. Returns a full result including a
   * fresh balance snapshot. Rejected occurrences are STILL logged (accepted:false) for
   * visibility but never add to spend — the hard cap is a firm ceiling for non-BYOK tiers.
   */
  consume(input: ConsumeInput): ConsumeResult {
    const at = input.at ?? Date.now();
    const kind: OccurrenceKind = input.kind ?? 'DISPATCH';
    const provider = (input.provider ?? 'big5-matrix').trim() || 'big5-matrix';
    const model = (input.model ?? 'unknown').trim() || 'unknown';
    const byok = this.byok || Boolean(input.byokPassthrough);

    const estimate = this.pricing.estimate({
      tier: this._tier,
      activeParams: input.activeParams,
      durationSec: input.durationSec,
      priorSpendUsd: this._spentUsd,
    });
    const activeParams = estimate.activeParams;
    const durationSec = estimate.durationSec;
    const activeParamSeconds = estimate.activeParamSeconds;

    // BYOK: $0 platform fee (or a flat pass-through only) — always accepted, never capped.
    if (byok) {
      const cost = this.byok ? round6(this.pricing.tier(this._tier).passthroughFeeUsd) : 0;
      const record = this.record({
        at,
        kind: this.byok ? 'BYOK_PASSTHROUGH' : kind,
        activeParams,
        durationSec,
        activeParamSeconds,
        costUsd: cost,
        rate: 'byok',
        provider,
        model,
        accepted: true,
      });
      this._spentUsd = round6(this._spentUsd + cost);
      return { accepted: true, costUsd: cost, record, balance: this.balance() };
    }

    const cost = input.costOverrideUsd !== undefined ? round6(Math.max(0, input.costOverrideUsd)) : estimate.costUsd;
    const rate: RateApplied = input.costOverrideUsd !== undefined ? 'included' : estimate.rate;
    const hardCap = this.hardCapUsd;
    const projected = this._spentUsd + cost;

    // Enforcement: refuse work that would push spend past the hard cap.
    if (Number.isFinite(hardCap) && projected > hardCap + 1e-9) {
      const record = this.record({
        at,
        kind,
        activeParams,
        durationSec,
        activeParamSeconds,
        costUsd: cost,
        rate,
        provider,
        model,
        accepted: false,
      });
      return {
        accepted: false,
        reason: `hard cap $${hardCap} would be exceeded: spent $${round6(this._spentUsd)} + $${cost} = $${round6(projected)}`,
        costUsd: cost,
        record,
        balance: this.balance(),
      };
    }

    const record = this.record({
      at,
      kind,
      activeParams,
      durationSec,
      activeParamSeconds,
      costUsd: cost,
      rate,
      provider,
      model,
      accepted: true,
    });
    this._spentUsd = round6(projected);
    return { accepted: true, costUsd: cost, record, balance: this.balance() };
  }

  /** Recent occurrences, newest first, capped at `limit` (default: all retained). */
  occurrences(limit?: number): OccurrenceRecord[] {
    const newestFirst = [...this.log].reverse();
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return newestFirst;
    return newestFirst.slice(0, Math.floor(limit));
  }

  /** A JSON-friendly balance snapshot (the GET /v1/billing/usage shape). */
  balance(): AllowanceSnapshot {
    const p = this.pricing.tier(this._tier);
    const spent = round6(this._spentUsd);
    const hardCap = this.hardCapUsd;
    const included = this.includedAllowanceUsd;
    return {
      tenantId: this.tenantId,
      tier: this._tier,
      displayName: p.displayName,
      currency: this.pricing.currency,
      includedAllowanceUsd: round6(included),
      hardCapUsd: Number.isFinite(hardCap) ? round6(hardCap) : null,
      spentUsd: spent,
      remainingUsd: Number.isFinite(hardCap) ? round6(Math.max(0, hardCap - spent)) : null,
      includedRemainingUsd: round6(Math.max(0, included - spent)),
      overageUsd: round6(Math.max(0, spent - included)),
      occurrenceCount: this.log.length,
      acceptedCount: this._acceptedCount,
      rejectedCount: this._rejectedCount,
      occurrencesByKind: mapToRecord(this.byKind),
      totalActiveParamSeconds: this._totalActiveParamSeconds,
      activePersonaSeconds: round6(this._totalActiveParamSeconds / this.pricing.modelParams),
      byok: this.byok,
    };
  }

  private record(rec: OccurrenceRecord): OccurrenceRecord {
    this.log.push(rec);
    if (this.log.length > this.maxOccurrences) this.log.shift();
    if (rec.accepted) {
      this._acceptedCount += 1;
      this._totalActiveParamSeconds += rec.activeParamSeconds;
      this.byKind.set(rec.kind, (this.byKind.get(rec.kind) ?? 0) + 1);
    } else {
      this._rejectedCount += 1;
    }
    return rec;
  }
}

export interface AllowanceStoreOptions {
  /** Tier assigned to tenants that consume before an allowance is explicitly set. */
  defaultTier?: PlanTier;
  /** Seed the offline `demo` tenant so everything works with no setup. Default true. */
  seedDemo?: boolean;
  /** Tier for the seeded `demo` tenant. Default 'STARTER' (has a hard cap, so caps are demoable). */
  demoTier?: PlanTier;
  maxOccurrences?: number;
}

/**
 * In-memory, per-tenant store of AllowanceAccounts. Unknown tenants are lazily created on the
 * default tier (FREE) so the API never 404s on a fresh tenant; the offline `demo` tenant is
 * seeded up-front so the demo + tests run with zero configuration.
 */
export class AllowanceStore {
  readonly pricing: PricingBook;
  readonly defaultTier: PlanTier;
  private readonly maxOccurrences?: number;
  private readonly accounts = new Map<string, AllowanceAccount>();

  constructor(pricing: PricingBook, options: AllowanceStoreOptions = {}) {
    this.pricing = pricing;
    this.defaultTier = options.defaultTier ?? 'FREE';
    this.maxOccurrences = options.maxOccurrences;
    if (options.seedDemo ?? true) {
      this.setAllowance('demo', { tier: options.demoTier ?? 'STARTER' });
    }
  }

  /** Get (or lazily create on the default tier) the account for a tenant. */
  account(tenantId: string): AllowanceAccount {
    const id = normalizeTenant(tenantId);
    let acct = this.accounts.get(id);
    if (!acct) {
      acct = new AllowanceAccount(id, this.defaultTier, this.pricing, { maxOccurrences: this.maxOccurrences });
      this.accounts.set(id, acct);
    }
    return acct;
  }

  /** True when the tenant already has an account (i.e. is not brand-new). */
  has(tenantId: string): boolean {
    return this.accounts.has(normalizeTenant(tenantId));
  }

  /** Set/adjust a tenant's allowance, creating the account if needed. */
  setAllowance(tenantId: string, input: SetAllowanceInput): AllowanceAccount {
    const id = normalizeTenant(tenantId);
    let acct = this.accounts.get(id);
    if (!acct) {
      const tier = input.tier ?? this.defaultTier;
      acct = new AllowanceAccount(id, tier, this.pricing, {
        includedAllowanceUsd: input.includedAllowanceUsd,
        hardCapUsd: input.hardCapUsd,
        maxOccurrences: this.maxOccurrences,
      });
      this.accounts.set(id, acct);
      return acct;
    }
    acct.setAllowance(input);
    return acct;
  }

  consume(tenantId: string, input: ConsumeInput): ConsumeResult {
    return this.account(tenantId).consume(input);
  }

  balance(tenantId: string): AllowanceSnapshot {
    return this.account(tenantId).balance();
  }

  recentOccurrences(tenantId: string, limit?: number): OccurrenceRecord[] {
    return this.account(tenantId).occurrences(limit);
  }

  /** All known tenant ids (sorted). */
  tenants(): string[] {
    return [...this.accounts.keys()].sort();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalizeTenant(tenantId: string | undefined | null): string {
  const t = (tenantId ?? '').trim();
  return t.length > 0 ? t : 'demo';
}

function mapToRecord(map: Map<OccurrenceKind, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of map) out[k] = v;
  return out;
}

function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}
