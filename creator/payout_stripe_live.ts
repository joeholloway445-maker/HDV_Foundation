/**
 * creator/payout_stripe_live.ts — the REAL Stripe Identity + Stripe Connect implementation of
 * CreatorPayoutProvider (creator/payout_types.ts).
 *
 * *** THIS MODULE MOVES REAL MONEY AND GATES REAL IDENTITY VERIFICATION. READ FULLY BEFORE
 * TOUCHING. *** It is wired in ONLY when both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are
 * configured (creator/payout_factory.ts) — anyone who hasn't configured real Stripe keys keeps
 * getting creator/payout_stub.ts's unconditionally-blocked stub, byte-for-byte unchanged.
 *
 * ARCHITECTURE
 *   - `requestVerification` creates (or reuses) a Stripe Connect Express account for the
 *     creator and a Stripe Identity VerificationSession, persists the ids via the injected
 *     CreatorProfileRepository (the "small persistence hook"), and returns a hosted URL the
 *     client redirects to (Connect onboarding; the Identity session itself is completed via
 *     Stripe's own client-side SDK/redirect using the session's `client_secret`/`url`).
 *   - `checkVerificationStatus` is a FAST, LOCAL, SYNCHRONOUS read of the webhook-updated cache
 *     (CreatorProfileRecord.verificationStatusCache) — good for display (GET
 *     /v1/creator/earnings), but see the next point for why it is never enough on its own.
 *   - `requestPayout` is THE SAFETY GATE. *** DEFENSE IN DEPTH — DO NOT WEAKEN OR SKIP THIS ***:
 *     before ever calling `stripe.transfers.create`, it re-verifies LIVE, directly against
 *     Stripe's own API (never the local cache), that (a) the creator's Identity
 *     VerificationSession status is `'verified'` (`stripe.identity.verificationSessions.retrieve`)
 *     AND (b) their Connect account has `payouts_enabled === true`
 *     (`stripe.accounts.retrieve`). Only if BOTH are true, checked fresh at the moment of the
 *     call, does a transfer happen. This means a bug anywhere in the webhook/cache-update path
 *     (creator/stripe_webhook.ts) can NEVER by itself let an unverified creator get paid — the
 *     money-movement call always asks Stripe directly, first-hand, every single time. Do NOT
 *     add a shortcut, admin override, or "trust the cache" fast path here.
 *
 * `stripeClient` is injectable (defaults to `new Stripe(secretKey)`) specifically so tests can
 * pass a fake/mock client with stubbed methods and NEVER make a real network call — mirrors
 * providers/colab_tunnel_image.ts's `fetchImpl` injection pattern.
 *
 * Constitution note: this is a commercial/creator-payout surface only. It never routes a
 * RoutingPacket, calls KNOLL/APEX, executes, or creates agents.
 */
import Stripe from 'stripe';
import type { CreatorProfileRecord, CreatorProfileRepository } from '../persistence/repositories.js';
import { PayoutBlockedError, PayoutStubError } from './payout_stub.js';
import type {
  CreatorPayoutProvider,
  PayoutResult,
  VerificationSession,
  VerificationSessionStatus,
  VerificationStatus,
} from './payout_types.js';

export interface CreatorPayoutStripeLiveOptions {
  /** Secret key. Defaults to env STRIPE_SECRET_KEY. Required (test or live). */
  secretKey?: string;
  /** Webhook signing secret. Defaults to env STRIPE_WEBHOOK_SECRET. Required. */
  webhookSecret?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable Stripe client — pass a fake/mock in tests so NO real network call is ever made.
   *  Defaults to `new Stripe(secretKey)`. */
  stripeClient?: Stripe;
  /** REQUIRED: where Connect account ids and the webhook-updated verification cache are
   *  persisted (see the module doc comment's "small persistence hook"). */
  creatorProfileRepository: CreatorProfileRepository;
  /** Base URL used to build Connect onboarding refresh/return URLs. Defaults to env
   *  HDV_PUBLIC_URL, then a placeholder (mirrors billing/stripe_stub.ts's baseUrl convention). */
  baseUrl?: string;
}

/** Thrown when this class is constructed without a usable secret key / webhook secret /
 *  repository — distinct from PayoutBlockedError (a runtime, per-request block). */
export class CreatorPayoutStripeLiveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreatorPayoutStripeLiveConfigError';
  }
}

/** Map a Stripe Identity VerificationSession status to this codebase's narrower enum. */
function mapSessionStatus(status: string): VerificationSessionStatus {
  switch (status) {
    case 'verified':
      return 'verified';
    case 'processing':
      return 'processing';
    case 'canceled':
      return 'canceled';
    case 'requires_input':
    default:
      return 'requires_input';
  }
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PayoutStubError(`${field} is required`);
  }
  return value.trim();
}

