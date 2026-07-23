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

/** Convenience: generate a persistence row id (uuid-backed). */
export function newRowId(prefix = 'row'): string {
  return `${prefix}_${randomUUID()}`;
}
