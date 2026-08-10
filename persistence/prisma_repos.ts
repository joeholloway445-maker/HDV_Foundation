/**
 * persistence/prisma_repos.ts — Prisma-backed implementations of the repository
 * interfaces declared in `repositories.ts`.
 *
 * ## Why a write-through cache?
 *
 * The repository interfaces (RequestLogRepository, NodeIdentityRepository,
 * SecurityAuditRepository, IntentArchiveRepository) are **synchronous**: callers such as
 * HOPE's documenter read results inline (`archive.all().map(...)`, `archive.get(id)`),
 * and APEX/KNOLL/nodes write fire-and-forget. Those call sites live in agent packages
 * that must not change. Prisma, however, is asynchronous.
 *
 * To satisfy the *same* synchronous interfaces while durably persisting to Postgres, each
 * repository here keeps an in-memory projection (identical in shape to the InMemory* repos)
 * that serves all synchronous reads, and mirrors every write to Postgres on a serialized
 * async queue. Lifecycle helpers make this deterministic and test-friendly:
 *
 *   - `hydrate()` — load existing rows from Postgres into the projection.
 *   - `flush()`   — await all pending Postgres writes (surfaces the first error, if any).
 *
 * This keeps the running backbone drop-in compatible (no call site changes) while adding a
 * real durable store behind the exact same contract.
 */
import { PrismaClient } from '@prisma/client';

import type { AgentRole, RoutingStatus } from '../config/routing_schema.js';
import type {
  RequestLogRecord,
  NodeIdentityRecord,
  SecurityAuditRecord,
  IntentDocumentRecord,
  UserRecord,
  SessionRecord,
  RequestLogRepository,
  NodeIdentityRepository,
  SecurityAuditRepository,
  IntentArchiveRepository,
  UserRepository,
  SessionRepository,
} from './repositories.js';

// ---------------------------------------------------------------------------
// Serialized async write queue shared by every Prisma repository. Each write is
// isolated so one failure never stalls the chain; the first captured error is
// surfaced by flush().
// ---------------------------------------------------------------------------

class WriteQueue {
  private queue: Promise<void> = Promise.resolve();
  private readonly errors: unknown[] = [];

  enqueue(op: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      try {
        await op();
      } catch (err) {
        this.errors.push(err);
      }
    });
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.errors.length > 0) {
      const first = this.errors.shift();
      this.errors.length = 0;
      throw first;
    }
  }
}

// ---------------------------------------------------------------------------
// RequestLog (APEX ledger)
// ---------------------------------------------------------------------------

export class PrismaRequestLogRepository implements RequestLogRepository {
  private readonly rows: RequestLogRecord[] = [];

  constructor(
    private readonly prisma: PrismaClient,
    private readonly writes: WriteQueue,
  ) {}

  async hydrate(): Promise<void> {
    const found = await this.prisma.requestLog.findMany({ orderBy: { timestamp: 'asc' } });
    this.rows.length = 0;
    for (const r of found) {
      this.rows.push({
        id: r.id,
        packetId: r.packetId,
        timestamp: r.timestamp.getTime(),
        source: r.source as AgentRole,
        destination: r.destination as AgentRole,
        status: r.status as RoutingStatus,
        cost_usd: Number(r.cost_usd),
        knollSignature: r.knollSignature,
      });
    }
  }

  save(record: RequestLogRecord): RequestLogRecord {
    this.rows.push(record);
    this.writes.enqueue(async () => {
      await this.prisma.requestLog.create({
        data: {
          id: record.id,
          packetId: record.packetId,
          timestamp: new Date(record.timestamp),
          source: record.source,
          destination: record.destination,
          status: record.status,
          cost_usd: record.cost_usd,
          knollSignature: record.knollSignature,
        },
      });
    });
    return record;
  }

  all(): readonly RequestLogRecord[] {
    return this.rows;
  }

  findByPacketId(packetId: string): RequestLogRecord | undefined {
    return this.rows.find((r) => r.packetId === packetId);
  }

