/**
 * apex/orchestrator.ts — APEX composition-root helper (Phase 2).
 *
 * Extracts the wiring boilerplate out of the demo so callers stay thin: it stands up
 * KNOLL + the router, exposes the single legal `sendViaApex` transport, registers the
 * APEX orchestration handler that forwards HOPE's `suggestedDestination`, and lets you
 * plug in the DREAM / VISION / HOPE handlers.
 *
 * ARCHITECTURE: this module imports APEX internals, KNOLL (permitted), persistence, and
 * the *neutral* nodes/pipeline helper — but it does NOT import any peer agent
 * (hope/dream/vision). Peer handlers are injected via `wire()`, so no peer-import rule is
 * violated. Agents still only ever receive packets from APEX.
 */
import {
  AgentRole,
  type PacketPriority,
  type RoutingPacket,
} from '../config/routing_schema.js';
import { Knoll } from '../knoll/index.js';
import { InMemoryLedger, type BillingLedger } from './ledger.js';
import { ApexRouter, type AgentHandler, type DispatchResult } from './router.js';
import { createPacket, type CreatePacketInput } from './packet.js';
import { runPersonaPipeline, type PipelineResult } from '../nodes/index.js';
import type {
  RequestLogRepository,
  SecurityAuditRepository,
} from '../persistence/index.js';
import { SecurityAuditLog } from '../knoll/audit.js';

export type SendViaApex = (input: CreatePacketInput) => DispatchResult;

export interface ApexOrchestratorOptions {
  knoll?: Knoll;
  ledger?: BillingLedger;
  defaultCostUsd?: number;
  /** Optional durable mirrors for the ledger / audit (see persistence layer). */
  requestLog?: RequestLogRepository;
  securityAudit?: SecurityAuditRepository;
}

/** Peer handlers, injected — never imported — to preserve the no-peer-import rule. */
export interface AgentWiring {
  dream?: AgentHandler;
  vision?: AgentHandler;
  /** HOPE's result sink (receives DREAM/VISION results routed back via APEX). */
  hope?: AgentHandler;
}

export interface SubmitResult {
  dispatch: DispatchResult;
  /** Where the orchestrator forwarded the intent, if it forwarded at all. */
  forwardedTo?: AgentRole;
}

export class ApexOrchestrator {
  readonly router: ApexRouter;
  readonly knoll: Knoll;
  readonly sendViaApex: SendViaApex;

  constructor(options: ApexOrchestratorOptions = {}) {
    // Build KNOLL (always-on). If a securityAudit repository is provided, mirror verdicts
    // into it via a repo-backed SecurityAuditLog.
    this.knoll =
      options.knoll ??
      new Knoll(options.securityAudit ? new SecurityAuditLog({ repository: options.securityAudit }) : undefined);

    const ledger: BillingLedger =
      options.ledger ?? new InMemoryLedger(options.requestLog ? { repository: options.requestLog } : {});

    this.router = new ApexRouter({
      knoll: this.knoll,
      ledger,
      defaultCostUsd: options.defaultCostUsd ?? 0.02,
    });

    this.sendViaApex = (input: CreatePacketInput): DispatchResult => this.router.dispatch(createPacket(input));

    // The APEX orchestration handler: forwards HOPE's suggested destination. This is the
    // logic previously inlined in the demo — now owned by the orchestrator.
    this.router.register(AgentRole.APEX, (packet) => this.forward(packet));
  }

  /** Register the injected peer handlers with the router. */
  wire(agents: AgentWiring): this {
    if (agents.dream) this.router.register(AgentRole.DREAM, agents.dream);
    if (agents.vision) this.router.register(AgentRole.VISION, agents.vision);
    if (agents.hope) this.router.register(AgentRole.HOPE, agents.hope);
    return this;
  }

  /**
   * The APEX forwarding handler. Reads `suggestedDestination` from HOPE's payload and
   * routes onward to DREAM or VISION (via APEX + KNOLL again). QUERY/CLARIFY/DOCUMENT
   * intents (suggestedDestination = HOPE/APEX) are handled at the interface — no forward.
   */
  private forward(packet: RoutingPacket): Record<string, unknown> {
    const suggested = packet.payload.data.suggestedDestination;
    if (suggested === AgentRole.DREAM || suggested === AgentRole.VISION) {
      const forwarded = this.sendViaApex({
        source: AgentRole.APEX,
        destination: suggested,
        intent: packet.payload.intent,
        data: packet.payload.data,
        priority: packet.header.priority,
      });
      return { forwardedTo: suggested, forwardStatus: forwarded.status, response: forwarded.response };
    }
    return { handledAtInterface: true, kind: packet.payload.data.kind ?? 'UNKNOWN' };
  }

  /**
   * Convenience entry point for a HOPE submission that has already been addressed to APEX.
   * Dispatches it and reports where (if anywhere) it was forwarded.
   */
  submit(input: CreatePacketInput): SubmitResult {
    const dispatch = this.sendViaApex(input);
    const forwardedTo =
      dispatch.response && typeof dispatch.response.forwardedTo === 'string'
        ? (dispatch.response.forwardedTo as AgentRole)
        : undefined;
    return { dispatch, forwardedTo };
  }

  /** Async-ready submit (wraps the sync path; future queue-backed). */
  async submitAsync(input: CreatePacketInput): Promise<SubmitResult> {
    return Promise.resolve(this.submit(input));
  }

  /**
   * Run a researcher→writer→critic persona pipeline UNDER a single Big AI. Any cross-agent
   * hop still goes through APEX; this only orchestrates personas within one owner's matrix.
   */
  runPipeline(owner: AgentRole, task: string, data: Record<string, unknown> = {}): PipelineResult {
    return runPersonaPipeline(owner, task, data);
  }

  /** Read-only ledger + audit accessors. */
  get ledger(): BillingLedger {
    return this.router.ledger;
  }
  auditTrail() {
    return this.router.auditTrail();
  }
}

/** Small helper mirroring the demo's priority choice for HIGH-urgency intents. */
export function priorityForUrgency(urgency: string): PacketPriority {
  return urgency === 'HIGH' ? 'CRITICAL' : urgency === 'LOW' ? 'BACKGROUND' : 'STANDARD';
}
