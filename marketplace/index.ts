/**
 * marketplace/index.ts — public surface of the signed tool & persona marketplace (Phase 8).
 *
 * A catalog of third-party TOOLS that VISION can discover and run in its sandbox, trusted via
 * cryptographic signatures (Ed25519 or an HMAC dev stub). The registry enforces a hard
 * anti-escalation boundary: no listing may ever claim create/govern/route/gate/knoll powers.
 * Nothing here routes packets, calls KNOLL, or mints agents.
 */
export { ToolMarketplaceRegistry } from './registry.js';
export type { ToolMarketplaceRegistryOptions } from './registry.js';
export {
  verifyManifest,
  canonicalizeManifest,
  signManifestEd25519,
  signManifestHmac,
} from './verify.js';
export type { VerifyOptions } from './verify.js';
export {
  FORBIDDEN_CAPABILITIES,
  MarketplaceRejection,
} from './types.js';
export type {
  SignatureAlgorithm,
  ToolCapability,
  ToolManifest,
  SignedToolManifest,
  VerifyResult,
  RegisteredTool,
} from './types.js';