  countByStatus(status: RoutingStatus): number {
    return this.rows.filter((r) => r.status === status).length;
  }

  clear(): void {
    this.rows.length = 0;
    this.writes.enqueue(async () => {
      await this.prisma.requestLog.deleteMany({});
    });
  }
}

// ---------------------------------------------------------------------------
// NodeIdentity (fleet registry)
// ---------------------------------------------------------------------------

export class PrismaNodeIdentityRepository implements NodeIdentityRepository {
  private readonly rows = new Map<string, NodeIdentityRecord>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly writes: WriteQueue,
  ) {}

  async hydrate(): Promise<void> {
    const found = await this.prisma.nodeIdentity.findMany();
    this.rows.clear();
    for (const r of found) {
      this.rows.set(r.node_id, {
        node_id: r.node_id,
        role: r.role as AgentRole,
        status: r.status as NodeIdentityRecord['status'],
        last_seen: r.last_seen.getTime(),
        is_ephemeral: r.is_ephemeral,
      });
    }
  }

  upsert(record: NodeIdentityRecord): NodeIdentityRecord {
    this.rows.set(record.node_id, record);
    this.writes.enqueue(async () => {
      // `last_seen` is a Prisma `@updatedAt` column, so the database manages it.
      await this.prisma.nodeIdentity.upsert({
        where: { node_id: record.node_id },
        create: {
          node_id: record.node_id,
          role: record.role,
          status: record.status,
          is_ephemeral: record.is_ephemeral,
        },
        update: {
          role: record.role,
          status: record.status,
          is_ephemeral: record.is_ephemeral,
        },
      });
    });
    return record;
  }

  get(nodeId: string): NodeIdentityRecord | undefined {
    return this.rows.get(nodeId);
  }

  all(): readonly NodeIdentityRecord[] {
    return Array.from(this.rows.values());
  }

  countByStatus(status: NodeIdentityRecord['status']): number {
    let n = 0;
    for (const r of this.rows.values()) if (r.status === status) n += 1;
    return n;
  }

  clear(): void {
    this.rows.clear();
    this.writes.enqueue(async () => {
      await this.prisma.nodeIdentity.deleteMany({});
    });
  }
}

// ---------------------------------------------------------------------------
// SecurityAudit (KNOLL verdicts)
// ---------------------------------------------------------------------------

export class PrismaSecurityAuditRepository implements SecurityAuditRepository {
  private readonly rows: SecurityAuditRecord[] = [];

  constructor(
    private readonly prisma: PrismaClient,
    private readonly writes: WriteQueue,
  ) {}

  async hydrate(): Promise<void> {
    const found = await this.prisma.securityAudit.findMany({ orderBy: { timestamp: 'asc' } });
    this.rows.length = 0;
    for (const r of found) {
      this.rows.push({
        id: r.id,
        packetId: r.packetId,
        outcome: r.outcome as SecurityAuditRecord['outcome'],
        reasoning: r.reasoning ?? undefined,
        timestamp: r.timestamp.getTime(),
      });
    }
  }

  save(record: SecurityAuditRecord): SecurityAuditRecord {
    this.rows.push(record);
    this.writes.enqueue(async () => {
      await this.prisma.securityAudit.create({
        data: {
          id: record.id,
          packetId: record.packetId,
          outcome: record.outcome,
          reasoning: record.reasoning ?? null,
          timestamp: new Date(record.timestamp),
        },
      });
    });
    return record;
  }

  all(): readonly SecurityAuditRecord[] {
    return this.rows;
  }

  blocked(): readonly SecurityAuditRecord[] {
    return this.rows.filter((r) => r.outcome === 'BLOCKED');
  }

  clear(): void {
    this.rows.length = 0;
    this.writes.enqueue(async () => {
      await this.prisma.securityAudit.deleteMany({});
    });
  }
}

// ---------------------------------------------------------------------------
// IntentDocument (HOPE intent archive)
// ---------------------------------------------------------------------------

