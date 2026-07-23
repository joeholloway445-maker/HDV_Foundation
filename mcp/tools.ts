/**
 * mcp/tools.ts — HDV as an MCP tool provider.
 *
 * This is the MCP "front door": exactly like the HOPE HTTP gateway, it is a COMPOSITION ROOT
 * that wires HOPE + DREAM + VISION into an ApexOrchestrator via dependency injection and then
 * exposes a handful of tools to external agents / IDEs. It holds no business logic of its own
 * and is NOT a peer agent.
 *
 * INVARIANTS PRESERVED (same as the gateway — MCP is just another door):
 *   - Every intent flows HOPE → APEX → KNOLL → (DREAM | VISION). The provider never bypasses
 *     APEX and has no direct handle on DREAM/VISION beyond the DI wiring.
 *   - Read tools (health / usage) are read-only projections of the ledger, audit trail, and
 *     matrix topology. They never route, execute, create, or mutate a verdict.
 *   - No secrets are ever returned: no knoll tokens, no packet hashes, no api keys.
 *
 * The tool handlers are plain async methods returning JSON-serializable objects, so they are
 * unit-testable WITHOUT wiring the MCP SDK or binding stdio. `mcp/server.ts` adapts them to
 * the MCP wire protocol; tests call them directly.
 */
import { AgentRole } from '../config/routing_schema.js';
import { ApexOrchestrator } from '../apex/index.js';
import { IntentInterpreter, HopeDocumenter, HopeVoice } from '../hope/index.js';
import { SimulationEngine } from '../dream/index.js';
import { ExecutionEngine } from '../vision/index.js';
import { MetricsCollector } from '../observability/index.js';
import {
  TOTAL_NODES,
  TOTAL_PERSONAS,
  PERSONAS_PER_NODE,
  TOTAL_CONCEPTUAL_PARAMETERS,
  ALWAYS_ON_AGENTS,
  EPHEMERAL_AGENTS,
} from '../nodes/index.js';
import { estimateCost } from './estimate.js';
import { loadModelCatalog } from './models.js';

/** A JSON-Schema-described tool, matching the MCP `tools/list` entry shape. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Normalized result of a tool call: structured content + an error flag. */
export interface ToolCallResult {
  /** JSON-serializable structured result surfaced to the caller. */
  data: Record<string, unknown>;
  /** True when the call failed (bad input, unknown tool, handler error). */
  isError: boolean;
}

export interface HdvToolProviderOptions {
  /** Provide a pre-wired orchestrator; otherwise the provider builds and wires one. */
  orchestrator?: ApexOrchestrator;
  interpreter?: IntentInterpreter;
  documenter?: HopeDocumenter;
  voice?: HopeVoice;
  /** Read-only meters (wired to the orchestrator's dispatch observer). Built when omitted. */
  metrics?: MetricsCollector;
  /** Max entries returned by read tools. Default 25. */
  readLimit?: number;
}

interface HopeResultRecord {
  intent: string;
  at: number;
}

