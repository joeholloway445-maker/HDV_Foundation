/**
 * apex/packet.ts — helpers to construct valid RoutingPackets.
 *
 * APEX is the only component that mints packets on behalf of agents (agents describe
 * *what* they want; APEX stamps a legal, hashed, tokenized envelope). Every packet gets
 * a correct SHA-256 hash and a well-formed knoll_token. Malformed inputs are rejected.
 */
import {
  AgentRole,
  type PacketPriority,
  type RoutingPacket,
} from '../config/routing_schema.js';
import { computePacketHash, isWellFormedKnollToken, newKnollToken, newPacketId } from '../config/hash.js';

export interface CreatePacketInput {
  source: AgentRole;
  destination: AgentRole;
  intent: string;
  data?: Record<string, unknown>;
  priority?: PacketPriority;
  /** Optional pre-issued KNOLL token; a fresh one is minted when omitted. */
  knollToken?: string;
  /** Optional fixed timestamp (for deterministic tests). */
  timestamp?: number;
  /**
   * Optional tenant identifier (Phase 8 multi-tenancy). ADDITIVE: when omitted the packet has
   * no tenant scope (dev / single-tenant) and behaves exactly like a Phase 1 packet.
   */
  tenantId?: string;
}

/** Construct a fully-valid RoutingPacket with a correct hash and token. */
export function createPacket(input: CreatePacketInput): RoutingPacket {
  if (!Object.values(AgentRole).includes(input.source)) {
    throw new Error(`createPacket: invalid source role "${input.source}"`);
  }
  if (!Object.values(AgentRole).includes(input.destination)) {
    throw new Error(`createPacket: invalid destination role "${input.destination}"`);
  }
  if (typeof input.intent !== 'string' || input.intent.length === 0) {
    throw new Error('createPacket: intent must be a non-empty string');
  }

  const token = input.knollToken ?? newKnollToken();
  if (!isWellFormedKnollToken(token)) {
    throw new Error('createPacket: provided knollToken is malformed');
  }

  const base = {
    header: {
      packetId: newPacketId(),
      timestamp: input.timestamp ?? Date.now(),
      source: input.source,
      destination: input.destination,
      priority: input.priority ?? 'STANDARD',
      // Only stamp tenantId when supplied so tenant-less packets stay byte-identical to Phase 1.
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    },
    payload: {
      intent: input.intent,
      data: input.data ?? {},
    },
  } satisfies Pick<RoutingPacket, 'header' | 'payload'>;

  const hash = computePacketHash(base);

  return {
    ...base,
    security: {
      knoll_token: token,
      hash,
    },
  };
}

/**
 * Structural validation of an arbitrary value as a RoutingPacket. Used defensively;
 * KNOLL performs the authoritative check, but APEX also refuses to touch garbage.
 */
export function isRoutingPacket(value: unknown): value is RoutingPacket {
  if (value === null || typeof value !== 'object') return false;
  const p = value as Partial<RoutingPacket>;
  const h = p.header;
  const pay = p.payload;
  const sec = p.security;
  return (
    !!h &&
    typeof h.packetId === 'string' &&
    typeof h.timestamp === 'number' &&
    typeof h.source === 'string' &&
    typeof h.destination === 'string' &&
    (h.priority === 'CRITICAL' || h.priority === 'STANDARD' || h.priority === 'BACKGROUND') &&
    !!pay &&
    typeof pay.intent === 'string' &&
    !!pay.data &&
    typeof pay.data === 'object' &&
    !!sec &&
    typeof sec.knoll_token === 'string' &&
    typeof sec.hash === 'string'
  );
}

/** Recompute and verify a packet's hash without involving KNOLL. */
export function verifyPacketHash(packet: RoutingPacket): boolean {
  return computePacketHash(packet) === packet.security.hash;
}