export class PrismaIntentArchiveRepository implements IntentArchiveRepository {
  private readonly rows = new Map<string, IntentDocumentRecord>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly writes: WriteQueue,
  ) {}

  async hydrate(): Promise<void> {
    const found = await this.prisma.intentDocument.findMany({ orderBy: { documentedAt: 'asc' } });
    this.rows.clear();
    for (const r of found) {
      this.rows.set(r.id, {
        id: r.id,
        utterance: r.utterance,
        kind: r.kind,
        entities: asStringArray(r.entities),
        goals: asStringArray(r.goals),
        constraints: asStringArray(r.constraints),
        suggestedDestination: r.suggestedDestination as AgentRole,
        confidence: r.confidence,
        documentedAt: r.documentedAt.getTime(),
        clarificationNeeded: r.clarificationNeeded,
      });
    }
  }

  save(record: IntentDocumentRecord): IntentDocumentRecord {
    this.rows.set(record.id, record);
    this.writes.enqueue(async () => {
      await this.prisma.intentDocument.upsert({
        where: { id: record.id },
        create: {
          id: record.id,
          utterance: record.utterance,
          kind: record.kind,
          entities: record.entities,
          goals: record.goals,
          constraints: record.constraints,
          suggestedDestination: record.suggestedDestination,
          confidence: record.confidence,
          documentedAt: new Date(record.documentedAt),
          clarificationNeeded: record.clarificationNeeded,
        },
        update: {
          utterance: record.utterance,
          kind: record.kind,
          entities: record.entities,
          goals: record.goals,
          constraints: record.constraints,
          suggestedDestination: record.suggestedDestination,
          confidence: record.confidence,
          documentedAt: new Date(record.documentedAt),
          clarificationNeeded: record.clarificationNeeded,
        },
      });
    });
    return record;
  }

  get(id: string): IntentDocumentRecord | undefined {
    return this.rows.get(id);
  }

  all(): readonly IntentDocumentRecord[] {
    return Array.from(this.rows.values());
  }

  needingClarification(): readonly IntentDocumentRecord[] {
    return this.all().filter((r) => r.clarificationNeeded);
  }

  clear(): void {
    this.rows.clear();
    this.writes.enqueue(async () => {
      await this.prisma.intentDocument.deleteMany({});
    });
  }
}

/** Coerce a Prisma JSON column back into a string[] defensively. */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [];
}

// ---------------------------------------------------------------------------
// User (auth/ account identity)
// ---------------------------------------------------------------------------

export class PrismaUserRepository implements UserRepository {
  private readonly rows = new Map<string, UserRecord>(); // by id
  private readonly byEmail = new Map<string, string>(); // email -> id

  constructor(
    private readonly prisma: PrismaClient,
    private readonly writes: WriteQueue,
  ) {}

  async hydrate(): Promise<void> {
    const found = await this.prisma.user.findMany();
    this.rows.clear();
    this.byEmail.clear();
    for (const r of found) {
      const record: UserRecord = {
        id: r.id,
        email: r.email,
        passwordHash: r.passwordHash,
        createdAt: r.createdAt.getTime(),
      };
      this.rows.set(record.id, record);
      this.byEmail.set(record.email, record.id);
    }
  }

  create(record: UserRecord): UserRecord {
    this.rows.set(record.id, record);
    this.byEmail.set(record.email, record.id);
    this.writes.enqueue(async () => {
      await this.prisma.user.create({
        data: {
          id: record.id,
          email: record.email,
          passwordHash: record.passwordHash,
          createdAt: new Date(record.createdAt),
        },
      });
    });
    return record;
  }

  findByEmail(email: string): UserRecord | undefined {
    const id = this.byEmail.get(email);
    return id === undefined ? undefined : this.rows.get(id);
  }

  findById(id: string): UserRecord | undefined {
    return this.rows.get(id);
  }

  clear(): void {
    this.rows.clear();
    this.byEmail.clear();
    this.writes.enqueue(async () => {
      await this.prisma.user.deleteMany({});
    });
  }
}

