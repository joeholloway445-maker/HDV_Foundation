/**
 * hash.ts — neutral, dependency-free hashing utilities shared by APEX (which produces
 * packet hashes) and KNOLL (which verifies them). Placing this in `config/` keeps it
 * agent-neutral so neither security nor orchestration imports the other.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { RoutingPacket } from './routing_schema.js';

/**
 * Deterministic canonicalization of the tamper-protected portion of a packet
 * (header + payload). `security` is intentionally excluded — the hash protects
 * everything *except* the hash/token themselves.
 *
 * Keys are emitted in a fixed order so two structurally-identical packets always
 * serialize to the same string regardless of property insertion order.
 */
export function canonicalize(packet: Pick<RoutingPacket, 'header' | 'payload'>): string {
  const { header, payload } = packet;
  const canonical = {
    header: {
      packetId: header.packetId,
      timestamp: header.timestamp,
      source: header.source,
      destination: header.destination,
      priority: header.priority,
    },
    payload: {
      intent: payload.intent,
      data: sortValue(payload.data),
    },
  };
  return JSON.stringify(canonical);
}

/** Recursively sort object keys so JSON.stringify is order-independent. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = sortValue(v);
    }
    return out;
  }
  return value;
}

/** Compute the SHA-256 hash over the canonical (header + payload) content. */
export function computePacketHash(packet: Pick<RoutingPacket, 'header' | 'payload'>): string {
  return createHash('sha256').update(canonicalize(packet)).digest('hex');
}

/** Generate a unique packet id. */
export function newPacketId(): string {
  return `pkt_${randomUUID()}`;
}

/** Generate a KNOLL transport token. Well-formed tokens carry the `knoll_` prefix. */
export function newKnollToken(): string {
  return `knoll_${randomUUID().replace(/-/g, '')}`;
}

/** Structural check for a well-formed KNOLL token. */
export function isWellFormedKnollToken(token: unknown): token is string {
  return typeof token === 'string' && /^knoll_[a-f0-9]{32}$/.test(token);
}
