/**
 * creator/index.ts — public surface of the creator marketplace (creator/).
 *
 * Backs the fucklike.me pivot: real people can turn themselves into an AI companion persona and
 * earn money when that persona/likeness is used (fucklike.ai's fully-fictional companion
 * product is untouched — the only shared touch point is the fire-and-forget
 * `recordLikenessUsage` call companion/ makes, which no-ops cleanly for a non-creator-owned
 * companion, the common case). A "creator" is just an existing auth/ User with an additional
 * CreatorProfile — this is NOT a parallel identity system; see creator/handlers.ts.
 *
 * Payouts are gated by the CreatorPayoutProvider interface (creator/payout_types.ts), with TWO
 * implementations selected by creator/payout_factory.ts:
 *   - CreatorPayoutStub (creator/payout_stub.ts) — the SAFE DEFAULT. verificationStatus can
 *     never reach 'verified' through it, so requestPayout is unconditionally blocked. Used
 *     whenever STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET aren't both configured.
 *   - CreatorPayoutStripeLive (creator/payout_stripe_live.ts) — a REAL Stripe Identity + Connect
 *     integration. Every payout re-checks Stripe LIVE (never the local cache) immediately before
 *     moving money — see that module's doc comment for the defense-in-depth this relies on.
 * Earnings accrue in the ledger regardless of which provider is active.
 */
export * from './types.js';

export {
  handleCreatorApply,
  handleCreatePersona,
  handleGetEarnings,
  handleRequestVerification,
  handleRequestPayout,
  recordLikenessUsage,
} from './handlers.js';
export type {
  CreatorResponse,
  CreatorHandlerOptions,
  EarningsResponse,
  RecordLikenessUsageOptions,
} from './handlers.js';

export type {
  VerificationStatus,
  VerificationSession,
  VerificationSessionStatus,
  PayoutResult,
  CreatorPayoutProvider,
  CreatorPayoutProviderKind,
} from './payout_types.js';

export { CreatorPayoutStub, PayoutBlockedError, PayoutStubError } from './payout_stub.js';
export type { CreatorPayoutStubOptions } from './payout_stub.js';

export { CreatorPayoutStripeLive, CreatorPayoutStripeLiveConfigError } from './payout_stripe_live.js';
export type { CreatorPayoutStripeLiveOptions } from './payout_stripe_live.js';

export { handleStripeWebhook } from './stripe_webhook.js';
export type { StripeWebhookOptions, StripeWebhookResult } from './stripe_webhook.js';

export {
  createCreatorPayoutProvider,
  createCreatorPayoutProviderOrStub,
  resolveCreatorPayoutProviderKind,
  UnknownCreatorPayoutProviderError,
  ENV_STRIPE_SECRET_KEY,
  ENV_STRIPE_WEBHOOK_SECRET,
} from './payout_factory.js';
export type { CreatorPayoutFactoryOptions } from './payout_factory.js';
