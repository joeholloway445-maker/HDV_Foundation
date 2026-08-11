/**
 * creator/payout_stub.ts — a dependency-free STUB for Stripe Identity (verification) + Stripe
 * Connect (payouts), mirroring billing/stripe_stub.ts's exact shape and spirit: no network I/O,
 * no `stripe` SDK dependency, an in-memory Map for stateful lookups, thrown typed errors.
 *
 * *** THIS MODULE IS THE SAFETY GATE FOR REAL-MONEY CREATOR PAYOUTS. READ BEFORE TOUCHING. ***
 *
 * `requestVerification` always returns a stub session stuck in `'requires_input'` — there is
 * intentionally NO real ID-check backend wired in this pass. `checkVerificationStatus` starts
 * every creator at `'unverified'` and moves them to `'pending'` once a verification session has
 * been requested; NOTHING in this module ever moves a creator to `'verified'`. `requestPayout`
 * therefore throws a typed `PayoutBlockedError` (code `'not_verified'`) UNCONDITIONALLY, every
 * single call, regardless of creatorUserId, amount, or how much has accrued in the ledger
 * (creator/handlers.ts's handleGetEarnings) — payouts are unavailable BY CONSTRUCTION, not by a
 * runtime check that could accidentally be satisfied.
 *
 * This stub is now ONE of two implementations of the CreatorPayoutProvider interface
 * (creator/payout_types.ts) — see creator/payout_stripe_live.ts for a REAL Stripe Identity +
 * Connect implementation, and creator/payout_factory.ts for the env-driven switch between them
 * (STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET both configured ⇒ live; otherwise, ALWAYS this
 * stub — the safe default). This class's behavior is UNCHANGED from before that split: it still
 * unconditionally throws `PayoutBlockedError` on every `requestPayout` call. The only mechanical
 * change is that `requestVerification`/`requestPayout` are now `async` (an async function that
 * always throws still always throws — same behavior, just interface-compatible with the live
 * implementation, which genuinely needs network round-trips). Do NOT add a bypass, admin
 * override, or "for testing convenience" shortcut here: that would defeat the entire purpose of
 * this file. Anyone who has not configured real Stripe keys gets exactly this stub, unconditionally
 * blocked, forever.
 *
 * Constitution note: this is a commercial/creator-payout surface only. It never routes a
 * RoutingPacket, calls KNOLL/APEX, executes, or creates agents.
 */
import { randomUUID } from 'node:crypto';
import type {
  CreatorPayoutProvider,
  PayoutResult,
  VerificationSession,
  VerificationStatus,
} from './payout_types.js';
export type { VerificationStatus, VerificationSession, VerificationSessionStatus } from './payout_types.js';

/** Thrown by `requestPayout` whenever a creator's verificationStatus isn't 'verified' — i.e.
 *  always, in this build. See the module doc comment. */
export class PayoutBlockedError extends Error {
  readonly code = 'not_verified';
  constructor(message: string) {
    super(message);
    this.name = 'PayoutBlockedError';
  }
}

/** Thrown for invalid payout/verification input (bad creatorUserId, non-positive amount). */
export class PayoutStubError extends Error {
  readonly code = 'invalid_payout';
  constructor(message: string) {
    super(message);
    this.name = 'PayoutStubError';
  }
}

export interface CreatorPayoutStubOptions {
  /** Secret key. Defaults to env STRIPE_SECRET_KEY. Optional — absent ⇒ test mode. Only used to
   *  derive `livemode`/`configured` (mirrors billing/stripe_stub.ts); never sent anywhere. */
  secretKey?: string;
  /** Injectable id generator (tests / determinism). */
  idFactory?: () => string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The Stripe Identity + Connect stub. See the module doc comment: `requestPayout` is the
 * unconditional safety gate — it cannot be made to succeed by anything in this codebase today.
 */
export class CreatorPayoutStub implements CreatorPayoutProvider {
  readonly livemode: boolean;
  /** True when SOME Stripe secret key (test or live) is configured. Purely cosmetic here (no
   *  network call is ever made either way) — mirrors StripeCheckoutStub's `configured` flag. */
  readonly configured: boolean;
  private readonly idFactory: () => string;
  /** creatorUserId -> verificationStatus. Starts empty; `checkVerificationStatus` defaults an
   *  unknown creator to 'unverified'. Never contains 'verified' — see the module doc comment. */
  private readonly statuses = new Map<string, VerificationStatus>();

  constructor(options: CreatorPayoutStubOptions = {}) {
    const env = options.env ?? process.env;
    const secretKey = (options.secretKey ?? env.STRIPE_SECRET_KEY ?? '').trim();
    this.configured = secretKey.length > 0;
    this.livemode = secretKey.startsWith('sk_live_');
    this.idFactory = options.idFactory ?? (() => randomUUID().replace(/-/g, ''));
  }

  /**
   * Start a (stub) identity-verification session for a creator. Always returns a session in
   * `'requires_input'` — it never auto-completes, because there is no real ID-check backend
   * wired in this pass. Moves the creator's stored status to `'pending'` (from `'unverified'`)
   * so `checkVerificationStatus` reflects "a request is in flight"; this can NEVER progress to
   * `'verified'` through any code path here. `async` for CreatorPayoutProvider compatibility
   * only — the body performs no network I/O and resolves synchronously.
   */
  async requestVerification(creatorUserId: string, now: number = Date.now()): Promise<VerificationSession> {
    const id = requireNonEmpty(creatorUserId, 'creatorUserId');
    if (this.statuses.get(id) !== 'verified') {
      this.statuses.set(id, 'pending');
    }
    const idPrefix = this.livemode ? 'vs_live_' : 'vs_test_';
    const sessionId = `${idPrefix}${this.idFactory()}`;
    return {
      id: sessionId,
      object: 'identity.verification_session',
      creatorUserId: id,
      status: 'requires_input',
      livemode: this.livemode,
      url: `https://verify.stripe.com/session/${sessionId}#hdv-stub`,
      createdAt: now,
    };
  }

  /** Read back the stub's stored verification status for a creator. Starts 'unverified' for a
   *  creator who has never called `requestVerification`. Synchronous — see the interface doc
   *  comment (creator/payout_types.ts) on why this method stays a cheap, local read. */
  checkVerificationStatus(creatorUserId: string): VerificationStatus {
    return this.statuses.get(creatorUserId) ?? 'unverified';
  }

  /**
   * THE SAFETY GATE. Throws `PayoutBlockedError` (code 'not_verified') unconditionally — every
   * creator's status is either 'unverified' or 'pending' in this build (never 'verified'), so
   * every call to this method throws, regardless of `amountUsd` or how much has accrued. See
   * the module doc comment; do not weaken this. `async` (returns `Promise<never>`, assignable to
   * CreatorPayoutProvider's `Promise<PayoutResult>`) for interface compatibility only — an async
   * function that always throws still always throws; there is no behavior change here.
   */
  async requestPayout(creatorUserId: string, amountUsd: number): Promise<PayoutResult> {
    const id = requireNonEmpty(creatorUserId, 'creatorUserId');
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      throw new PayoutStubError('amountUsd must be a positive number');
    }
    const status = this.checkVerificationStatus(id);
    throw new PayoutBlockedError(
      `payout blocked: creator "${id}" requested $${amountUsd.toFixed(2)} but is not identity-` +
        `verified (status: "${status}") — no real Stripe Identity integration exists yet in this build`,
    );
  }
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PayoutStubError(`${field} is required`);
  }
  return value.trim();
}
