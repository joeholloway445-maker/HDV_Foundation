/**
 * knoll/audit.ts — in-memory security audit log (master auditor).
 *
 * Maps onto the `SecurityAudit` Prisma model. Phase 1 keeps entries in memory; the
 * shape is intentionally identical to the durable model for a later swap.
 */
import { randomUUID } from 'node:crypto';

export interface SecurityAuditEntry {
  id: string;
  packetId: string;
  outcome: 'ALLOWED' | 'BLOCKED';
  reasoning?: string;
  timestamp: number;
}

export class SecurityAuditLog {
  private readonly entries: SecurityAuditEntry[] = [];

  record(packetId: string, outcome: 'ALLOWED' | 'BLOCKED', reasoning?: string): SecurityAuditEntry {
    const entry: SecurityAuditEntry = {
      id: randomUUID(),
      packetId,
      outcome,
      reasoning,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
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
