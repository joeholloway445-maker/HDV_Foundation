/**
 * marketplace/registry.ts — the signed tool registry VISION can list.
 *
 * The registry is the trust boundary of the marketplace. Before ANY listing is accepted it:
 *   1. structurally validates the manifest,
 *   2. rejects capability ESCALATION (a tool may never claim create/govern/route/gate/knoll),
 *   3. verifies the signature (Ed25519 or HMAC),
 * and only then stores it. Reads (`list`, `get`) are pure projections — VISION uses them to
 * DISCOVER tools it may run in its sandbox, and can never use the registry to gain privilege.
 *
 * The registry NEVER routes a packet, calls KNOLL, or mints an agent. It is a catalog.
 */
import {
  FORBIDDEN_CAPABILITIES,
  MarketplaceRejection,
  type RegisteredTool,
  type SignedToolManifest,
  type ToolCapability,
  type ToolManifest,
} from './types.js';
import { verifyManifest, type VerifyOptions } from './verify.js';

/** Allowed leaf capabilities (the positive allowlist mirrored by ToolCapability). */
const ALLOWED_CAPABILITIES: readonly ToolCapability[] = [
  'read',
  'compute',
  'transform',
  'fetch',
  'search',
  'summarize',
  'annotate',
];

export interface ToolMarketplaceRegistryOptions extends VerifyOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class ToolMarketplaceRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly options: ToolMarketplaceRegistryOptions;
  private readonly now: () => number;

  constructor(options: ToolMarketplaceRegistryOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * Register a signed tool. Throws MarketplaceRejection on malformed input, escalation, or a
   * bad signature — nothing is stored unless every gate passes. Returns the stored listing.
   */
  register(signed: SignedToolManifest): RegisteredTool {
    const manifest = this.assertWellFormed(signed);
    this.assertNoEscalation(manifest);

    const verdict = verifyManifest(signed, this.options);
    if (!verdict.valid) {
      throw new MarketplaceRejection('bad_signature', `signature verification failed: ${verdict.reason ?? 'invalid'}`);
    }

    const record: RegisteredTool = {
      name: manifest.name,
      version: manifest.version,
      publisher: manifest.publisher,
      description: manifest.description,
      capabilities: [...manifest.capabilities],
      entrypoint: manifest.entrypoint,
      keyId: signed.signature.keyId,
      algorithm: signed.signature.algorithm,
      verified: true,
      registeredAt: this.now(),
    };
    this.tools.set(this.key(manifest.name, manifest.version), record);
    return record;
  }

  /**
   * Non-throwing register: returns { ok, tool?, error? }. Convenient for bulk ingest where one
   * bad listing shouldn't abort the batch.
   */
  tryRegister(signed: SignedToolManifest): { ok: boolean; tool?: RegisteredTool; error?: string; code?: string } {
    try {
      return { ok: true, tool: this.register(signed) };
    } catch (e) {
      if (e instanceof MarketplaceRejection) return { ok: false, error: e.message, code: e.code };
      return { ok: false, error: e instanceof Error ? e.message : String(e), code: 'error' };
    }
  }

  /** VISION's read view: all verified listings (safe projection; no keys/signatures). */
  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Look up a specific listing by name (latest registered wins if version omitted). */
  get(name: string, version?: string): RegisteredTool | undefined {
    if (version) return this.tools.get(this.key(name, version));
    const matches = [...this.tools.values()].filter((t) => t.name === name);
    return matches.length ? matches[matches.length - 1] : undefined;
  }

  /** Number of registered listings. */
  size(): number {
    return this.tools.size;
  }

  // -------------------------------------------------------------------------
  // gates
  // -------------------------------------------------------------------------

  private assertWellFormed(signed: SignedToolManifest): ToolManifest {
    if (signed === null || typeof signed !== 'object' || typeof signed.manifest !== 'object' || signed.manifest === null) {
      throw new MarketplaceRejection('malformed', 'signed manifest is missing its `manifest` object');
    }
    const m = signed.manifest;
    if (typeof m.name !== 'string' || m.name.trim().length === 0) {
      throw new MarketplaceRejection('malformed', 'manifest.name must be a non-empty string');
    }
    if (typeof m.version !== 'string' || m.version.trim().length === 0) {
      throw new MarketplaceRejection('malformed', 'manifest.version must be a non-empty string');
    }
    if (typeof m.entrypoint !== 'string' || m.entrypoint.trim().length === 0) {
      throw new MarketplaceRejection('malformed', 'manifest.entrypoint must be a non-empty string');
    }
    if (!Array.isArray(m.capabilities)) {
      throw new MarketplaceRejection('malformed', 'manifest.capabilities must be an array');
    }
    const sig = signed.signature;
    if (sig === null || typeof sig !== 'object' || typeof sig.value !== 'string' || typeof sig.keyId !== 'string') {
      throw new MarketplaceRejection('malformed', 'signature must carry a keyId and a value');
    }
    return m;
  }

  /**
   * The anti-escalation gate. A marketplace tool is a LEAF: it may only declare allowed
   * sandbox capabilities. Any governance/creation capability — by exact name OR as a substring
   * of a declared capability — is a privilege-escalation attempt and hard-fails registration.
   */
  private assertNoEscalation(manifest: ToolManifest): void {
    for (const raw of manifest.capabilities) {
      const cap = String(raw).trim().toLowerCase();
      for (const forbidden of FORBIDDEN_CAPABILITIES) {
        if (cap === forbidden || cap.includes(forbidden)) {
          throw new MarketplaceRejection(
            'escalation',
            `capability "${raw}" is forbidden: marketplace tools cannot create, govern, route, or gate`,
          );
        }
      }
      if (!ALLOWED_CAPABILITIES.includes(cap as ToolCapability)) {
        throw new MarketplaceRejection(
          'unknown_capability',
          `capability "${raw}" is not an allowed leaf capability (${ALLOWED_CAPABILITIES.join(', ')})`,
        );
      }
    }
  }

  private key(name: string, version: string): string {
    return `${name}@${version}`;
  }
}
