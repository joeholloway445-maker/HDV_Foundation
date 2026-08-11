/**
 * auth/service.ts — a dependency-free email+password AuthService for the launch.
 *
 * Mirrors billing/stripe_stub.ts's posture: no new external dependency, no network I/O, a
 * clean implementation behind a documented seam so it stays swappable later (e.g. adding
 * OAuth providers, or moving hashing to argon2, is a change confined to this file). Password
 * hashing uses Node's built-in `crypto.scrypt` rather than pulling in bcrypt/argon2 — the repo
 * already has this dependency-light convention (see providers/image_stub.ts's hand-rolled PNG
 * encoder) and neither bcrypt nor argon2 is an existing dependency (see package.json).
 *
 * Password storage encoding: `passwordHash` is `<saltHex>:<hashHex>` — a random 16-byte salt
 * per user (hex-encoded) and the scrypt-derived key (hex-encoded), separated by a colon. See
 * `hashPassword` / `verifyPassword` below. Verification uses `crypto.timingSafeEqual` so a
 * wrong-length or wrong-content candidate can't be distinguished by timing.
 *
 * Session tokens are `crypto.randomBytes(32).toString('hex')` (256 bits of entropy) with a
 * 30-day expiry (SESSION_TTL_MS), stored via the injected SessionRepository (in-memory by
 * default; Postgres via persistence/prisma_repos.ts when DATABASE_URL is set — same
 * repository-interface pattern as everything else in persistence/).
 *
 * Security note (not a nitpick): `login` returns the SAME generic "invalid email or password"
 * message — and throws the SAME AuthError code — whether the email is unknown or the password
 * is wrong. Distinguishing the two lets an attacker enumerate valid emails; this codebase does
 * not do that.
 *
 * SCOPE: no email verification, no password-reset flow in this pass (see auth/types.ts).
 */
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { UserRepository, SessionRepository, UserRecord } from '../persistence/index.js';
import type { AuthUser, AuthResult, AuthErrorCode } from './types.js';

/** Minimum password length. Deliberately simple for a first pass — no complexity rules. */
export const MIN_PASSWORD_LENGTH = 8;
/** Session lifetime: 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_EMAIL_LENGTH = 254; // RFC 5321 practical ceiling.
// Loose-but-real email shape: local@domain.tld, no whitespace. Not RFC 5322-complete by
// design — we validate "looks like an email", not the full grammar.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Thrown by AuthService for any signup/login failure. `code` maps to an HTTP status. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export interface AuthServiceOptions {
  users: UserRepository;
  sessions: SessionRepository;
  /** Injectable clock (tests: deterministic expiry). Defaults to Date.now. */
  now?: () => number;
  /** Override the session lifetime. Defaults to SESSION_TTL_MS (30 days). */
  sessionTtlMs?: number;
}

/**
 * Minimal-but-correct email+password accounts + session tokens. Every public method accepts
 * `unknown` for user-supplied fields and throws a typed `AuthError` on any invalid input —
 * callers (the gateway) never need to pre-validate shape.
 */
export class AuthService {
  private readonly users: UserRepository;
  private readonly sessions: SessionRepository;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;

  constructor(options: AuthServiceOptions) {
    this.users = options.users;
    this.sessions = options.sessions;
    this.now = options.now ?? (() => Date.now());
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  }

  /** Create a new account. Throws AuthError('invalid_input') or AuthError('duplicate_email'). */
  signup(email: unknown, password: unknown): AuthResult {
    const normalizedEmail = validateEmail(email);
    const cleanPassword = validatePassword(password);

    if (this.users.findByEmail(normalizedEmail)) {
      throw new AuthError('duplicate_email', 'an account with that email already exists');
    }

    const user = this.users.create({
      id: randomUUID(),
      email: normalizedEmail,
      passwordHash: hashPassword(cleanPassword),
      createdAt: this.now(),
    });

    return { user: toPublicUser(user), sessionToken: this.mintSession(user.id) };
  }

  /**
   * Authenticate an existing account. Throws AuthError('invalid_input') only for
   * missing/malformed fields; an unknown email or a wrong password BOTH throw the exact same
   * AuthError('invalid_credentials', 'invalid email or password') — see the file doc comment.
   */
  login(email: unknown, password: unknown): AuthResult {
    if (typeof email !== 'string' || email.trim().length === 0) {
      throw new AuthError('invalid_input', 'email is required');
    }
    if (typeof password !== 'string' || password.length === 0) {
      throw new AuthError('invalid_input', 'password is required');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = this.users.findByEmail(normalizedEmail);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new AuthError('invalid_credentials', 'invalid email or password');
    }

    return { user: toPublicUser(user), sessionToken: this.mintSession(user.id) };
  }

  /** Invalidate a session token. Idempotent: an unknown/missing token is a silent no-op. */
  logout(sessionToken: unknown): void {
    if (typeof sessionToken !== 'string' || sessionToken.trim().length === 0) return;
    this.sessions.delete(sessionToken.trim());
  }

  /** Resolve a session token to its user, or null if missing/unknown/expired. */
  getUserBySession(sessionToken: unknown): AuthUser | null {
    if (typeof sessionToken !== 'string' || sessionToken.trim().length === 0) return null;
    const session = this.sessions.findByToken(sessionToken.trim());
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      // Lazily reap the expired session so it can't be reused, and treat it as absent.
      this.sessions.delete(session.token);
      return null;
    }
    const user = this.users.findById(session.userId);
    return user ? toPublicUser(user) : null;
  }

  private mintSession(userId: string): string {
    const token = randomBytes(32).toString('hex');
    const at = this.now();
    this.sessions.create({ token, userId, createdAt: at, expiresAt: at + this.sessionTtlMs });
    return token;
  }
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function validateEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthError('invalid_input', 'email must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(trimmed)) {
    throw new AuthError('invalid_input', 'email must be a valid email address');
  }
  return trimmed.toLowerCase();
}

function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError('invalid_input', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return value;
}

function toPublicUser(user: UserRecord): AuthUser {
  return { userId: user.id, email: user.email, createdAt: user.createdAt };
}

// ---------------------------------------------------------------------------
// password hashing — crypto.scrypt, no external dependency (see file doc comment).
// Encoding: `<saltHex>:<hashHex>`.
// ---------------------------------------------------------------------------

const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEYLEN = 64;

/** Hash a plaintext password with a fresh random salt. Returns the `salt:hash` encoding. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt}:${derived.toString('hex')}`;
}

/** Constant-time verification of a plaintext password against a `salt:hash` encoding. */
export function verifyPassword(password: string, stored: string): boolean {
  const sepIndex = stored.indexOf(':');
  if (sepIndex <= 0 || sepIndex === stored.length - 1) return false;
  const salt = stored.slice(0, sepIndex);
  const hashHex = stored.slice(sepIndex + 1);
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length === 0) return false;
  const candidate = scryptSync(password, salt, expected.length);
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}
