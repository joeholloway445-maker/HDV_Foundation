/**
 * auth/types.ts — shared vocabulary for the account/auth layer (HDV Foundation).
 *
 * This is the FIRST real identity system in the codebase: email + password accounts and
 * bearer session tokens. Everything else (billing, persistent memory, ...) needs a durable
 * identity to attach to, and until now there was none — only an anonymous, client-supplied
 * `X-HDV-Tenant` header (see billing/ + gateway/server.ts's tenantFromHeaders).
 *
 * SCOPE (deliberately minimal for this first pass — see auth/service.ts):
 *   - No email verification flow. Follow-up.
 *   - No password-reset flow. Follow-up.
 *   - NOT wired into billing/checkout's tenant resolution yet — X-HDV-Tenant keeps working
 *     exactly as it does today so existing billing tests are unaffected. See the TODO next to
 *     gateway/server.ts's billing checkout handlers.
 */

/** Why signup/login failed — the gateway maps this to an HTTP status (see AuthError). */
export type AuthErrorCode = 'invalid_input' | 'duplicate_email' | 'invalid_credentials';

/** Public-safe view of an account. NEVER includes passwordHash — check every response body. */
export interface AuthUser {
  userId: string;
  email: string;
  /** Epoch milliseconds the account was created. */
  createdAt: number;
}

/** Result of a successful signup or login: the public user plus a fresh session token. */
export interface AuthResult {
  user: AuthUser;
  /** Opaque, cryptographically random bearer token — send back via X-HDV-Session. */
  sessionToken: string;
}
