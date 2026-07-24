/**
 * holloway/index.ts — public surface of the HOLLOWAY sovereign authority layer.
 *
 * HOLLOWAY sits ABOVE the Big 5 and is NOT a peer agent: it imports no hope/dream/vision/
 * knoll/apex module and depends only on node:crypto. It provides sovereign identities, the
 * Acting-Prime command + Former-Prime countermand model, the tamper-evident Designated Audit
 * Ledger (readable only by the Acting Prime, Former Primes, or Prime Hope), and the sovereign
 * freeze/unfreeze override seam.
 */
export type {
  HollowayRole,
  HollowayIdentity,
  ActingPrimeHolloway,
  FormerPrimeHolloway,
  PrimeRegistry,
} from './types.js';

export {
  PRIME_HOPE,
  primeHope,
  isPrimeHopeToken,
  isPrimeHopeIdentity,
} from './prime_hope.js';
export type { PrimeHopeToken, PrimeHopeIdentity } from './prime_hope.js';

export {
  SovereignAuthority,
  UnauthorizedCountermand,
  UnknownDirective,
} from './sovereign.js';
export type {
  Directive,
  DirectiveStatus,
  IssueDirectiveOptions,
  SovereignAuthorityOptions,
} from './sovereign.js';

export {
  DesignatedAuditLedger,
  ForbiddenLedgerAccess,
  GENESIS_HASH,
  hashLedgerRecord,
  computeLinkHash,
} from './designated_ledger.js';
export type {
  LedgerRecordKind,
  DesignatedLedgerRecord,
  RecordInput,
  DesignatedLedgerLink,
  LedgerVerification,
  LedgerReader,
  DesignatedAuditLedgerOptions,
} from './designated_ledger.js';

export {
  mintOverrideToken,
  signOverrideToken,
  verifyOverrideToken,
  applyHollowayOverride,
  InvalidOverrideToken,
} from './override.js';
export type {
  OverrideAction,
  HollowayOverrideToken,
  FreezeControllable,
} from './override.js';