/** The five HDV tools exposed over MCP. */
export const TOOL_NAMES = ['hdv_intent', 'hdv_estimate_cost', 'hdv_health', 'hdv_models', 'hdv_usage'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export class HdvToolProvider {
  readonly orchestrator: ApexOrchestrator;
  readonly interpreter: IntentInterpreter;
  readonly documenter: HopeDocumenter;
  readonly voice: HopeVoice;
  readonly metrics: MetricsCollector;
  private readonly readLimit: number;
  private readonly startedAt = Date.now();

  /** Last time each ephemeral agent produced a result (for idle flags in hdv_health). */
  private readonly lastActive: Partial<Record<AgentRole, number>> = {};
  /** Recent HOPE result sink (DREAM/VISION results routed back → APEX → HOPE). */
  private readonly hopeResults: HopeResultRecord[] = [];

  constructor(options: HdvToolProviderOptions = {}) {
    this.metrics = options.metrics ?? new MetricsCollector();
    // Meter every gated dispatch — including APEX's internal DREAM/VISION forwards — without
    // ever touching routing or KNOLL. Same pattern the gateway uses.
    this.orchestrator =
      options.orchestrator ?? new ApexOrchestrator({ defaultCostUsd: 0.02, observer: this.metrics.observer() });
    this.interpreter = options.interpreter ?? new IntentInterpreter();
    this.documenter = options.documenter ?? new HopeDocumenter();
    this.voice = options.voice ?? new HopeVoice();
    this.readLimit = options.readLimit ?? 25;

    // Wire the ephemeral engines via DI (composition root — no peer-to-peer imports).
    const dream = new SimulationEngine(this.orchestrator.sendViaApex, { breadth: 2, depth: 1 });
    const vision = new ExecutionEngine('gvisor', this.orchestrator.sendViaApex);
    this.orchestrator.wire({
      dream: (packet) => {
        this.lastActive[AgentRole.DREAM] = Date.now();
        return dream.asHandler()(packet);
      },
      vision: (packet) => {
        this.lastActive[AgentRole.VISION] = Date.now();
        return vision.asHandler()(packet);
      },
      hope: (packet) => {
        this.hopeResults.push({ intent: packet.payload.intent, at: Date.now() });
        if (this.hopeResults.length > 200) this.hopeResults.shift();
        return { acknowledged: true };
      },
    });
  }

  // -------------------------------------------------------------------------
  // Tool catalog (MCP tools/list)
  // -------------------------------------------------------------------------

  listTools(): ToolDefinition[] {
    return [
      {
        name: 'hdv_intent',
        description:
          'Interpret a natural-language utterance with HOPE and route it through APEX→KNOLL→(DREAM|VISION). ' +
          'Returns HOPE\'s voice, the routing status, and a KNOLL verdict summary (no secrets).',
        inputSchema: {
          type: 'object',
          properties: {
            utterance: { type: 'string', description: 'The natural-language request to interpret and route.' },
          },
          required: ['utterance'],
          additionalProperties: false,
        },
      },
      {
        name: 'hdv_estimate_cost',
        description:
          'Estimate the USD cost of running an ACTIVE parameter footprint for a duration. Offline, ' +
          'deterministic heuristic (no paid API). Optionally scale by a model hint.',
        inputSchema: {
          type: 'object',
          properties: {
            activeParams: { type: 'number', description: 'Active parameter count (not the conceptual total).' },
            durationSec: { type: 'number', description: 'Billed duration in seconds.' },
            model: { type: 'string', description: 'Optional model hint (e.g. "llama-3-8b", "gpt-4o").' },
          },
          required: ['activeParams', 'durationSec'],
          additionalProperties: false,
        },
      },
      {
        name: 'hdv_health',
        description:
          'Report always-on agents (HOPE/KNOLL/APEX), ephemeral idle flags (DREAM/VISION), the KNOLL ' +
          'gate state, and matrix topology stats. Read-only.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'hdv_models',
        description:
          'List the model catalog. Uses config/models.json when present, otherwise a static list of ' +
          'offline 7B/local options. Read-only.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'hdv_usage',
        description:
          'Recent usage snapshot: APEX billing ledger tail, KNOLL audit counts, and observability ' +
          'metrics. Read-only projection of traffic this server already routed.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max ledger entries to return (default 25, max 100).' },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Dispatcher (MCP tools/call)
  // -------------------------------------------------------------------------

  /** Route a tool call by name. Never throws — errors are returned as `{ isError: true }`. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    try {
      switch (name) {
        case 'hdv_intent':
          return ok(this.hdvIntent(args));
        case 'hdv_estimate_cost':
          return this.hdvEstimateCost(args);
        case 'hdv_health':
          return ok(this.hdvHealth());
        case 'hdv_models':
          return ok(this.hdvModels());
        case 'hdv_usage':
          return ok(this.hdvUsage(args));
        default:
          return err({ error: `unknown tool: ${name}`, availableTools: TOOL_NAMES });
      }
    } catch (e) {
      return err({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // -------------------------------------------------------------------------
  // Tool handlers — plain, testable, JSON-serializable
  // -------------------------------------------------------------------------

  /**
   * hdv_intent — HOPE interprets + documents an utterance, then submits it via APEX (KNOLL
   * gates the route). Low-confidence intents are HELD (HOPE clarifies rather than guessing).
   * Returns HOPE's voice + routing status + a safe KNOLL verdict summary. No secrets.
   */
  hdvIntent(args: Record<string, unknown>): Record<string, unknown> {
    const utterance = typeof args.utterance === 'string' ? args.utterance.trim() : '';
    if (!utterance) {
      throw new Error('hdv_intent requires a non-empty "utterance" string');
    }

    const intent = this.interpreter.interpret(utterance);
    const doc = this.documenter.document(intent);

    if (intent.clarificationNeeded) {
      return {
        accepted: true,
        dispatched: false,
        clarificationNeeded: true,
        voice: this.voice.clarify(intent),
        intent: publicIntent(intent),
        knoll: null,
        documentId: doc.id,
      };
    }

    // Confident intent → HOPE → APEX (→ KNOLL → DREAM/VISION). Never bypasses APEX.
    const { result } = this.interpreter.submit(utterance, this.orchestrator.sendViaApex);
    const forwardedTo =
      result?.response && typeof result.response.forwardedTo === 'string'
        ? (result.response.forwardedTo as string)
        : null;

    return {
      accepted: true,
      dispatched: Boolean(result),
      routingStatus: result?.status ?? 'HELD',
      forwardedTo,
      knoll: result ? safeKnoll(result.knoll) : null,
      voice: result ? this.voice.status(result) : this.voice.acknowledge(intent),
      intent: publicIntent(intent),
      documentId: doc.id,
    };
  }

  /** hdv_estimate_cost — offline deterministic estimate. Validates numeric inputs. */
  hdvEstimateCost(args: Record<string, unknown>): ToolCallResult {
    const activeParams = Number(args.activeParams);
    const durationSec = Number(args.durationSec);
    if (!Number.isFinite(activeParams) || !Number.isFinite(durationSec)) {
      return err({ error: 'hdv_estimate_cost requires numeric "activeParams" and "durationSec"' });
    }
    const model = typeof args.model === 'string' ? args.model : undefined;
    return ok({ ...estimateCost({ activeParams, durationSec, model }) });
  }

  /** hdv_health — always-on + ephemeral idle flags, KNOLL gate, matrix topology. Read-only. */
  hdvHealth(): Record<string, unknown> {
    const now = Date.now();
    const alwaysOn = ALWAYS_ON_AGENTS.map((role) => ({ role, lifecycle: 'always-on', status: 'online' }));
    const ephemeral = EPHEMERAL_AGENTS.map((role) => {
      const last = this.lastActive[role];
      return {
        role,
        lifecycle: 'ephemeral',
        idle: true,
        lastActiveAgoMs: last ? now - last : null,
      };
    });
    return {
      ok: true,
      time: now,
      uptimeMs: now - this.startedAt,
      knollGate: 'enforced',
      alwaysOn,
      ephemeral,
      matrix: {
        totalNodes: TOTAL_NODES,
        personasPerNode: PERSONAS_PER_NODE,
        totalPersonas: TOTAL_PERSONAS,
        totalConceptualParameters: TOTAL_CONCEPTUAL_PARAMETERS,
        totalConceptualParametersExp: TOTAL_CONCEPTUAL_PARAMETERS.toExponential(4),
      },
    };
  }

  /** hdv_models — model catalog (config file or offline fallback). Read-only. */
  hdvModels(): Record<string, unknown> {
    const catalog = loadModelCatalog();
    return {
      source: catalog.source,
      matrixModel: catalog.matrixModel,
      count: catalog.models.length,
      models: catalog.models,
    };
  }

  /** hdv_usage — recent ledger tail + audit counts + metrics snapshot. Read-only. */
  hdvUsage(args: Record<string, unknown>): Record<string, unknown> {
    const n = clampLimit(Number(args.limit), this.readLimit);
    const ledger = this.orchestrator.ledger;
    const entries = ledger.entries();
    const recent = entries.slice(-n).map((e) => ({
      packetId: e.packetId,
      source: e.source,
      destination: e.destination,
      status: e.status,
      cost_usd: e.cost_usd,
      timestamp: e.timestamp,
    }));

    const audit = this.orchestrator.auditTrail();
    const snapshot = this.metrics.snapshot();

    return {
      ledger: {
        count: recent.length,
        totalEntries: entries.length,
        totalBilledUsd: ledger.totalCost(),
        recent,
      },
      audit: {
        total: audit.length,
        allowed: audit.filter((a) => a.outcome === 'ALLOWED').length,
        blocked: audit.filter((a) => a.outcome === 'BLOCKED').length,
      },
      metrics: {
        packets: snapshot.packets,
        perDestination: snapshot.perDestination,
        costUsd: snapshot.cost.totalUsd,
        uptimeMs: snapshot.uptimeMs,
      },
      recentHopeResults: this.hopeResults.length,
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ok(data: Record<string, unknown>): ToolCallResult {
  return { data, isError: false };
}

function err(data: Record<string, unknown>): ToolCallResult {
  return { data, isError: true };
}

/** A KNOLL verdict summary that leaks no tokens/hashes. */
function safeKnoll(knoll: { isAllowed: boolean; reasoning?: string; enforcedConstraints?: string[] }): Record<string, unknown> {
  return {
    isAllowed: knoll.isAllowed,
    reasoning: knoll.reasoning ?? null,
    enforcedConstraints: knoll.enforcedConstraints ?? [],
  };
}

/** Project only non-sensitive, classification-relevant intent fields. */
function publicIntent(intent: {
  kind: string;
  urgency: string;
  confidence: number;
  entities: string[];
  goals: string[];
  constraints: string[];
  suggestedDestination: AgentRole;
}): Record<string, unknown> {
  return {
    kind: intent.kind,
    urgency: intent.urgency,
    confidence: intent.confidence,
    entities: intent.entities,
    goals: intent.goals,
    constraints: intent.constraints,
    suggestedDestination: intent.suggestedDestination,
  };
}

function clampLimit(limit: number, fallback: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), 100);
}
