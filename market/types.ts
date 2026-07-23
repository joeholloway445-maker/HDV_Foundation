/**
 * market/types.ts — shared vocabulary for the launch waitlist (market/).
 *
 * The `market/` package is a thin GO-TO-MARKET surface: it captures inbound interest (waitlist
 * signups) and reports aggregate signup stats. It is NOT one of the Big 5 agents and holds no
 * routing, security, or execution logic. It NEVER talks to APEX/KNOLL/HOPE/DREAM/VISION, never
 * routes a RoutingPacket, and never spends the APEX ledger — it only collects contact intent so
 * the team can follow up at launch. Everything here is in-memory and dependency-free.
 */

/** Recognised acquisition sources for a signup. Free-form strings are normalised to `other`. */
export type WaitlistSource =
  | 'marketing'
  | 'waitlist-page'
  | 'api'
  | 'referral'
  | 'demo'
  | 'other';

export const WAITLIST_SOURCES: readonly WaitlistSource[] = [
  'marketing',
  'waitlist-page',
  'api',
  'referral',
  'demo',
  'other',
] as const;

/**
 * A stored waitlist entry. `email` is the natural key (normalised: trimmed + lower-cased).
 * `ip` is coarse metadata for abuse triage only and is never surfaced by the public stats view.
 */
export interface WaitlistEntry {
  /** Stable, opaque id (not sequential — safe to expose). */
  id: string;
  /** Normalised email (trimmed, lower-cased) — the dedup key. */
  email: string;
  name?: string;
  company?: string;
  /** Plan tier the visitor is interested in (free-form; mirrors billing PlanTier names). */
  interestedTier?: string;
  /** Short "what do you want to build" note. */
  useCase?: string;
  /** Where the signup came from. */
  source: WaitlistSource;
  /** Optional referral code / referrer. */
  referral?: string;
  /** Epoch milliseconds the signup was recorded. */
  at: number;
  /** Coarse client IP for abuse triage (never returned by the stats endpoint). */
  ip?: string;
}

/** Raw signup input (from the marketing form or the API). Only `email` is required. */
export interface WaitlistSignupInput {
  email: unknown;
  name?: unknown;
  company?: unknown;
  interestedTier?: unknown;
  useCase?: unknown;
  source?: unknown;
  referral?: unknown;
  /** Server-supplied metadata (never trusted from the request body). */
  ip?: string;
  /** Override the recorded timestamp (tests / replay). */
  at?: number;
}

/** Outcome of a signup attempt. */
export interface WaitlistSignupResult {
  /** True when a NEW entry was created; false when the email was already on the list. */
  created: boolean;
  /** True when the email was already present (idempotent re-signup). */
  duplicate: boolean;
  /** The stored entry, with `ip` stripped (safe to echo back to the client). */
  entry: PublicWaitlistEntry;
  /** 1-based position on the waitlist (by signup order). */
  position: number;
}

/** A waitlist entry safe to return to clients — no IP, no server-only fields. */
export interface PublicWaitlistEntry {
  id: string;
  email: string;
  name?: string;
  company?: string;
  interestedTier?: string;
  useCase?: string;
  source: WaitlistSource;
  referral?: string;
  at: number;
}

/** Aggregate, privacy-safe stats for the GET /v1/waitlist/stats endpoint. */
export interface WaitlistStats {
  /** Total unique signups. */
  total: number;
  /** Signups broken down by source. */
  bySource: Record<string, number>;
  /** Signups broken down by interestedTier (only tiers that were chosen). */
  byTier: Record<string, number>;
  /** Signups in the last 24h / 7d (rolling, relative to `now`). */
  last24h: number;
  last7d: number;
  /** Epoch ms of the first and most recent signup (null when empty). */
  firstAt: number | null;
  lastAt: number | null;
}

/** Raised for invalid signup input (e.g. malformed email). Carries an HTTP-friendly code. */
export class WaitlistValidationError extends Error {
  readonly code = 'invalid_signup';
  constructor(message: string) {
    super(message);
    this.name = 'WaitlistValidationError';
  }
}
