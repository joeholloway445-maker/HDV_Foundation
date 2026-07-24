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
import { VIRTUAL_LAWS, type KnollLawContext } from './laws.js';
import { SecurityAuditLog } from './audit.js';
import { BehavioralScorer } from './scoring.js';
import { LearnedBehavioralScorer } from './scoring_learned.js';
import { SystemFreezeController } from './freeze.js';
import { createSovereignFreezeController } from './holloway_bridge.js';

export interface KnollOptions {
  /** Max packets allowed per source within the rate window. */
  rateLimit?: number;
  /** Rate window in milliseconds. */
  rateWindowMs?: number;
  /** Injectable clock for deterministic testing. */
  now?: () => number;
  /**
   * Behavioral anomaly scorer. Runs AFTER the six virtual laws as an additive gate.
   * Enabled by default (a scorer is stood up if none is injected). Set `enableScoring`
   * to false to run laws-only (Phase 1 behavior).
   */
  scorer?: BehavioralScorer;
  enableScoring?: boolean;
  /**
   * Optional LEARNED behavioral scorer (Phase 7). Runs AFTER the laws AND the heuristic scorer
   * as a strictly ADDITIVE gate: it can only ADD a deny, never override a hard-law allow. Default
   * OFF — it activates only when a scorer is injected here or `enableLearnedScoring` is true. In
   * its default `shadow` mode it logs its verdict and never denies; flip it to `enforce` to let it
   * add denies. See knoll/scoring_learned.ts.
   */
  learnedScorer?: LearnedBehavioralScorer;
  enableLearnedScoring?: boolean;
  /**
   * The system freeze controller (KNOLL active-router enforcement). When the behavioral gate
   * scores a packet at or above the 34% deny threshold, KNOLL denies it AND trips this freeze
   * plus quarantines the packet. Shared with APEX so `ApexRouter.dispatch` can refuse new
   * business routes while frozen. A controller is stood up automatically when none is injected.
   */
  freeze?: SystemFreezeController;
}

interface RateBucket {
  windowStart: number;
  count: number;
}

export class Knoll {
  readonly audit: SecurityAuditLog;
  /** The behavioral scorer, when scoring is enabled (default). Read-only surface. */
  readonly scorer?: BehavioralScorer;
  /** The optional learned behavioral scorer (Phase 7). Present only when enabled. Read-only. */
  readonly learnedScorer?: LearnedBehavioralScorer;
  /**
   * The system freeze controller. Always present: a 34%+ behavioral anomaly trips it, and APEX
   * consults it (`knoll.freeze.isFrozen()`) before every business route. Read-only surface.
   */
  readonly freeze: SystemFreezeController;
  private readonly rateLimit: number;
  private readonly rateWindowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<AgentRole, RateBucket>();

  constructor(auditLog?: SecurityAuditLog, options: KnollOptions = {}) {
    this.audit = auditLog ?? new SecurityAuditLog();
    this.rateLimit = options.rateLimit ?? 100;
    this.rateWindowMs = options.rateWindowMs ?? 1000;
    this.now = options.now ?? Date.now;
    const scoringEnabled = options.enableScoring ?? true;
    this.scorer = scoringEnabled ? options.scorer ?? new BehavioralScorer({ now: this.now }) : undefined;
    // Learned scoring is OFF by default. It activates only when a scorer is injected or the flag
    // is set — and even then it is additive-only (see intercept()).
    if (options.learnedScorer) {
      this.learnedScorer = options.learnedScorer;
    } else if (options.enableLearnedScoring) {
      this.learnedScorer = new LearnedBehavioralScorer({ now: this.now });
    } else {
      this.learnedScorer = undefined;
    }
    // KNOLL owns the system freeze: a 34%+ behavioral anomaly trips it (see intercept()).
    // Default freeze is wired to the Holloway sovereign token recognizer (signed overrides +
    // legacy shape strings). Inject a custom controller to override.
    this.freeze = options.freeze ?? createSovereignFreezeController({ now: this.now });
  }

  /**
   * The gate. Returns a verdict AND writes an audit record. APEX must honor `isAllowed`.
   *
   * `context` is optional runtime metadata about the caller (e.g. the authenticated tenant of
   * the source). It is additive: omit it and KNOLL behaves exactly as in Phase 1. Today it
   * powers the NO_CROSS_TENANT law — see knoll/laws.ts.
   */
  intercept(packet: unknown, context?: KnollLawContext): KnollValidationResponse {
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
      const verdict = law(rp, context);
      if (!verdict.passed) {
        this.audit.record(rp.header.packetId, 'BLOCKED', verdict.reasoning);
        return {
          isAllowed: false,
          reasoning: verdict.reasoning,
          enforcedConstraints: [verdict.law],
        };
      }
    }

    // Behavioral anomaly scoring — the additive gate (runs only after all six laws pass).
    // It denies high-anomaly packets the hard rules can't express.
    let note = 'all virtual laws satisfied';
    const scoreConstraints: string[] = [];
    if (this.scorer) {
      const behavioral = this.scorer.score(rp);
      if (behavioral.isAnomalous) {
        const reasoning = `behavioral anomaly score ${behavioral.score} >= ${behavioral.threshold}`;
        // KNOLL active-router enforcement: at/above the 34% deny threshold KNOLL does not merely
        // deny — it trips an ABSOLUTE system freeze and quarantines the offending packet. APEX
        // then refuses every new business route until a Holloway/Prime override lifts the freeze.
        this.freeze.triggerFreeze(reasoning, behavioral.score, rp.header.packetId);
        this.freeze.quarantinePacket(rp, { reason: reasoning, score: behavioral.score });
        this.audit.record(rp.header.packetId, 'BLOCKED', reasoning);
        return {
          isAllowed: false,
          reasoning,
          enforcedConstraints: ['BEHAVIORAL_SCORE'],
        };
      }
      if (behavioral.flagged) note = `all virtual laws satisfied; flagged (anomaly ${behavioral.score})`;
      scoreConstraints.push('BEHAVIORAL_SCORE');
    }

    // Learned behavioral scoring (Phase 7) — a strictly ADDITIVE final gate, default off. It can
    // only ADD a deny; it never overrides the allow the laws + heuristic just produced. In shadow
    // mode it logs its verdict and never denies.
    if (this.learnedScorer) {
      const { deny, score } = this.learnedScorer.verdict(rp);
      if (deny) {
        const reasoning = `learned behavioral anomaly ${score.probability} >= ${score.threshold} (enforce)`;
        this.audit.record(rp.header.packetId, 'BLOCKED', reasoning);
        return {
          isAllowed: false,
          reasoning,
          enforcedConstraints: ['LEARNED_BEHAVIORAL_SCORE'],
        };
      }
      // shadow-mode anomalies (and flags) are surfaced in the note but never deny.
      if (score.isAnomalous) note += ` [learned shadow anomaly ${score.probability}]`;
      else if (score.flagged) note += ` [learned flagged ${score.probability}]`;
      scoreConstraints.push('LEARNED_BEHAVIORAL_SCORE');
    }

    this.audit.record(rp.header.packetId, 'ALLOWED', note);
    return {
      isAllowed: true,
      reasoning: note,
      enforcedConstraints: [...VIRTUAL_LAWS.map((_, i) => `LAW_${i + 1}`), ...scoreConstraints],
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
