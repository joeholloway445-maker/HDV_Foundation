/**
 * apex/router.ts — APEX, the master router.
 *
 * The ONE legal transport between agents. `dispatch(packet)` MUST call KNOLL first.
 * If KNOLL denies the packet, APEX drops it and logs a BLOCKED ledger entry — it never
 * routes without an explicit KNOLL allow. There are no direct agent-to-agent paths;
 * agents register a handler with APEX and only ever receive packets from APEX.
 */
import {
  AgentRole,
  type KnollValidationResponse,
  type RoutingPacket,
  type RoutingStatus,
} from '../config/routing_schema.js';
import { Knoll } from '../knoll/index.js';
import { InMemoryLedger, type BillingLedger } from './ledger.js';
import { isRoutingPacket } from './packet.js';

/** A destination agent's inbound handler. Returns an optional response payload. */
export type AgentHandler = (packet: RoutingPacket) => Record<string, unknown> | void;

export interface DispatchResult {
  status: 'SUCCESS' | 'BLOCKED' | 'FAILED';
  packetId: string;
  knoll: KnollValidationResponse;
  response?: Record<string, unknown>;
  error?: string;
  cost_usd: number;
}

/**
 * A single observable dispatch outcome, emitted AFTER a route completes. This is a purely
 * read-only projection (source/destination/verdict/latency/cost) with no ability to alter
 * routing — it exists so an out-of-band observer (see `observability/`) can meter APEX
 * traffic without APEX depending on any observability module.
 */
export interface DispatchEvent {
  packetId: string;
  source: AgentRole;
  destination: AgentRole;
  status: RoutingStatus;
  /** Wall-clock time for the whole gated dispatch (KNOLL + handler), in milliseconds. */
  durationMs: number;
  cost_usd: number;
  knoll: KnollValidationResponse;
}

/** Side-effect-only sink for dispatch events. MUST NOT throw; APEX ignores its return. */
export type DispatchObserver = (event: DispatchEvent) => void;

export interface ApexRouterOptions {
  knoll?: Knoll;
  ledger?: BillingLedger;
  /** Cost billed per successfully routed packet (an ephemeral execution). */
  defaultCostUsd?: number;
  /**
   * Optional read-only dispatch observer (Phase 5 observability). Invoked after every
   * `dispatch` with a projection of the outcome. It can never alter routing or the verdict,
   * and any error it throws is swallowed so metering can never break the transport.
   * Omitted by default — behavior is byte-for-byte unchanged when unset.
   */
  observer?: DispatchObserver;
}

export class ApexRouter {
  private readonly knoll: Knoll;
  readonly ledger: BillingLedger;
  private readonly handlers = new Map<AgentRole, AgentHandler>();
  private readonly defaultCostUsd: number;
  private readonly observer?: DispatchObserver;

  constructor(options: ApexRouterOptions = {}) {
    // KNOLL is always-on: if none is injected, APEX stands one up. APEX cannot run
    // without a KNOLL gate, by construction.
    this.knoll = options.knoll ?? new Knoll();
    this.ledger = options.ledger ?? new InMemoryLedger();
    this.defaultCostUsd = options.defaultCostUsd ?? 0.01;
    this.observer = options.observer;
  }

  /** Register (or replace) the inbound handler for a destination agent. */
  register(role: AgentRole, handler: AgentHandler): void {
    this.handlers.set(role, handler);
  }

  /**
   * Dispatch a packet through the KNOLL-gated transport, then emit a read-only observation.
   * The gating logic lives untouched in `gatedDispatch`; this wrapper only times the call
   * and (optionally) notifies the observer. Observation happens AFTER the verdict and can
   * never influence it.
   */
  /**
   * @param hollowayToken Optional Holloway/Prime override. Accepted forms:
   *   - legacy shape string (`holloway_…` / `prime_…`),
   *   - signed `HollowayOverrideToken` object, or its JSON serialization.
   * While KNOLL has the system frozen, only a recognized override may pass this gate.
   */
  dispatch(packet: RoutingPacket, costUsd?: number, hollowayToken?: unknown): DispatchResult {
    if (!this.observer) return this.gatedDispatch(packet, costUsd, hollowayToken);
    const start = performance.now();
    const result = this.gatedDispatch(packet, costUsd, hollowayToken);
    this.emit(packet, result, performance.now() - start);
    return result;
  }

  /** Emit a dispatch observation. Never throws into the caller — metering is best-effort. */
  private emit(packet: RoutingPacket, result: DispatchResult, durationMs: number): void {
    if (!this.observer) return;
    const valid = isRoutingPacket(packet);
    try {
      this.observer({
        packetId: result.packetId,
        source: valid ? packet.header.source : AgentRole.APEX,
        destination: valid ? packet.header.destination : AgentRole.APEX,
        status: result.status,
        durationMs,
        cost_usd: result.cost_usd,
        knoll: result.knoll,
      });
    } catch {
      // An observer failure must never break routing; swallow it.
    }
  }