// ---------------------------------------------------------------------------
// Session (auth/ session tokens)
// ---------------------------------------------------------------------------

export class PrismaSessionRepository implements SessionRepository {
  private readonly rows = new Map<string, SessionRecord>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly writes: WriteQueue,
  ) {}

  async hydrate(): Promise<void> {
    const found = await this.prisma.session.findMany();
    this.rows.clear();
    for (const r of found) {
      this.rows.set(r.token, {
        token: r.token,
        userId: r.userId,
        createdAt: r.createdAt.getTime(),
        expiresAt: r.expiresAt.getTime(),
      });
    }
  }

  create(record: SessionRecord): SessionRecord {
    this.rows.set(record.token, record);
    this.writes.enqueue(async () => {
      await this.prisma.session.create({
        data: {
          token: record.token,
          userId: record.userId,
          createdAt: new Date(record.createdAt),
          expiresAt: new Date(record.expiresAt),
        },
      });
    });
    return record;
  }

  findByToken(token: string): SessionRecord | undefined {
    return this.rows.get(token);
  }

  delete(token: string): void {
    this.rows.delete(token);
    this.writes.enqueue(async () => {
      // deleteMany (not delete) so an already-gone/unknown token never throws into the queue.
      await this.prisma.session.deleteMany({ where: { token } });
    });
  }

  clear(): void {
    this.rows.clear();
    this.writes.enqueue(async () => {
      await this.prisma.session.deleteMany({});
    });
  }
}

// ---------------------------------------------------------------------------
// Bundle + factory
// ---------------------------------------------------------------------------

/** A cohesive set of the six repositories plus lifecycle helpers. */
export interface PrismaRepositoryBundle {
  readonly prisma: PrismaClient;
  readonly requestLog: PrismaRequestLogRepository;
  readonly nodeIdentity: PrismaNodeIdentityRepository;
  readonly securityAudit: PrismaSecurityAuditRepository;
  readonly intentArchive: PrismaIntentArchiveRepository;
  readonly user: PrismaUserRepository;
  readonly session: PrismaSessionRepository;
  /** Load existing rows from Postgres into every in-memory projection. */
  hydrate(): Promise<void>;
  /** Await all pending Postgres writes across every repository. */
  flush(): Promise<void>;
  /** Flush pending writes, then disconnect the Prisma client. */
  close(): Promise<void>;
}

export interface PrismaBundleOptions {
  /** Provide a pre-built client (e.g. a mock or a shared pool); otherwise one is created. */
  client?: PrismaClient;
  /** Override the connection URL (defaults to the DATABASE_URL env var). */
  datasourceUrl?: string;
}

/** Build the Prisma-backed repository bundle. Does not touch the DB until used. */
export function createPrismaRepositories(options: PrismaBundleOptions = {}): PrismaRepositoryBundle {
  const prisma =
    options.client ??
    new PrismaClient(
      options.datasourceUrl ? { datasourceUrl: options.datasourceUrl } : undefined,
    );
  const writes = new WriteQueue();

  const requestLog = new PrismaRequestLogRepository(prisma, writes);
  const nodeIdentity = new PrismaNodeIdentityRepository(prisma, writes);
  const securityAudit = new PrismaSecurityAuditRepository(prisma, writes);
  const intentArchive = new PrismaIntentArchiveRepository(prisma, writes);
  const user = new PrismaUserRepository(prisma, writes);
  const session = new PrismaSessionRepository(prisma, writes);

  return {
    prisma,
    requestLog,
    nodeIdentity,
    securityAudit,
    intentArchive,
    user,
    session,
    async hydrate() {
      await Promise.all([
        requestLog.hydrate(),
        nodeIdentity.hydrate(),
        securityAudit.hydrate(),
        intentArchive.hydrate(),
        user.hydrate(),
        session.hydrate(),
      ]);
    },
    async flush() {
      await writes.flush();
    },
    async close() {
      await writes.flush();
      await prisma.$disconnect();
    },
  };
}
