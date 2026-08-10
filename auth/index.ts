/**
 * auth/index.ts — public surface of the account/auth layer (HDV Foundation).
 *
 * The first real, durable identity system in the codebase: email + password accounts and
 * bearer session tokens, following the same dependency-injected, "stub-swappable" posture as
 * billing/index.ts. `AuthService` bundles the hashing/session logic; the two repositories it
 * needs (UserRepository, SessionRepository) live in persistence/ alongside every other
 * repository in the codebase, with in-memory (default) and Prisma-backed implementations.
 */
export * from './types.js';
export {
  AuthService,
  AuthError,
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  SESSION_TTL_MS,
} from './service.js';
export type { AuthServiceOptions } from './service.js';
