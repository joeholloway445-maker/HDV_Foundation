/**
 * providers/redact.ts — tiny helpers to keep API keys out of logs, errors, and objects.
 *
 * Providers are text transducers, but the tenancy layer that builds them (tenancy/) handles
 * real secrets: platform (HDV-hosted) keys and per-tenant BYOK keys. Nothing in this repo may
 * ever print a raw key. These helpers centralize that guarantee so every log line, error
 * message, and serialized route object is scrubbed the same way.
 */

/** The placeholder substituted for any secret value. */
export const REDACTED = '***redacted***';

/**
 * Redact a single secret value for display. Keeps a short, non-reversible hint (a few leading
 * characters) so operators can distinguish "a key is set" from "no key" without revealing it.
 * Returns the placeholder alone for short/empty values so nothing meaningful leaks.
 */
export function redactSecret(secret: string | undefined | null): string {
  if (!secret) return '(none)';
  if (secret.length <= 8) return REDACTED;
  return `${secret.slice(0, 4)}${REDACTED}`;
}

/**
 * Scrub any occurrences of the given secret(s) from an arbitrary string (e.g. an error message
 * or a URL that might embed credentials). Every non-empty secret is replaced with REDACTED.
 */
export function redactFrom(text: string, ...secrets: Array<string | undefined | null>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}
