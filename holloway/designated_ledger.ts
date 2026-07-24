/**
 * holloway/designated_ledger.ts — the Designated Audit Ledger of the sovereign layer.
 *
 * This is the tamper-evident record of sovereign action. It captures the three classes of
 * event that must never be silently editable:
 *   - OVERRIDE            — an Acting-Prime directive was countermanded, or a freeze/unfreeze
 *                           override token was exercised.
 *   - ANOMALOUS_COMMAND   — a directive flagged as unusual / outside normal operating envelope.
 *   - CRITICAL_OOB_DECISION — a critical out-of-band decision taken outside the routed path.
 *
 * Guarantees:
 *   - APPEND-ONLY: there is no update or delete surface. `record()` only ever grows the log.
 *   - HASH-CHAINED: each link commits to the canonical record content AND the prior link hash,
 *     following the same Merkle-spine pattern as `knoll/hashchain.ts` (re-implemented here with
 *     node:crypto so the sovereign layer stays dependency-free of any peer/agent module).
 *   - ACCESS-CONTROLLED READ: only the Acting Prime, a Former Prime, or PRIME HOPE may read;
 *     every other reader throws {@link ForbiddenLedgerAccess}.
 */
import { createHash } from 'node:crypto';
import type { HollowayIdentity, PrimeRegistry } from './types.js';
import { PRIME_HOPE, type PrimeHopeToken, isPrimeHopeToken } from './prime_hope.js';

/** The classes of sovereign event the ledger records. */
export type LedgerRecordKind = 'OVERRIDE' | 'ANOMALOUS_COMMAND' | 'CRITICAL_OOB_DECISION';

/** One recorded sovereign event (the tamper-protected content of a link). */
export interface DesignatedLedgerRecord {
  /** Monotonic ledger id, e.g. `dal_00000001`. */
  readonly id: string;
  readonly kind: LedgerRecordKind;
  /** Short human-readable summary of the event. */
  readonly summary: string;
  /** Sovereign id responsible for the event (Acting/Former Prime), or a system marker. */
  readonly actorId: string;
  /** Opaque structured detail. */
  readonly data: Record<string, unknown>;
  /** Epoch milliseconds. */
  readonly timestamp: number;
}

/** Input to {@link DesignatedAuditLedger.record}. */
export interface RecordInput {
  kind: LedgerRecordKind;
  summary: string;
  actorId: string;
  data?: Record<string, unknown>;
  timestamp?: number;
}

/** One link in the append-only, hash-chained ledger. */
export interface DesignatedLedgerLink {
  /** 0-based position in the chain. */
  readonly index: number;
  /** The sovereign event committed by this link. */
  readonly record: DesignatedLedgerRecord;
  /** SHA-256 over the canonical record content (independent of chain position). */
  readonly recordHash: string;
  /** Hash of the previous link (or {@link GENESIS_HASH} for index 0). */
  readonly prevHash: string;
  /** This link's hash: SHA256(index | prevHash | recordHash). */
  readonly hash: string;
}

/** Result of verifying ledger integrity. */
export interface LedgerVerification {
  valid: boolean;
  length: number;
  /** Index of the first broken link, or -1 when the chain is intact. */
  brokenAt: number;
  reason?: string;
}

/** A principal permitted to attempt a ledger read. */
export type LedgerReader = HollowayIdentity | PrimeHopeToken;

/** The fixed genesis hash the first link chains from. */
export const GENESIS_HASH = '0'.repeat(64);

/** Thrown when a non-sovereign principal attempts to read the Designated Audit Ledger. */
export class ForbiddenLedgerAccess extends Error {
  /** Best-effort identifier of the rejected reader (for the caller's own audit trail). */
  readonly readerId: string;

  constructor(readerId: string) {
    super(
      `ForbiddenLedgerAccess: '${readerId}' may not read the Designated Audit Ledger — ` +
        'only the Acting Prime, a Former Prime, or Prime Hope may read.',
    );
    this.name = 'ForbiddenLedgerAccess';
    this.readerId = readerId;
  }
}

/** Canonicalize the tamper-protected content of one record (stable field order). */
function canonicalizeRecord(record: DesignatedLedgerRecord): string {
  return JSON.stringify({
    id: record.id,
    kind: record.kind,
    summary: record.summary,
    actorId: record.actorId,
    data: record.data,
    timestamp: record.timestamp,
  });
}

/** SHA-256 over the canonical record content. */
export function hashLedgerRecord(record: DesignatedLedgerRecord): string {
  return createHash('sha256').update(canonicalizeRecord(record)).digest('hex');
}

/** Compute a link hash from its position, the previous hash, and the record hash. */
export function computeLinkHash(index: number, prevHash: string, recordHash: string): string {
  return createHash('sha256').update(`${index}|${prevHash}|${recordHash}`).digest('hex');
}

export interface DesignatedAuditLedgerOptions {
  /**
   * Optional authority registry for id-based read authorization. When provided, a reader that
   * presents a sovereign role must ALSO be a live member (its `id` known to the registry),
   * defending against a forged identity that merely claims a role. When omitted, authorization
   * falls back to the reader's declared role.
   */
  registry?: PrimeRegistry;
}

/**
 * DesignatedAuditLedger — append-only, hash-chained, access-controlled sovereign audit log.
 */
export class DesignatedAuditLedger {
  private readonly links: DesignatedLedgerLink[] = [];
  private seq = 0;
  private readonly registry?: PrimeRegistry;

