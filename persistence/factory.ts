/**
 * persistence/factory.ts — `createRepositories(mode)` selects the persistence backend.
 *
 * The running backbone defaults to `'memory'` (zero external dependencies). Passing
 * `'prisma'` returns Postgres-backed repositories that satisfy the exact same interfaces
 * via a write-through cache (see `prisma_repos.ts`). Both bundles expose the same
 * `hydrate()`/`flush()`/`close()` lifecycle so call sites can be backend-agnostic; for the
 * in-memory backend these are no-ops.
 */
import type {
  RequestLogRepository,
  NodeIdentityRepository,
  SecurityAuditRepository,
  IntentArchiveRepository,
  UserRepository,
  SessionRepository,
} from './repositories.js';
import {
  InMemoryRequestLogRepository,
  InMemoryNodeIdentityRepository,
  InMemorySecurityAuditRepository,
  InMemoryIntentArchiveRepository,
  InMemoryUserRepository,
  InMemorySessionRepository,
} from './repositories.js';
import { createPrismaRepositories, type PrismaBundleOptions } from './prisma_repos.js';

export type RepositoryMode = 'memory' | 'prisma';

/** Backend-agnostic view of the six repositories plus lifecycle helpers. */
export interface RepositoryBundle {
  readonly mode: RepositoryMode;
  readonly requestLog: RequestLogRepository;
  readonly nodeIdentity: NodeIdentityRepository;
  readonly securityAudit: SecurityAuditRepository;
  readonly intentArchive: IntentArchiveRepository;
  readonly user: UserRepository;
  readonly session: SessionRepository;
  /** Prisma: load rows from Postgres into the projection. Memory: no-op. */
  hydrate(): Promise<void>;
  /** Prisma: await pending Postgres writes. Memory: no-op. */
  flush(): Promise<void>;
  /** Prisma: flush then disconnect. Memory: no-op. */
  close(): Promise<void>;
}

/**
 * Create a repository bundle for the requested backend.
 *
 * @param mode    `'memory'` (default) or `'prisma'`.
 * @param options Prisma-only connection options (ignored for `'memory'`).
 */
export function createRepositories(
  mode: RepositoryMode = 'memory',
  options: PrismaBundleOptions = {},
): RepositoryBundle {
  if (mode === 'prisma') {
    const bundle = createPrismaRepositories(options);
    return {
      mode: 'prisma',
      requestLog: bundle.requestLog,
      nodeIdentity: bundle.nodeIdentity,
      securityAudit: bundle.securityAudit,
      intentArchive: bundle.intentArchive,
      user: bundle.user,
      session: bundle.session,
      hydrate: () => bundle.hydrate(),
      flush: () => bundle.flush(),
      close: () => bundle.close(),
    };
  }

  return {
    mode: 'memory',
    requestLog: new InMemoryRequestLogRepository(),
    nodeIdentity: new InMemoryNodeIdentityRepository(),
    securityAudit: new InMemorySecurityAuditRepository(),
    intentArchive: new InMemoryIntentArchiveRepository(),
    user: new InMemoryUserRepository(),
    session: new InMemorySessionRepository(),
    hydrate: async () => {},
    flush: async () => {},
    close: async () => {},
  };
}