export class CreatorPayoutStripeLive implements CreatorPayoutProvider {
  readonly livemode: boolean;
  /** Always true once constructed — this class only exists when real keys are configured
   *  (creator/payout_factory.ts guards construction). Kept for symmetry with the other Stripe
   *  stub classes' `configured` flag. */
  readonly configured = true;
  /** The underlying Stripe client. Public+readonly so creator/stripe_webhook.ts can reuse the
   *  SAME client for `stripe.webhooks.constructEvent` (no second client to keep in sync). */
  readonly stripeClient: Stripe;
  /** The webhook signing secret this instance was configured with (creator/stripe_webhook.ts
   *  reads this off the gateway's configured provider — no second place to configure it). */
  readonly webhookSecret: string;
  private readonly creatorProfileRepository: CreatorProfileRepository;
  private readonly baseUrl: string;

  constructor(options: CreatorPayoutStripeLiveOptions) {
    const env = options.env ?? process.env;
    const secretKey = (options.secretKey ?? env.STRIPE_SECRET_KEY ?? '').trim();
    if (!secretKey) {
      throw new CreatorPayoutStripeLiveConfigError(
        'CreatorPayoutStripeLive requires a STRIPE_SECRET_KEY (sk_test_… or sk_live_…).',
      );
    }
    const webhookSecret = (options.webhookSecret ?? env.STRIPE_WEBHOOK_SECRET ?? '').trim();
    if (!webhookSecret) {
      throw new CreatorPayoutStripeLiveConfigError('CreatorPayoutStripeLive requires a STRIPE_WEBHOOK_SECRET.');
    }
    if (!options.creatorProfileRepository) {
      throw new CreatorPayoutStripeLiveConfigError(
        'CreatorPayoutStripeLive requires a creatorProfileRepository (persists Connect account ' +
          'ids and the webhook-updated verification-status cache).',
      );
    }
    this.livemode = secretKey.startsWith('sk_live_');
    this.webhookSecret = webhookSecret;
    this.stripeClient = options.stripeClient ?? new Stripe(secretKey);
    this.creatorProfileRepository = options.creatorProfileRepository;
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? env.HDV_PUBLIC_URL ?? 'https://hdvfoundation.dev');
  }

  /**
   * Create (or reuse) a Stripe Connect Express account for this creator and a real Stripe
   * Identity VerificationSession, persist both ids, and return a session the client can use to
   * complete both flows. Genuinely async: at least two Stripe API calls happen here.
   */
  async requestVerification(creatorUserId: string, now: number = Date.now()): Promise<VerificationSession> {
    const id = requireNonEmpty(creatorUserId, 'creatorUserId');
    const existing = this.creatorProfileRepository.get(id);

    let stripeAccountId = existing?.stripeAccountId;
    if (!stripeAccountId) {
      const account = await this.stripeClient.accounts.create({
        type: 'express',
        metadata: { creatorUserId: id },
      });
      stripeAccountId = account.id;
    }

    const session = await this.stripeClient.identity.verificationSessions.create({
      type: 'document',
      metadata: { creatorUserId: id },
    });

    const accountLink = await this.stripeClient.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${this.baseUrl}/creator/onboarding/refresh`,
      return_url: `${this.baseUrl}/creator/onboarding/complete`,
      type: 'account_onboarding',
    });

    this.persistProfile(id, existing, {
      stripeAccountId,
      stripeVerificationSessionId: session.id,
      // Only downgrade/seed the cache to 'pending' if we don't already know better (e.g. a
      // creator re-requesting verification after already being verified shouldn't regress the
      // DISPLAY cache — the live recheck in requestPayout is the actual source of truth either way).
      verificationStatusCache: existing?.verificationStatusCache ?? 'pending',
      now,
    });

    return {
      id: session.id,
      object: 'identity.verification_session',
      creatorUserId: id,
      status: mapSessionStatus(session.status ?? 'requires_input'),
      livemode: this.livemode,
      // Prefer the Identity session's own hosted URL when present; fall back to the Connect
      // onboarding link so the client always has SOMEWHERE to redirect to.
      url: session.url ?? accountLink.url,
      createdAt: now,
    };
  }

  /**
   * Fast, synchronous, LOCAL read of the webhook-updated cache. Good for display (e.g. GET
   * /v1/creator/earnings). NEVER trust this as the sole gate before moving money — see
   * requestPayout, which re-checks Stripe live every time regardless of what this returns.
   */
  checkVerificationStatus(creatorUserId: string): VerificationStatus {
    return this.creatorProfileRepository.get(creatorUserId)?.verificationStatusCache ?? 'unverified';
  }

  /**
   * Update the local verification-status cache. Called EXCLUSIVELY by creator/stripe_webhook.ts
   * after it has already verified a Stripe webhook signature — never call this from anywhere
   * that has not independently confirmed the signal is genuinely from Stripe. This method itself
   * performs no verification; it is a pure cache write.
   */
  updateVerificationCache(creatorUserId: string, status: VerificationStatus, now: number = Date.now()): void {
    const id = requireNonEmpty(creatorUserId, 'creatorUserId');
    const existing = this.creatorProfileRepository.get(id);
    this.persistProfile(id, existing, { verificationStatusCache: status, now });
  }

  /**
   * Persist a Stripe Connect Express account id against a creator, from `account.updated`
   * webhook context where we may not already have one on file (e.g. an account created directly
   * in the Stripe dashboard). No-op fields are omitted so this never regresses other columns.
   */
  private persistProfile(
    creatorUserId: string,
    existing: CreatorProfileRecord | undefined,
    updates: {
      stripeAccountId?: string;
      stripeVerificationSessionId?: string;
      verificationStatusCache?: VerificationStatus;
      now: number;
    },
  ): void {
    const merged: CreatorProfileRecord = existing
      ? {
          ...existing,
          stripeAccountId: updates.stripeAccountId ?? existing.stripeAccountId,
          stripeVerificationSessionId: updates.stripeVerificationSessionId ?? existing.stripeVerificationSessionId,
          verificationStatusCache: updates.verificationStatusCache ?? existing.verificationStatusCache,
        }
      : {
          // No CreatorProfile row yet (the creator hasn't called POST /v1/creator/apply) — seed a
          // minimal valid row so the Connect/Identity ids have somewhere durable to live.
          // displayName is required on the model; a creator without one yet gets their id as a
          // placeholder, overwritten the moment they do apply (handleCreatorApply preserves
          // verificationStatus but always sets displayName from the request).
          userId: creatorUserId,
          displayName: creatorUserId,
          verificationStatus: 'unverified',
          createdAt: updates.now,
          stripeAccountId: updates.stripeAccountId,
          stripeVerificationSessionId: updates.stripeVerificationSessionId,
          verificationStatusCache: updates.verificationStatusCache,
        };
    this.creatorProfileRepository.upsert(merged);
  }

  /**
   * THE SAFETY GATE. *** DEFENSE IN DEPTH — see the module doc comment; do not weaken. *** Before
   * ever creating a transfer, this re-verifies LIVE against Stripe's own API — never the local
   * cache — that the creator is genuinely identity-verified AND their Connect account has
   * payouts enabled, checked fresh at the moment of this call. Only then does money move.
   */
  async requestPayout(creatorUserId: string, amountUsd: number): Promise<PayoutResult> {
    const id = requireNonEmpty(creatorUserId, 'creatorUserId');
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      throw new PayoutStubError('amountUsd must be a positive number');
    }

    const profile = this.creatorProfileRepository.get(id);
    const sessionId = profile?.stripeVerificationSessionId;
    const accountId = profile?.stripeAccountId;
    if (!sessionId || !accountId) {
      throw new PayoutBlockedError(
        `payout blocked: creator "${id}" has not started identity verification / Connect ` +
          `onboarding yet (no Stripe VerificationSession/Connect account on file)`,
      );
    }

    // *** LIVE RECHECK — never trust profile.verificationStatusCache for this decision. ***
    const [session, account] = await Promise.all([
      this.stripeClient.identity.verificationSessions.retrieve(sessionId),
      this.stripeClient.accounts.retrieve(accountId),
    ]);

    if (session.status !== 'verified') {
      throw new PayoutBlockedError(
        `payout blocked: creator "${id}"'s Stripe Identity verification session is ` +
          `"${session.status}" per a LIVE Stripe check just now (not "verified") — no payout will ` +
          `be initiated, regardless of what the local cache says`,
      );
    }
    if (account.payouts_enabled !== true) {
      throw new PayoutBlockedError(
        `payout blocked: creator "${id}"'s Stripe Connect account does not have payouts_enabled ` +
          `per a LIVE Stripe check just now — no payout will be initiated, regardless of what the ` +
          `local cache says`,
      );
    }

    // Both live checks passed — safe to move money. Connect Express ⇒ a transfer to the
    // connected account (their own Stripe-scheduled payouts then move it to their bank).
    const amountCents = Math.round(amountUsd * 100);
    const transfer = await this.stripeClient.transfers.create({
      amount: amountCents,
      currency: 'usd',
      destination: accountId,
      metadata: { creatorUserId: id },
    });

    return {
      id: transfer.id,
      creatorUserId: id,
      amountUsd,
      status: 'submitted',
      stripeTransferId: transfer.id,
    };
  }
}
