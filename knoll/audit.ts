/**
 * knoll/audit.ts — in-memory security audit log (master auditor).
 *
 * Maps onto the `SecurityAudit` Prisma model. Phase 1 keeps entries in memory; the
 * shape is intentionally identical to the durable model for a later swap.
 */
import { randomUUID } from 'node:crypto';
import type { SecurityAuditRepository } from '../persistence/repositories.js';

export interface SecurityAuditEntry {
  id: string;
  packetId: string;
  outcome: 'ALLOWED' | 'BLOCKED';
  reasoning?: string;
  timestamp: number;
}

export interface SecurityAuditLogOptions {
  /**
   * Optional repository every verdict is mirrored into. Lets KNOLL's in-memory audit
   * parallel-store into a (later DB-backed) SecurityAuditRepository without changing
   * KNOLL's monitor-only behavior. Defaults to no mirror (Phase 1 behavior).
   */
  repository?: SecurityAuditRepository;
}

export class SecurityAuditLog {
  private readonly entries: SecurityAuditEntry[] = [];
  private readonly repository?: SecurityAuditRepository;

  constructor(options: SecurityAuditLogOptions = {}) {
    this.repository = options.repository;
  }

  record(packetId: string, outcome: 'ALLOWED' | 'BLOCKED', reasoning?: string): SecurityAuditEntry {
    const entry: SecurityAuditEntry = {
      id: randomUUID(),
      packetId,
      outcome,
      reasoning,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    // Mirror into the durable-shaped repository when wired (SecurityAudit Prisma model).
    this.repository?.save({ ...entry });
    return entry;
  }

  all(): readonly SecurityAuditEntry[] {
    return this.entries;
  }

  blocked(): readonly SecurityAuditEntry[] {
    return this.entries.filter((e) => e.outcome === 'BLOCKED');
  }

  count(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