  constructor(options: DesignatedAuditLedgerOptions = {}) {
    this.registry = options.registry;
  }

  /**
   * Append one sovereign event, sealing it against the current chain head. This is the ONLY
   * mutating operation — the ledger has no update or delete surface.
   */
  record(input: RecordInput): DesignatedLedgerLink {
    const index = this.links.length;
    const record: DesignatedLedgerRecord = {
      id: `dal_${(++this.seq).toString().padStart(8, '0')}`,
      kind: input.kind,
      summary: input.summary,
      actorId: input.actorId,
      data: input.data ?? {},
      timestamp: input.timestamp ?? Date.now(),
    };
    const prevHash = index === 0 ? GENESIS_HASH : this.links[index - 1].hash;
    const recordHash = hashLedgerRecord(record);
    const hash = computeLinkHash(index, prevHash, recordHash);
    const link: DesignatedLedgerLink = { index, record, recordHash, prevHash, hash };
    this.links.push(link);
    return link;
  }

  /** Convenience recorders for the three sovereign event classes. */
  recordOverride(actorId: string, summary: string, data?: Record<string, unknown>): DesignatedLedgerLink {
    return this.record({ kind: 'OVERRIDE', actorId, summary, data });
  }

  recordAnomalousCommand(
    actorId: string,
    summary: string,
    data?: Record<string, unknown>,
  ): DesignatedLedgerLink {
    return this.record({ kind: 'ANOMALOUS_COMMAND', actorId, summary, data });
  }

  recordCriticalOutOfBand(
    actorId: string,
    summary: string,
    data?: Record<string, unknown>,
  ): DesignatedLedgerLink {
    return this.record({ kind: 'CRITICAL_OOB_DECISION', actorId, summary, data });
  }

  /** The number of sealed links (readable without authorization; reveals no content). */
  get length(): number {
    return this.links.length;
  }

  /** The current chain head hash (GENESIS_HASH when empty; reveals no content). */
  head(): string {
    return this.links.length === 0 ? GENESIS_HASH : this.links[this.links.length - 1].hash;
  }

  /**
   * Read the full ledger. ACCESS-CONTROLLED: only the Acting Prime, a Former Prime, or
   * PRIME HOPE may read. Every other principal throws {@link ForbiddenLedgerAccess}.
   *
   * @throws {ForbiddenLedgerAccess} for any non-sovereign reader.
   */
  read(reader: LedgerReader): readonly DesignatedLedgerLink[] {
    this.authorize(reader);
    // Return a shallow copy so callers cannot splice/reorder the live chain.
    return this.links.slice();
  }

  /**
   * Read only the records (without chain metadata). Same access control as {@link read}.
   *
   * @throws {ForbiddenLedgerAccess} for any non-sovereign reader.
   */
  readRecords(reader: LedgerReader): readonly DesignatedLedgerRecord[] {
    return this.read(reader).map((link) => link.record);
  }

  /** True iff `reader` is permitted to read, without throwing. */
  canRead(reader: LedgerReader): boolean {
    try {
      this.authorize(reader);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verify the chain is internally consistent: every link's recordHash matches its record,
   * its prevHash matches the prior link's hash, and its own hash is correctly derived.
   * Integrity verification is unprivileged (it exposes no record content).
   */
  verify(): LedgerVerification {
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < this.links.length; i++) {
      const link = this.links[i];
      if (link.index !== i) {
        return { valid: false, length: this.links.length, brokenAt: i, reason: `link index ${link.index} != position ${i}` };
      }
      if (link.prevHash !== prevHash) {
        return { valid: false, length: this.links.length, brokenAt: i, reason: `prevHash mismatch at index ${i}` };
      }
      if (hashLedgerRecord(link.record) !== link.recordHash) {
        return { valid: false, length: this.links.length, brokenAt: i, reason: `record content altered at index ${i}` };
      }
      if (computeLinkHash(i, link.prevHash, link.recordHash) !== link.hash) {
        return { valid: false, length: this.links.length, brokenAt: i, reason: `link hash invalid at index ${i}` };
      }
      prevHash = link.hash;
    }
    return { valid: true, length: this.links.length, brokenAt: -1 };
  }

  /** Enforce the read boundary; throws {@link ForbiddenLedgerAccess} on denial. */
  private authorize(reader: LedgerReader): void {
    if (isPrimeHopeToken(reader)) return;

    if (isSovereignIdentity(reader)) {
      // Role check first.
      const roleOk = reader.role === 'ACTING_PRIME' || reader.role === 'FORMER_PRIME';
      if (roleOk) {
        // If a registry is wired, the id must ALSO be live (anti-forgery).
        if (!this.registry) return;
        if (reader.role === 'ACTING_PRIME' && this.registry.isActingPrime(reader.id)) return;
        if (reader.role === 'FORMER_PRIME' && this.registry.isFormerPrime(reader.id)) return;
      }
    }

    throw new ForbiddenLedgerAccess(readerLabel(reader));
  }
}

/** Structural guard for a sovereign identity object (defensive; accepts unknown shapes). */
function isSovereignIdentity(value: unknown): value is HollowayIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { role?: unknown }).role === 'string'
  );
}

/** Best-effort label for an arbitrary rejected reader (for the error message). */
function readerLabel(reader: unknown): string {
  if (reader === PRIME_HOPE) return PRIME_HOPE;
  if (isSovereignIdentity(reader)) return `${reader.role}:${reader.id}`;
  if (typeof reader === 'object' && reader !== null) {
    const id = (reader as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return String(reader);
}
