/**
 * marketplace/verify.ts — signature verification for tool manifests (Ed25519 or HMAC).
 *
 * The signed content is the CANONICAL JSON of the manifest (stable key order), so signing and
 * verification are deterministic regardless of property insertion order. Ed25519 is real
 * asymmetric verification (the listing carries its own public key). HMAC-SHA256 is a
 * shared-secret STUB for local/dev/CI registries — the verifier is handed the secret for the
 * manifest's keyId out of band.
 *
 * Dependency-free: node:crypto only.
 */
import { createHmac, createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';
import type { SignedToolManifest, ToolManifest, VerifyResult } from './types.js';

/** Deterministic canonical serialization of the manifest (recursively key-sorted). */
export function canonicalizeManifest(manifest: ToolManifest): string {
  return JSON.stringify(sortValue(manifest));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      out[k] = sortValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Options a verifier needs beyond the self-describing listing. For HMAC listings the shared
 * secret is looked up by keyId (never travels with the manifest).
 */
export interface VerifyOptions {
  /** Resolve the shared HMAC secret for a keyId. Required to verify `hmac-sha256` listings. */
  hmacSecretFor?: (keyId: string) => string | Buffer | undefined;
}

/** Verify a signed manifest with whichever scheme it declares. Never throws. */
export function verifyManifest(signed: SignedToolManifest, options: VerifyOptions = {}): VerifyResult {
  const { manifest, signature } = signed;
  const base: Omit<VerifyResult, 'valid' | 'reason'> = {
    algorithm: signature.algorithm,
    keyId: signature.keyId,
  };
  const bytes = Buffer.from(canonicalizeManifest(manifest), 'utf8');

  try {
    if (signature.algorithm === 'ed25519') {
      if (!signature.publicKey) {
        return { ...base, valid: false, reason: 'ed25519 listing missing publicKey' };
      }
      const key = createPublicKey(normalizePem(signature.publicKey));
      const valid = cryptoVerify(null, bytes, key, Buffer.from(signature.value, 'base64'));
      return { ...base, valid, reason: valid ? undefined : 'ed25519 signature does not verify' };
    }

    if (signature.algorithm === 'hmac-sha256') {
      const secret = options.hmacSecretFor?.(signature.keyId);
      if (secret === undefined) {
        return { ...base, valid: false, reason: `no HMAC secret registered for keyId "${signature.keyId}"` };
      }
      const expected = createHmac('sha256', secret).update(bytes).digest();
      const provided = safeBase64(signature.value);
      const valid = provided !== null && expected.length === provided.length && timingSafeEqual(expected, provided);
      return { ...base, valid, reason: valid ? undefined : 'HMAC signature does not verify' };
    }

    return { ...base, valid: false, reason: `unsupported algorithm "${(signature as { algorithm: string }).algorithm}"` };
  } catch (e) {
    return { ...base, valid: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Signing helpers (used by tests, tooling, and publishers — not by the registry).
// ---------------------------------------------------------------------------

/** Sign a manifest with an Ed25519 private key. Returns a self-describing signed listing. */
export function signManifestEd25519(
  manifest: ToolManifest,
  keyId: string,
  privateKeyPem: string,
  publicKeyPem: string,
): SignedToolManifest {
  const bytes = Buffer.from(canonicalizeManifest(manifest), 'utf8');
  const value = cryptoSign(null, bytes, createPrivateKey(normalizePem(privateKeyPem))).toString('base64');
  return { manifest, signature: { algorithm: 'ed25519', keyId, value, publicKey: publicKeyPem } };
}

/** Sign a manifest with a shared HMAC secret (dev/CI stub). */
export function signManifestHmac(manifest: ToolManifest, keyId: string, secret: string | Buffer): SignedToolManifest {
  const bytes = Buffer.from(canonicalizeManifest(manifest), 'utf8');
  const value = createHmac('sha256', secret).update(bytes).digest('base64');
  return { manifest, signature: { algorithm: 'hmac-sha256', keyId, value } };
}

function normalizePem(key: string): string {
  return key.includes('-----BEGIN') ? key : key;
}

function safeBase64(value: string): Buffer | null {
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}