  /**
   * Dispatch a packet. Order is fixed and non-negotiable:
   *   1. defensive structural check,
   *   1b. KNOLL system-freeze check — refuse ALL new business routes while frozen,
   *   2. KNOLL.intercept — the mandatory gate,
   *   3. only if allowed: deliver to the destination handler,
   *   4. always: write a ledger entry (SUCCESS / BLOCKED / FAILED) with cost_usd.
   */
  private gatedDispatch(packet: RoutingPacket, costUsd?: number, hollowayToken?: unknown): DispatchResult {
    const packetId = isRoutingPacket(packet) ? packet.header.packetId : 'unknown-packet';

    // Step 1: defensive structural guard (KNOLL will also check authoritatively).
    if (!isRoutingPacket(packet)) {
      const verdict: KnollValidationResponse = {
        isAllowed: false,
        reasoning: 'packet is not a RoutingPacket — refused before KNOLL',
        enforcedConstraints: ['STRUCTURE'],
      };
      this.ledger.logRequest({
        packetId,
        source: AgentRole.APEX,
        destination: AgentRole.APEX,
        status: 'BLOCKED',
        cost_usd: 0,
        knollSignature: 'no-token',
      });
      return { status: 'BLOCKED', packetId, knoll: verdict, cost_usd: 0 };
    }

    // Step 1b: KNOLL active-router freeze gate. When KNOLL has tripped the system freeze (a 34%+
    // behavioral anomaly), APEX MUST refuse EVERY new business route — no create, no execute —
    // until a Holloway/Prime override lifts it. The ONLY exception is a caller presenting a valid
    // Holloway/Prime override token on this dispatch.
    const freeze = this.knoll.freeze;
    if (freeze.isFrozen() && !freeze.isHollowayToken(hollowayToken)) {
      const state = freeze.state();
      const verdict: KnollValidationResponse = {
        isAllowed: false,
        reasoning: `system frozen by KNOLL — new routes refused (cause: ${state.reason ?? 'behavioral anomaly'})`,
        enforcedConstraints: ['SYSTEM_FREEZE'],
      };
      this.ledger.logRequest({
        packetId,
        source: packet.header.source,
        destination: packet.header.destination,
        status: 'BLOCKED',
        cost_usd: 0,
        knollSignature: signature(packet, verdict),
      });
      return { status: 'BLOCKED', packetId, knoll: verdict, cost_usd: 0 };
    }

    // Step 2: KNOLL gate — APEX MUST call KNOLL before every route.
    const verdict = this.knoll.intercept(packet);
    if (!verdict.isAllowed) {
      this.ledger.logRequest({
        packetId,
        source: packet.header.source,
        destination: packet.header.destination,
        status: 'BLOCKED',
        cost_usd: 0,
        knollSignature: signature(packet, verdict),
      });
      return { status: 'BLOCKED', packetId, knoll: verdict, cost_usd: 0 };
    }

    // Step 3: deliver to the destination. Agents never receive packets any other way.
    const handler = this.handlers.get(packet.header.destination);
    if (!handler) {
      this.ledger.logRequest({
        packetId,
        source: packet.header.source,
        destination: packet.header.destination,
        status: 'FAILED',
        cost_usd: 0,
        knollSignature: signature(packet, verdict),
      });
      return {
        status: 'FAILED',
        packetId,
        knoll: verdict,
        error: `no handler registered for destination ${packet.header.destination}`,
        cost_usd: 0,
      };
    }

    const cost = costUsd ?? this.defaultCostUsd;
    try {
      const response = handler(packet) ?? undefined;
      // Step 4: bill the ephemeral execution.
      this.ledger.request({
        packetId,
        source: packet.header.source,
        destination: packet.header.destination,
        status: 'SUCCESS',
        cost_usd: cost,
        knollSignature: signature(packet, verdict),
      });
      return { status: 'SUCCESS', packetId, knoll: verdict, response, cost_usd: cost };
    } catch (err) {
      this.ledger.logRequest({
        packetId,
        source: packet.header.source,
        destination: packet.header.destination,
        status: 'FAILED',
        cost_usd: 0,
        knollSignature: signature(packet, verdict),
      });
      return {
        status: 'FAILED',
        packetId,
        knoll: verdict,
        error: err instanceof Error ? err.message : String(err),
        cost_usd: 0,
      };
    }
  }

  /**
   * Async-ready dispatch. Phase 2 wraps the synchronous path in a resolved Promise so
   * call sites can already `await` routing; a later phase can back this with a real task
   * queue (see persistence/redis_router_stub.ts) without changing callers.
   */
  async dispatchAsync(packet: RoutingPacket, costUsd?: number, hollowayToken?: string): Promise<DispatchResult> {
    return Promise.resolve(this.dispatch(packet, costUsd, hollowayToken));
  }

  /** Expose the KNOLL audit trail (read path) without exposing KNOLL's write surface. */
  auditTrail() {
    return this.knoll.audit.all();
  }
}

/** Compact, deterministic signature stored on each ledger row for traceability. */
function signature(packet: RoutingPacket, verdict: KnollValidationResponse): string {
  const constraints = (verdict.enforcedConstraints ?? []).join(',');
  return `${packet.security.knoll_token.slice(0, 14)}:${verdict.isAllowed ? 'ALLOW' : 'DENY'}:${constraints}`;
}
