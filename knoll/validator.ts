/**
 * knoll/validator.ts — KNOLL, the master auditor.
 *
 * `intercept(packet)` is the single entry point APEX calls BEFORE every route. KNOLL:
 *   1. validates the packet is structurally a RoutingPacket,
 *   2. verifies the SHA-256 hash (tamper detection),
 *   3. applies the virtual laws (endpoints, DREAM/VISION isolation, forgery, intent),
 *   4. enforces rate limiting,
 * and records a SecurityAudit entry for every verdict.
 *
 * KNOLL is monitor-only: it allows or denies. It NEVER mutates a packet and NEVER
 * executes or creates business work.
 */
import {
  AgentRole,
  type KnollValidationResponse,
  type RoutingPacket,
} from '../config/routing_schema.js';
import { computePacketHash } from '../config/hash.js';
import { VIRTUAL_LAWS } from './laws.js';
import { SecurityAuditLog } from './audit.js';

export interface KnollOptions {
  /** Max packets allowed per source within the rate window. */
  rateLimit?: number;
  /** Rate window in milliseconds. */
  rateWindowMs?: number;
  /** Injectable clock for deterministic testing. */
  now?: () => number;
}

interface RateBucket {
  windowStart: number;
  count: number;
}

export class Knoll {
  readonly audit: SecurityAuditLog;
  private readonly rateLimit: number;
  private readonly rateWindowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<AgentRole, RateBucket>();

  constructor(auditLog?: SecurityAuditLog, options: KnollOptions = {}) {
    this.audit = auditLog ?? new SecurityAuditLog();
    this.rateLimit = options.rateLimit ?? 100;
    this.rateWindowMs = options.rateWindowMs ?? 1000;
    this.now = options.now ?? Date.now;
  }

  /**
   * The gate. Returns a verdict AND writes an audit record. APEX must honor `isAllowed`.
   */
  intercept(packet: unknown): KnollValidationResponse {
    // Structural guard: reject anything that is not shaped like a RoutingPacket.
    const structural = this.checkStructure(packet);
    if (!structural.isAllowed) {
      const packetId = this.safePacketId(packet);
      this.audit.record(packetId, 'BLOCKED', structural.reasoning);
      return structural;
    }

    const rp = packet as RoutingPacket;

    // Tamper detection: recompute the hash over header + payload and compare.
    const expected = computePacketHash(rp);
    if (expected !== rp.security.hash) {
      const reasoning = 'SHA-256 hash mismatch — packet tampered or malformed';
      this.audit.record(rp.header.packetId, 'BLOCKED', reasoning);
      return { isAllowed: false, reasoning, enforcedConstraints: ['HASH_INTEGRITY'] };
    }

    // Rate limiting per source.
    const rate = this.checkRate(rp.header.source);
    if (!rate.isAllowed) {
      this.audit.record(rp.header.packetId, 'BLOCKED', rate.reasoning);
      return rate;
    }

    // Virtual laws.
    for (const law of VIRTUAL_LAWS) {
      const verdict = law(rp);
      if (!verdict.passed) {
        this.audit.record(rp.header.packetId, 'BLOCKED', verdict.reasoning);
        return {
          isAllowed: false,
          reasoning: verdict.reasoning,
          enforcedConstraints: [verdict.law],
        };
      }
    }

    this.audit.record(rp.header.packetId, 'ALLOWED', 'all virtual laws satisfied');
    return {
      isAllowed: true,
      reasoning: 'all virtual laws satisfied',
      enforcedConstraints: VIRTUAL_LAWS.map((_, i) => `LAW_${i + 1}`),
    };
  }

  private checkStructure(packet: unknown): KnollValidationResponse {
    if (packet === null || typeof packet !== 'object') {
      return { isAllowed: false, reasoning: 'packet is not an object', enforcedConstraints: ['STRUCTURE'] };
    }
    const p = packet as Partial<RoutingPacket>;
    const header = p.header;
    const payload = p.payload;
    const security = p.security;
    const validHeader =
      !!header &&
      typeof header.packetId === 'string' &&
      typeof header.timestamp === 'number' &&
      typeof header.source === 'string' &&
      typeof header.destination === 'string' &&
      (header.priority === 'CRITICAL' || header.priority === 'STANDARD' || header.priority === 'BACKGROUND');
    const validPayload =
      !!payload && typeof payload.intent === 'string' && !!payload.data && typeof payload.data === 'object';
    const validSecurity =
      !!security && typeof security.knoll_token === 'string' && typeof security.hash === 'string';
    if (!validHeader || !validPayload || !validSecurity) {
      return {
        isAllowed: false,
        reasoning: 'packet does not strictly adhere to the RoutingPacket interface — system compromised',
        enforcedConstraints: ['STRUCTURE'],
      };
    }
    return { isAllowed: true };
  }

  private checkRate(source: AgentRole): KnollValidationResponse {
    const t = this.now();
    const bucket = this.buckets.get(source);
    if (!bucket || t - bucket.windowStart >= this.rateWindowMs) {
      this.buckets.set(source, { windowStart: t, count: 1 });
      return { isAllowed: true };
    }
    bucket.count += 1;
    if (bucket.count > this.rateLimit) {
      return {
        isAllowed: false,
        reasoning: `rate limit exceeded for ${source} (${this.rateLimit}/${this.rateWindowMs}ms)`,
        enforcedConstraints: ['RATE_LIMIT'],
      };
    }
    return { isAllowed: true };
  }

  private safePacketId(packet: unknown): string {
    if (
      packet !== null &&
      typeof packet === 'object' &&
      'header' in packet &&
      (packet as { header?: { packetId?: unknown } }).header?.packetId
    ) {
      const id = (packet as { header: { packetId?: unknown } }).header.packetId;
      if (typeof id === 'string') return id;
    }
    return 'unknown-packet';
  }
}
