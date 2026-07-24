/**
 * knoll/hashchain.ts — a tamper-evident hash-chain (blockchain-style Merkle spine) over the
 * KNOLL SecurityAudit log (Phase 8 security & compliance).
 *
 * Every KNOLL verdict already produces a `SecurityAuditEntry`. On their own those entries can
 * be silently edited, reordered, or dropped by anyone with write access to the store. This
 * module binds them into an append-only chain: each link commits to (a) the canonical content
 * of its audit entry and (b) the hash of the previous link. Changing, removing, or reordering
 * any historical entry breaks every hash from that point forward, so tampering is detectable
 * with a single `verify()` pass.
 *
 * Dependency-free (node:crypto only) and monitor-only: it observes the audit log and NEVER
 * mutates a packet, a verdict, or the audit entries themselves.
 */
import { createHash } from 'node:crypto';
import type { SecurityAuditEntry } from './audit.js';

/** One link in the audit hash-chain. `hash = SHA256(index | prevHash | entryHash)`. */
export interface HashChainLink {
  /** 0-based position in the chain. */
  index: number;
  /** The audit entry committed by this link. */
  entry: SecurityAuditEntry;
  /** SHA-256 over the canonical audit-entry content (independent of chain position). */
  entryHash: string;
  /** Hash of the previous link (or the genesis constant for index 0). */
  prevHash: string;
  /** This link's hash: SHA256(index | prevHash | entryHash). */
  hash: string;
}

/** Result of verifying a chain (or a chain against a fresh audit snapshot). */
export interface HashChainVerification {
  valid: boolean;
  /** Number of links checked. */
  length: number;
  /** Index of the first broken link, or -1 when the chain is intact. */
  brokenAt: number;
  /** Human-readable reason when `valid` is false. */
  reason?: string;
}

/** The fixed genesis hash the first link chains from. */
export const GENESIS_HASH = '0'.repeat(64);

/** Canonicalize the tamper-protected content of one audit entry (stable field order). */
function canonicalizeEntry(entry: SecurityAuditEntry): string {
  return JSON.stringify({
    id: entry.id,
    packetId: entry.packetId,
    outcome: entry.outcome,
    reasoning: entry.reasoning ?? null,
    timestamp: entry.timestamp,
  });
}

/** SHA-256 over the canonical audit-entry content. */
export function hashAuditEntry(entry: SecurityAuditEntry): string {
  return createHash('sha256').update(canonicalizeEntry(entry)).digest('hex');
}

/** Compute a link hash from its position, the previous hash, and the entry hash. */
export function computeLinkHash(index: number, prevHash: string, entryHash: string): string {
  return createHash('sha256').update(`${index}|${prevHash}|${entryHash}`).digest('hex');
}

/**
 * AuditHashChain — an append-only Merkle/hash-chain over SecurityAudit entries.
 *
 * Typical use: `append()` each entry as KNOLL records it (or `rebuild()` from a snapshot),
 * then `verify()` at any time, and `detectTamper(currentEntries)` to prove the persisted
 * audit log still matches the sealed chain.
 */
export class AuditHashChain {
  private readonly links: HashChainLink[] = [];

  /** Append one audit entry, sealing it against the current chain head. Returns the new link. */
  append(entry: SecurityAuditEntry): HashChainLink {
    const index = this.links.length;
    const prevHash = index === 0 ? GENESIS_HASH : this.links[index - 1].hash;
    const entryHash = hashAuditEntry(entry);
    const hash = computeLinkHash(index, prevHash, entryHash);
    const link: HashChainLink = { index, entry, entryHash, prevHash, hash };
    this.links.push(link);
    return link;
  }

  /** Append many entries in order. Returns the resulting chain head hash. */
  appendAll(entries: Iterable<SecurityAuditEntry>): string {
    for (const e of entries) this.append(e);
    return this.head();
  }

  /** Rebuild the chain from scratch over the given entries (replaces any current links). */
  rebuild(entries: Iterable<SecurityAuditEntry>): string {
    this.links.length = 0;
    return this.appendAll(entries);
  }

  /** The current chain head hash (GENESIS_HASH when empty). */
  head(): string {
    return this.links.length === 0 ? GENESIS_HASH : this.links[this.links.length - 1].hash;
  }

  /** Number of links in the chain. */
  get length(): number {
    return this.links.length;
  }

  /** A read-only view of the chain links. */
  chain(): readonly HashChainLink[] {
    return this.links;
  }

  /**
   * Verify the chain is internally consistent: every link's entryHash matches its entry, its
   * prevHash matches the prior link's hash, and its own hash is correctly derived.
   */
  verify(): HashChainVerification {
    return verifyLinks(this.links);
  }

  /**
   * Detect tampering by re-deriving a chain from a *current* audit snapshot and comparing it
   * to this sealed chain. Any edit, reorder, insertion, or deletion surfaces as the first
   * index where the head hashes diverge.
   */
  detectTamper(currentEntries: readonly SecurityAuditEntry[]): HashChainVerification {
    if (currentEntries.length !== this.links.length) {
      const brokenAt = Math.min(currentEntries.length, this.links.length);
      return {
        valid: false,
        length: this.links.length,
        brokenAt,
        reason: `audit length changed: sealed ${this.links.length}, now ${currentEntries.length}`,
      };
    }
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < currentEntries.length; i++) {
      const entryHash = hashAuditEntry(currentEntries[i]);
      const hash = computeLinkHash(i, prevHash, entryHash);
      if (hash !== this.links[i].hash) {
        return {
          valid: false,
          length: this.links.length,
          brokenAt: i,
          reason: `audit entry at index ${i} does not match the sealed chain`,
        };
      }
      prevHash = hash;
    }
    return { valid: true, length: this.links.length, brokenAt: -1 };
  }
}

/** Verify an arbitrary sequence of links is a consistent hash-chain. */
export function verifyLinks(links: readonly HashChainLink[]): HashChainVerification {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (link.index !== i) {
      return { valid: false, length: links.length, brokenAt: i, reason: `link index ${link.index} != position ${i}` };
    }
    if (link.prevHash !== prevHash) {
      return { valid: false, length: links.length, brokenAt: i, reason: `prevHash mismatch at index ${i}` };
    }
    if (hashAuditEntry(link.entry) !== link.entryHash) {
      return { valid: false, length: links.length, brokenAt: i, reason: `entry content altered at index ${i}` };
    }
    if (computeLinkHash(i, link.prevHash, link.entryHash) !== link.hash) {
      return { valid: false, length: links.length, brokenAt: i, reason: `link hash invalid at index ${i}` };
    }
    prevHash = link.hash;
  }
  return { valid: true, length: links.length, brokenAt: -1 };
}
