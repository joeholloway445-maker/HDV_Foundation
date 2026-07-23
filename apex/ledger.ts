/**
 * apex/ledger.ts — the APEX billing ledger (master router's accounting).
 *
 * Every packet APEX attempts to route produces one ledger entry, and every ephemeral
 * execution is billed with `cost_usd`. Entries map onto the `RequestLog` Prisma model,
 * so the in-memory store here is a drop-in for a Phase 2 database implementation.
 */
import type { AgentRole, RoutingStatus } from '../config/routing_schema.js';
import type { RequestLogRepository } from '../persistence/repositories.js';

export interface LedgerEntry {
  id: string;
  packetId: string;
  timestamp: number;
  source: AgentRole;
  destination: AgentRole;
  status: RoutingStatus;
  cost_usd: number;
  knollSignature: string;
}

export interface LogRequestInput {
  packetId: string;
  source: AgentRole;
  destination: AgentRole;
  status: RoutingStatus;
  cost_usd?: number;
  knollSignature: string;
  timestamp?: number;
}

/** Interface so APEX (and personamatrix, conceptually) can bill against any backend. */
export interface BillingLedger {
  logRequest(input: LogRequestInput): LedgerEntry;
  request(input: LogRequestInput): LedgerEntry;
  totalCost(): number;
  entries(): readonly LedgerEntry[];
}

export interface InMemoryLedgerOptions {
  /**
   * Optional repository the ledger mirrors every row into. Lets the in-memory ledger
   * parallel-store into a (later DB-backed) RequestLogRepository without changing call
   * sites. Defaults to no mirror — pure in-memory behavior, unchanged from Phase 1.
   */
  repository?: RequestLogRepository;
}

export class InMemoryLedger implements BillingLedger {
  private readonly rows: LedgerEntry[] = [];
  private seq = 0;
  private readonly repository?: RequestLogRepository;

  constructor(options: InMemoryLedgerOptions = {}) {
    this.repository = options.repository;
  }

  logRequest(input: LogRequestInput): LedgerEntry {
    const entry: LedgerEntry = {
      id: `led_${(++this.seq).toString().padStart(8, '0')}`,
      packetId: input.packetId,
      timestamp: input.timestamp ?? Date.now(),
      source: input.source,
      destination: input.destination,
      status: input.status,
      cost_usd: round2(input.cost_usd ?? 0),
      knollSignature: input.knollSignature,
    };
    this.rows.push(entry);
    // Mirror into the durable-shaped repository when one is wired (optional; the
    // RequestLog Prisma model has identical field names).
    this.repository?.save({ ...entry });
    return entry;
  }

  /**
   * PersonaMatrix.request() — records the cost of a single ephemeral execution.
   * Alias of logRequest with the vocabulary used by the persona matrix billing model.
   */
  request(input: LogRequestInput): LedgerEntry {
    return this.logRequest(input);
  }

  totalCost(): number {
    return round2(this.rows.reduce((sum, r) => sum + r.cost_usd, 0));
  }

  costByStatus(status: RoutingStatus): number {
    return round2(this.rows.filter((r) => r.status === status).reduce((s, r) => s + r.cost_usd, 0));
  }

  countByStatus(status: RoutingStatus): number {
    return this.rows.filter((r) => r.status === status).length;
  }

  entries(): readonly LedgerEntry[] {
    return this.rows;
  }

  clear(): void {
    this.rows.length = 0;
    this.seq = 0;
  }
}

/**
 * Round to 6 decimal places. Persona-level costs are fractions of a cent, so cent-level
 * rounding would erase them; 6dp keeps micro-billing intact while removing FP dust.
 */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}
