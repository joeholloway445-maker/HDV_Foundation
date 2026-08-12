/**
 * creator/stripe_webhook.ts — handler for POST /v1/creator/webhooks/stripe.
 *
 * *** SECURITY-CRITICAL: this is the ONLY code path that ever moves a creator's LOCAL
 * verification-status cache toward 'verified'. READ FULLY BEFORE TOUCHING. ***
 *
 * This route is unauthenticated by THIS app's normal standards (no X-HDV-Session, no
 * HDV_API_KEY — see gateway/middleware.ts's AUTH_EXEMPT_PATHS entry and gateway/server.ts's
 * wiring for the loud warning about why that is safe here specifically). Its ENTIRE security
 * boundary is the `stripe-signature` header, verified via the Stripe SDK's OWN
 * `stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret)` — never hand-rolled
 * HMAC verification. `constructEvent` throws on a missing, malformed, or forged signature, or on
 * a body that doesn't match the signature (e.g. if a proxy re-serialized the JSON) — this
 * handler catches that and returns 400 WITHOUT trusting a single field of the payload. Only
 * after a signature verifies does anything in `event.data` get read.
 *
 * Handled event types (unhandled types are a SAFE NO-OP — never an error, per Stripe's own
 * webhook best practices, since Stripe may add new event types at any time):
 *   - identity.verification_session.verified    → cache = 'verified'
 *   - identity.verification_session.requires_input → cache = 'pending'
 *   - identity.verification_session.canceled    → cache = 'unverified'
 *   - account.updated (Connect)                 → no direct status change; logged, safe no-op
 *   - anything else                              → safe no-op (200, not 4xx/5xx)
 *
 * This cache update is DISPLAY-ONLY (see creator/payout_types.ts's doc comment). A bug here can
 * never, by itself, let an unverified creator get paid: CreatorPayoutStripeLive.requestPayout
 * re-checks Stripe LIVE before every real transfer, regardless of what this handler has written
 * to the cache — that is the actual safety mechanism, this is just what makes the UI accurate.
 */
import type Stripe from 'stripe';
import type { CreatorPayoutStripeLive } from './payout_stripe_live.js';

export interface StripeWebhookOptions {
  /** The Stripe webhook signing secret (whsec_…) this endpoint is configured with. */
  webhookSecret: string;
  /** The live payout provider whose local cache gets updated on verified events. */
  payoutProvider: CreatorPayoutStripeLive;
  /** Injectable Stripe client for `webhooks.constructEvent` (tests: a fake with a stubbed
   *  `webhooks.constructEvent`, so no real signature/network machinery is needed). Defaults to
   *  `payoutProvider.stripeClient` — the SAME client the provider itself uses. */
  stripeClient?: Stripe;
  /** Injectable logger (tests / silence). Defaults to `console.log`/`console.error`. */
  log?: (message: string) => void;
}

export interface StripeWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Handle one Stripe webhook delivery. `rawBody` MUST be the exact, unparsed request body bytes
 * Stripe sent — signature verification fails (correctly) against a re-serialized/re-parsed JSON
 * body, which is why gateway/server.ts reads this route's body as raw bytes instead of the
 * normal JSON-parsed path (see COMPANION_CHAT_STREAM_PATH for the same kind of one-route
 * exception, applied there for SSE streaming instead of signature verification).
 */
export async function handleStripeWebhook(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  options: StripeWebhookOptions,
): Promise<StripeWebhookResult> {
  const log = options.log ?? ((msg: string) => console.log(`[creator/stripe_webhook] ${msg}`));

  if (!signatureHeader) {
    return { status: 400, body: { error: 'missing stripe-signature header' } };
  }

  const client = options.stripeClient ?? options.payoutProvider.stripeClient;

  let event: Stripe.Event;
  try {
    // The SDK's own verified helper — this is the entire security boundary of this route. Never
    // replace this with a hand-rolled HMAC check.
    event = client.webhooks.constructEvent(rawBody, signatureHeader, options.webhookSecret);
  } catch (err) {
    // A bad/missing/forged signature, or a body that doesn't match it. Nothing in the payload is
    // trusted past this point.
    return {
      status: 400,
      body: { error: `invalid Stripe webhook signature: ${err instanceof Error ? err.message : String(err)}` },
    };
  }

  switch (event.type) {
    case 'identity.verification_session.verified': {
      const session = event.data.object as Stripe.Identity.VerificationSession;
      const creatorUserId = session.metadata?.creatorUserId;
      if (creatorUserId) {
        options.payoutProvider.updateVerificationCache(creatorUserId, 'verified');
        log(`identity.verification_session.verified for creatorUserId=${creatorUserId} — cache updated`);
      } else {
        log('identity.verification_session.verified with no metadata.creatorUserId — ignored');
      }
      break;
    }
    case 'identity.verification_session.requires_input': {
      const session = event.data.object as Stripe.Identity.VerificationSession;
      const creatorUserId = session.metadata?.creatorUserId;
      if (creatorUserId) {
        options.payoutProvider.updateVerificationCache(creatorUserId, 'pending');
        log(`identity.verification_session.requires_input for creatorUserId=${creatorUserId} — cache updated`);
      }
      break;
    }
    case 'identity.verification_session.canceled': {
      const session = event.data.object as Stripe.Identity.VerificationSession;
      const creatorUserId = session.metadata?.creatorUserId;
      if (creatorUserId) {
        options.payoutProvider.updateVerificationCache(creatorUserId, 'unverified');
        log(`identity.verification_session.canceled for creatorUserId=${creatorUserId} — cache updated`);
      }
      break;
    }
    case 'account.updated': {
      // Connect account changes (e.g. payouts_enabled flips) are re-checked LIVE at payout time
      // by CreatorPayoutStripeLive.requestPayout — there is no local cache field this event needs
      // to update for the safety gate to work correctly. Logged for observability; safe no-op.
      const account = event.data.object as Stripe.Account;
      log(`account.updated for account=${account.id} — no-op (payouts_enabled is re-checked live at payout time)`);
      break;
    }
    default:
      // Unhandled event types are a SAFE NO-OP — Stripe can add new event types at any time, and
      // this endpoint is subscribed to a broader set (identity.verification_session.* +
      // account.updated) than the handful of specific types we act on above.
      log(`unhandled event type "${event.type}" — safe no-op`);
      break;
  }

  return { status: 200, body: { received: true, type: event.type } };
}
