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
 * Payouts are a deliberately conservative stub in this pass (creator/payout_stub.ts):
 * verificationStatus can never reach 'verified' yet, so requestPayout is unconditionally
 * blocked. Earnings still accrue in the ledger for when a real Stripe Identity + Connect
 * integration lands in a future pass.
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

export { CreatorPayoutStub, PayoutBlockedError, PayoutStubError } from './payout_stub.js';
export type {
  VerificationStatus,
  VerificationSession,
  VerificationSessionStatus,
  CreatorPayoutStubOptions,
} from './payout_stub.js';
