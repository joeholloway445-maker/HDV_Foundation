/**
 * persistence/repositories.ts — repository interfaces + in-memory implementations.
 *
 * Phase 2 persistence layer. These interfaces mirror the Prisma models in
 * `config/schema.prisma` exactly (RequestLog, NodeIdentity, SecurityAudit, and the new
 * IntentDocument). The in-memory implementations are drop-in defaults so the running
 * backbone never requires a real Postgres; a Phase 4 Prisma-backed implementation can
 * satisfy the same interfaces without touching call sites.
 *
 * This module imports ONLY from `config/` so it stays agent-neutral: APEX (ledger),
 * KNOLL (audit), and HOPE (intent archive) can all optionally wrap a repository without
 * creating cross-agent coupling.
 */
import { randomUUID } from 'node:crypto';
import type { AgentRole, RoutingStatus } from '../config/routing_schema.js';

// ---------------------------------------------------------------------------
// Record shapes — one per Prisma model. Field names match schema.prisma so the
// in-memory store is a faithful stand-in for the durable table.
// ---------------------------------------------------------------------------

/** Mirrors the RequestLog model (APEX ledger row). */
export interface RequestLogRecord {
  id: string;
  packetId: string;
  timestamp: number;
  source: AgentRole;
  destination: AgentRole;
  status: RoutingStatus;
  cost_usd: number;
  knollSignature: string;
}

/** Mirrors the NodeIdentity model (one row per fleet node). */
export interface NodeIdentityRecord {
  node_id: string;
  role: AgentRole;
  status: 'ACTIVE' | 'IDLE' | 'TERMINATED';
  last_seen: number;
  is_ephemeral: boolean;
}

/** Mirrors the SecurityAudit model (one row per KNOLL verdict). */
export interface SecurityAuditRecord {
  id: string;
  packetId: string;
  outcome: 'ALLOWED' | 'BLOCKED';
  reasoning?: string;
  timestamp: number;
}

/** Mirrors the IntentDocument model (Hope's documented user intent). */
export interface IntentDocumentRecord {
  id: string;
  utterance: string;
  kind: string;
  entities: string[];
  goals: string[];
  constraints: string[];
  suggestedDestination: AgentRole;
  confidence: number;
  documentedAt: number;
  clarificationNeeded: boolean;
}

/** Mirrors the User model (auth/) — one row per registered email+password account. */
export interface UserRecord {
  id: string;
  email: string;
  /** `scrypt` salt:hash encoding — see auth/service.ts. NEVER the raw password. */
  passwordHash: string;
  createdAt: number;
}

/** Mirrors the Session model (auth/) — one row per active login. */
export interface SessionRecord {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------------

export interface RequestLogRepository {
  save(record: RequestLogRecord): RequestLogRecord;
  all(): readonly RequestLogRecord[];
  findByPacketId(packetId: string): RequestLogRecord | undefined;
  countByStatus(status: RoutingStatus): number;
  clear(): void;
}

export interface NodeIdentityRepository {
  upsert(record: NodeIdentityRecord): NodeIdentityRecord;
  get(nodeId: string): NodeIdentityRecord | undefined;
  all(): readonly NodeIdentityRecord[];
  countByStatus(status: NodeIdentityRecord['status']): number;
  clear(): void;
}

export interface SecurityAuditRepository {
  save(record: SecurityAuditRecord): SecurityAuditRecord;
  all(): readonly SecurityAuditRecord[];
  blocked(): readonly SecurityAuditRecord[];
  clear(): void;
}

export interface IntentArchiveRepository {
  save(record: IntentDocumentRecord): IntentDocumentRecord;
  get(id: string): IntentDocumentRecord | undefined;
  all(): readonly IntentDocumentRecord[];
  needingClarification(): readonly IntentDocumentRecord[];
  clear(): void;
}

/** Account identity (auth/). Email is the natural key; findByEmail must be case-normalized
 *  by the caller (AuthService lower-cases before every read/write). */
export interface UserRepository {
  create(record: UserRecord): UserRecord;
  findByEmail(email: string): UserRecord | undefined;
  findById(id: string): UserRecord | undefined;
  clear(): void;
}

/** Session tokens (auth/). Token is the primary key. */
export interface SessionRepository {
  create(record: SessionRecord): SessionRecord;
  findByToken(token: string): SessionRecord | undefined;
  delete(token: string): void;
  clear(): void;
}

// ---------------------------------------------------------------------------
// In-memory implementations
// ---------------------------------------------------------------------------

export class InMemoryRequestLogRepository implements RequestLogRepository {
  private readonly rows: RequestLogRecord[] = [];

  save(record: RequestLogRecord): RequestLogRecord {
    this.rows.push(record);
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
  }
}

export class InMemoryNodeIdentityRepository implements NodeIdentityRepository {
  private readonly rows = new Map<string, NodeIdentityRecord>();

  upsert(record: NodeIdentityRecord): NodeIdentityRecord {
    this.rows.set(record.node_id, record);
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
  }
}

export class InMemorySecurityAuditRepository implements SecurityAuditRepository {
  private readonly rows: SecurityAuditRecord[] = [];

  save(record: SecurityAuditRecord): SecurityAuditRecord {
    this.rows.push(record);
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
  }
}

export class InMemoryIntentArchiveRepository implements IntentArchiveRepository {
  private readonly rows = new Map<string, IntentDocumentRecord>();

  save(record: IntentDocumentRecord): IntentDocumentRecord {
    this.rows.set(record.id, record);
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
  }
}

export class InMemoryUserRepository implements UserRepository {
  private readonly rows = new Map<string, UserRecord>(); // keyed by id
  private readonly byEmail = new Map<string, string>(); // email -> id

  create(record: UserRecord): UserRecord {
    this.rows.set(record.id, record);
    this.byEmail.set(record.email, record.id);
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
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private readonly rows = new Map<string, SessionRecord>();

  create(record: SessionRecord): SessionRecord {
    this.rows.set(record.token, record);
    return record;
  }
  findByToken(token: string): SessionRecord | undefined {
    return this.rows.get(token);
  }
  delete(token: string): void {
    this.rows.delete(token);
  }
  clear(): void {
    this.rows.clear();
  }
}

/** Convenience: generate a persistence row id (uuid-backed). */
export function newRowId(prefix = 'row'): string {
  return `${prefix}_${randomUUID()}`;
}
