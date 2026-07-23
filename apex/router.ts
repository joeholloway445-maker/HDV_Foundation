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

export interface ApexRouterOptions {
  knoll?: Knoll;
  ledger?: BillingLedger;
  /** Cost billed per successfully routed packet (an ephemeral execution). */
  defaultCostUsd?: number;
}

export class ApexRouter {
  private readonly knoll: Knoll;
  readonly ledger: BillingLedger;
  private readonly handlers = new Map<AgentRole, AgentHandler>();
  private readonly defaultCostUsd: number;

  constructor(options: ApexRouterOptions = {}) {
    // KNOLL is always-on: if none is injected, APEX stands one up. APEX cannot run
    // without a KNOLL gate, by construction.
    this.knoll = options.knoll ?? new Knoll();
    this.ledger = options.ledger ?? new InMemoryLedger();
    this.defaultCostUsd = options.defaultCostUsd ?? 0.01;
  }

  /** Register (or replace) the inbound handler for a destination agent. */
  register(role: AgentRole, handler: AgentHandler): void {
    this.handlers.set(role, handler);
  }

  /**
   * Dispatch a packet. Order is fixed and non-negotiable:
   *   1. defensive structural check,
   *   2. KNOLL.intercept — the mandatory gate,
   *   3. only if allowed: deliver to the destination handler,
   *   4. always: write a ledger entry (SUCCESS / BLOCKED / FAILED) with cost_usd.
   */
  dispatch(packet: RoutingPacket, costUsd?: number): DispatchResult {
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
  async dispatchAsync(packet: RoutingPacket, costUsd?: number): Promise<DispatchResult> {
    return Promise.resolve(this.dispatch(packet, costUsd));
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
