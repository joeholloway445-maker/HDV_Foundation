/**
 * creator/payout_types.ts — the CreatorPayoutProvider contract.
 *
 * Sibling seam to providers/image_types.ts (ImageProvider) / providers/tts_types.ts
 * (TtsProvider): a thin, dependency-free interface so higher layers (creator/handlers.ts,
 * gateway/server.ts) can depend on "some Stripe Identity + Connect payout provider" without
 * knowing or caring whether it's the offline CreatorPayoutStub (creator/payout_stub.ts — the
 * safe default, unconditionally blocked) or the real CreatorPayoutStripeLive
 * (creator/payout_stripe_live.ts — wired only when STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET
 * are both configured, see creator/payout_factory.ts).
 *
 * *** THIS IS A REAL-MONEY + IDENTITY-VERIFICATION SURFACE. READ creator/payout_stub.ts's
 * module doc comment AND creator/payout_stripe_live.ts's before changing anything here. ***
 *
 * `requestVerification` and `requestPayout` are `Promise`-returning because a real
 * implementation needs a network round-trip to Stripe (creating a VerificationSession/Connect
 * account, or re-checking live status before moving money) — the stub's implementations are
 * still synchronous internally, just wrapped in `async` for interface compatibility; their
 * BEHAVIOR does not change. `checkVerificationStatus` stays synchronous in both
 * implementations: it's a fast, cheap, LOCAL read (the stub's in-memory Map; the live
 * implementation's webhook-updated persistence cache) meant for display purposes (e.g. backing
 * GET /v1/creator/earnings) — see the module doc comment on CreatorPayoutStripeLine's
 * `checkVerificationStatus` for why it must NEVER be the sole gate for money movement.
 */

/** Local, cached verification status. Never authoritative for a payout decision on its own —
 *  see requestPayout's doc comment on both implementations. */
export type VerificationStatus = 'unverified' | 'pending' | 'verified';

/** Lifecycle of a Stripe Identity VerificationSession (mirrors Stripe's own status enum,
 *  restricted to the values this codebase ever surfaces to a caller). */
export type VerificationSessionStatus = 'requires_input' | 'processing' | 'verified' | 'rejected' | 'canceled';

/** A (stub or real) Stripe Identity VerificationSession — the fields callers read. */
export interface VerificationSession {
  id: string;
  object: 'identity.verification_session';
  creatorUserId: string;
  status: VerificationSessionStatus;
  /** false in test mode, true when a `sk_live_…` key is configured. */
  livemode: boolean;
  /** Hosted URL the client redirects to (Identity verification and/or Connect onboarding). */
  url: string;
  /** Epoch ms created. */
  createdAt: number;
}

/** The result of a successful (or, for the stub, never-reached) requestPayout call. */
export interface PayoutResult {
  /** The underlying Stripe transfer id (live) or a synthesized id (never populated by the stub,
   *  since the stub's requestPayout always throws before returning). */
  id: string;
  creatorUserId: string;
  amountUsd: number;
  /** 'submitted' — the transfer was created at Stripe; Stripe's own async payout schedule
   *  moves the money from the connected account's balance from there. */
  status: 'submitted';
  /** The Stripe transfer id (same as `id` for the live implementation). */
  stripeTransferId: string;
}

/**
 * The single provider contract every payout backend implements — the safe offline stub
 * (CreatorPayoutStub) and the real Stripe Identity + Connect implementation
 * (CreatorPayoutStripeLive). Implementations perform NO routing, KNOLL, or agent-execution
 * side effects — this is a commercial/creator-payout surface only (same constitution note as
 * creator/payout_stub.ts).
 */
export interface CreatorPayoutProvider {
  /**
   * Start (or re-fetch) an identity-verification + Connect-onboarding flow for a creator.
   * Returns a session the client redirects to. Async: a real implementation makes at least one
   * Stripe API call here (VerificationSession + Connect Express account creation).
   */
  requestVerification(creatorUserId: string, now?: number): Promise<VerificationSession>;

  /**
   * Cheap, synchronous, LOCAL read of a creator's cached verification status. Safe for display
   * (e.g. GET /v1/creator/earnings) but MUST NEVER be trusted as the sole gate before moving
   * money — see requestPayout.
   */
  checkVerificationStatus(creatorUserId: string): VerificationStatus;

  /**
   * Attempt to pay out `amountUsd` to a creator. THE SAFETY GATE. The stub throws
   * `PayoutBlockedError` unconditionally (creator/payout_stub.ts). The live implementation
   * throws `PayoutBlockedError` unless it has JUST re-verified — live, against Stripe's own
   * API, not the local cache — that the creator is identity-verified AND their Connect account
   * has payouts enabled (creator/payout_stripe_live.ts). Async: both the safety recheck and (on
   * success) the transfer itself are network calls.
   */
  requestPayout(creatorUserId: string, amountUsd: number): Promise<PayoutResult>;
}

/** Recognized provider selector values for the env-driven factory (creator/payout_factory.ts). */
export type CreatorPayoutProviderKind = 'stub' | 'stripe_live';
