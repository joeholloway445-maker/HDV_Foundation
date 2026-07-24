/**
 * marketplace/types.ts — vocabulary for the signed tool & persona marketplace (Phase 8).
 *
 * The marketplace lets third parties publish TOOLS (and, later, personas) that VISION can
 * discover and execute inside its sandbox. Trust comes from SIGNATURES: every listing is a
 * `SignedToolManifest` whose payload is cryptographically signed (Ed25519 or HMAC). The
 * registry verifies the signature before it will list a tool.
 *
 * HARD BOUNDARY: a marketplace tool is a LEAF capability. It can never grant itself the power
 * to CREATE agents, GOVERN/route packets, or weaken KNOLL — those capabilities are reserved
 * for the core and are rejected at registration. VISION may LIST and READ the registry; it can
 * never use it to escalate privilege. This module is dependency-free (node:crypto only) and
 * holds no routing/security engine of its own.
 */

/** Supported signature schemes. `ed25519` is real asymmetric signing; `hmac-sha256` is a
 * shared-secret stub for local/dev registries and CI. */
export type SignatureAlgorithm = 'ed25519' | 'hmac-sha256';

/**
 * Capabilities a tool may declare. These are LEAF, sandbox-scoped abilities only. The
 * governance/creation capabilities (`create`, `govern`, `route`, `gate`) are intentionally
 * NOT part of this union and are hard-rejected by the registry if a manifest smuggles them in.
 */
export type ToolCapability =
  | 'read'
  | 'compute'
  | 'transform'
  | 'fetch'
  | 'search'
  | 'summarize'
  | 'annotate';

/** Capabilities that a marketplace tool may NEVER hold — asking for one is an escalation. */
export const FORBIDDEN_CAPABILITIES: readonly string[] = [
  'create', // minting agents / packets
  'govern', // changing laws / policy
  'route', // acting as APEX
  'gate', // acting as KNOLL
  'knoll', // touching the security layer
  'apex', // touching the router
  'admin',
  'escalate',
];

/** The signable content of a tool listing. Everything here is covered by the signature. */
export interface ToolManifest {
  /** Stable tool id (namespace it, e.g. "acme/pdf-extract"). */
  name: string;
  /** Semver-ish version string. */
  version: string;
  /** Publisher / author identity (informational). */
  publisher: string;
  /** Human description. */
  description: string;
  /** Declared LEAF capabilities. Validated against FORBIDDEN_CAPABILITIES at registration. */
  capabilities: ToolCapability[];
  /** The VISION-sandbox entrypoint (module path, command, or handler id). */
  entrypoint: string;
  /** Optional JSON-schema-ish input contract (opaque to the registry). */
  inputSchema?: Record<string, unknown>;
  /** Epoch ms the manifest was created. */
  createdAt: number;
}

/** A tool manifest plus its detached signature and the key that produced it. */
export interface SignedToolManifest {
  manifest: ToolManifest;
  signature: {
    algorithm: SignatureAlgorithm;
    /** Opaque key identifier (used to look up a shared secret for HMAC, or for display). */
    keyId: string;
    /** Base64 signature over the canonical manifest bytes. */
    value: string;
    /** For ed25519: the PEM/base64 public key that verifies `value` (self-describing listing). */
    publicKey?: string;
  };
}

/** Outcome of verifying a signed manifest. */
export interface VerifyResult {
  valid: boolean;
  algorithm: SignatureAlgorithm;
  keyId: string;
  reason?: string;
}

/** A registered, verified listing (what VISION sees via list()). */
export interface RegisteredTool {
  name: string;
  version: string;
  publisher: string;
  description: string;
  capabilities: ToolCapability[];
  entrypoint: string;
  keyId: string;
  algorithm: SignatureAlgorithm;
  /** True once the signature verified at registration time. */
  verified: boolean;
  registeredAt: number;
}

/** Raised when a manifest is rejected (bad signature, escalation attempt, malformed). */
export class MarketplaceRejection extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MarketplaceRejection';
    this.code = code;
  }
}
