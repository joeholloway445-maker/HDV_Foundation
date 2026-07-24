/**
 * legal/index.ts — public surface of the legal / governance framework stubs.
 */
export { ManualProgressionGate } from './progression_gates.js';
export type {
  GateStatus,
  GateDecision,
  ManualProgressionGateOptions,
} from './progression_gates.js';

/** All third-party integrations are bound by the Governance NDA (see legal/GOVERNANCE_NDA.md). */
export const THIRD_PARTY_INTEGRATIONS_BOUND_BY_NDA = true as const;

/** Relative paths to the embeddable legal documents. */
export const LEGAL_DOCS = {
  termsOfService: 'legal/TOS.md',
  governanceNda: 'legal/GOVERNANCE_NDA.md',
} as const;
