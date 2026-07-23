/**
 * gateway/server.ts — Phase 4 HTTP API Gateway: HOPE's forward-facing presence.
 *
 * HOPE is the interface layer / master interpreter, but until now it had no network face.
 * This gateway gives HOPE an HTTP surface so external clients can submit natural-language
 * intents and read system state. It is a COMPOSITION ROOT (like the demos): it wires HOPE
 * + DREAM + VISION handlers into an ApexOrchestrator via dependency injection. It is NOT a
 * peer agent and holds no business logic of its own.
 *
 * INVARIANTS PRESERVED:
 *   - The gateway NEVER bypasses APEX. Every intent is submitted HOPE → APEX, and APEX
 *     calls KNOLL before routing. The gateway has no direct handle on DREAM/VISION beyond
 *     the DI wiring; it cannot address them directly.
 *   - The gateway imports no peer-to-peer edges: peers still only receive packets from
 *     APEX. Read endpoints (ledger/audit) are read-only projections.
 *   - Zero third-party deps: built on node:http only, and kept modular so the transport
 *     (http, a framework, or a serverless handler) can be swapped without touching HOPE.
 *
 * Handlers are exposed as pure-ish methods (`handleIntent`, `handleHealth`, ...) that
 * return `{ status, body }`, so they can be tested WITHOUT binding a port. `createServer`
 * / `listen` wrap them for real HTTP.
 */
import http from 'node:http';
import { AgentRole } from '../config/routing_schema.js';
import {
  GatewayMiddleware,
  resolveSecurityConfig,
  clientIp,
  defaultLogger,
  type SecurityOverrides,
  type GatewayLogger,
} from './middleware.js';
import { ApexOrchestrator } from '../apex/index.js';
import { MetricsCollector, PacketTracer, combineObservers } from '../observability/index.js';
import { IntentInterpreter, HopeDocumenter, HopeVoice } from '../hope/index.js';
import { SimulationEngine } from '../dream/index.js';
import { ExecutionEngine } from '../vision/index.js';
import {
  MANAGERS_PER_AGENT,
  NODES_PER_MANAGER,
  NODES_PER_AGENT,
  TOTAL_NODES,
  PERSONAS_PER_NODE,
  TOTAL_PERSONAS,
  TOTAL_CONCEPTUAL_PARAMETERS,
  ALWAYS_ON_AGENTS,
  EPHEMERAL_AGENTS,
  computeParameterAccounting,
} from '../nodes/index.js';

export interface GatewayResponse {
  status: number;
  body: Record<string, unknown>;
  /**
   * Optional raw text body (e.g. Prometheus exposition). When set, `body` is ignored and the
   * response is written verbatim with `contentType`. Used by GET /v1/metrics?format=prometheus.
   */
  text?: string;
  contentType?: string;
}

export interface HopeGatewayOptions {
  /** Provide a pre-wired orchestrator; otherwise the gateway builds and wires one. */
  orchestrator?: ApexOrchestrator;
  interpreter?: IntentInterpreter;
  documenter?: HopeDocumenter;
  voice?: HopeVoice;
  /** Max entries returned by the read endpoints. Default 50. */
  readLimit?: number;
  /**
   * Phase 4.1 hardening overrides (auth key, rate limit, CORS origin). Anything omitted
   * falls back to env (HDV_API_KEY / HDV_RATE_LIMIT / HDV_CORS_ORIGIN) then to defaults.
   */
  security?: SecurityOverrides;
  /**
   * Structured request logger. Defaults to a single-line JSON logger; pass `false` (or a
   * no-op) to silence logging (handy in tests). Secrets are never passed to the logger.
   */
  logger?: GatewayLogger | false;
  /**
   * Phase 5 observability. Injected read-only meters exposed via GET /v1/metrics. When the
   * gateway builds its own orchestrator (the default), these are wired to its dispatch
   * observer so all APEX traffic — including internal DREAM/VISION forwards — is metered. If
   * you inject your own `orchestrator`, wire the same collector's `observer()` into it so the
   * gateway's /v1/metrics reflects real traffic. Defaults are created when omitted.
   */
  metrics?: MetricsCollector;
  tracer?: PacketTracer;
}

interface HopeResultRecord {
  intent: string;
  at: number;
}

/**
 * The HOPE-facing gateway. Owns a wired ApexOrchestrator and the HOPE trio (interpret /
 * document / voice). Everything an external client can trigger flows through APEX+KNOLL.
 */
export class HopeGateway {
  readonly orchestrator: ApexOrchestrator;
  readonly interpreter: IntentInterpreter;
  readonly documenter: HopeDocumenter;
  readonly voice: HopeVoice;
  /** Front-door guard chain (CORS, auth, rate limiting). Public for tests/introspection. */
  readonly middleware: GatewayMiddleware;
  /** Read-only observability meters surfaced at GET /v1/metrics. */
  readonly metrics: MetricsCollector;
  readonly tracer: PacketTracer;
  private readonly readLimit: number;
  private readonly logger: GatewayLogger;

  /** Timestamps of the last time each ephemeral agent produced a result (for idle flags). */
  private readonly lastActive: Partial<Record<AgentRole, number>> = {};
  /** Recent HOPE result sink (results routed back DREAM/VISION → APEX → HOPE). */
  private readonly hopeResults: HopeResultRecord[] = [];

  constructor(options: HopeGatewayOptions = {}) {
    // Observability meters (read-only). Wired into the orchestrator's dispatch observer when
    // the gateway builds its own — so every gated route, including APEX's internal forwards,
    // is metered without the gateway ever touching routing or KNOLL.
    this.metrics = options.metrics ?? new MetricsCollector();
    this.tracer = options.tracer ?? new PacketTracer();
    const observer = combineObservers(this.metrics.observer(), this.tracer.observer());
    this.orchestrator =
      options.orchestrator ?? new ApexOrchestrator({ defaultCostUsd: 0.02, observer });
    this.interpreter = options.interpreter ?? new IntentInterpreter();
    this.documenter = options.documenter ?? new HopeDocumenter();
    this.voice = options.voice ?? new HopeVoice();
    this.readLimit = options.readLimit ?? 50;
    this.middleware = new GatewayMiddleware(resolveSecurityConfig(options.security ?? {}));
    this.logger = options.logger === false ? () => {} : options.logger ?? defaultLogger;

    // Wire the ephemeral engines via DI (composition root — no peer imports between peers).
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
  // Handlers — return { status, body } so they are unit-testable without a port.
  // -------------------------------------------------------------------------

  /**
   * POST /v1/intent — HOPE interprets + documents an utterance and submits it via APEX.
   * KNOLL gates the routed packet. Returns HOPE's voice + the routing status.
   */
  handleIntent(body: unknown): GatewayResponse {
    const utterance = extractUtterance(body);
    if (!utterance) {
      return { status: 400, body: { error: 'body must be JSON with a non-empty "utterance" string' } };
    }

    const intent = this.interpreter.interpret(utterance);
    const doc = this.documenter.document(intent);

    // Low-confidence intents are HELD (HOPE clarifies rather than guessing) — no dispatch.
    if (intent.clarificationNeeded) {
      return {
        status: 200,
        body: {
          accepted: true,
          dispatched: false,
          clarificationNeeded: true,
          voice: this.voice.clarify(intent),
          intent: publicIntent(intent),
          documentId: doc.id,
        },
      };
    }

    // Confident intent → submit HOPE → APEX (→ KNOLL → DREAM/VISION). Never bypasses APEX.
    const { result } = this.interpreter.submit(utterance, this.orchestrator.sendViaApex);
    const status = result?.status ?? 'HELD';
    return {
      status: 200,
      body: {
        accepted: true,
        dispatched: Boolean(result),
        routingStatus: status,
        knoll: result?.knoll ?? null,
        voice: result ? this.voice.status(result) : this.voice.acknowledge(intent),
        intent: publicIntent(intent),
        documentId: doc.id,
      },
    };
  }

  /**
   * GET /v1/health — always-on agents (HOPE, KNOLL, APEX) plus ephemeral Dream/Vision idle
   * flags. Ephemeral agents have no standby: they are "idle" (spun down) between requests.
   */
  handleHealth(): GatewayResponse {
    const now = Date.now();
    const alwaysOn = ALWAYS_ON_AGENTS.map((role) => ({ role, lifecycle: 'always-on', status: 'online' }));
    const ephemeral = EPHEMERAL_AGENTS.map((role) => {
      const last = this.lastActive[role];
      return {
        role,
        lifecycle: 'ephemeral',
        // Ephemeral agents spin up on demand and terminate; idle == not currently running.
        idle: true,
        lastActiveAgoMs: last ? now - last : null,
      };
    });
    return {
      status: 200,
      body: {
        ok: true,
        time: now,
        alwaysOn,
        ephemeral,
        knollGate: 'enforced',
      },
    };
  }

  /** GET /v1/ledger — recent APEX billing ledger entries (read-only). */
  handleLedger(limit?: number): GatewayResponse {
    const n = clampLimit(limit, this.readLimit);
    const entries = this.orchestrator.ledger.entries();
    const recent = entries.slice(-n).map((e) => ({
      packetId: e.packetId,
      source: e.source,
      destination: e.destination,
      status: e.status,
      cost_usd: e.cost_usd,
      timestamp: e.timestamp,
    }));
    return {
      status: 200,
      body: { count: recent.length, totalBilled: this.orchestrator.ledger.totalCost(), entries: recent },
    };
  }

  /** GET /v1/audit — recent KNOLL security audit verdicts (read-only). */
  handleAudit(limit?: number): GatewayResponse {
    const n = clampLimit(limit, this.readLimit);
    const all = this.orchestrator.auditTrail();
    const recent = all.slice(-n).map((a) => ({
      packetId: a.packetId,
      outcome: a.outcome,
      reasoning: a.reasoning,
      timestamp: a.timestamp,
    }));
    return {
      status: 200,
      body: {
        count: recent.length,
        allowed: all.filter((a) => a.outcome === 'ALLOWED').length,
        blocked: all.filter((a) => a.outcome === 'BLOCKED').length,
        entries: recent,
      },
    };
  }

  /** GET /v1/matrix/stats — node / persona topology and parameter accounting stats. */
  handleMatrixStats(): GatewayResponse {
    const acc = computeParameterAccounting();
    return {
      status: 200,
      body: {
        topology: {
          managersPerAgent: MANAGERS_PER_AGENT,
          nodesPerManager: NODES_PER_MANAGER,
          nodesPerAgent: NODES_PER_AGENT,
          totalNodes: TOTAL_NODES,
          personasPerNode: PERSONAS_PER_NODE,
          totalPersonas: TOTAL_PERSONAS,
        },
        parameters: {
          modelSize: acc.modelSize,
          totalConceptual: TOTAL_CONCEPTUAL_PARAMETERS,
          totalConceptualExp: TOTAL_CONCEPTUAL_PARAMETERS.toExponential(4),
          perAgent: acc.perAgent.map((a) => ({
            role: a.role,
            alwaysOn: a.alwaysOn,
            ephemeral: a.ephemeral,
            parameters: a.parameters,
            shareOfTotal: a.shareOfTotal,
          })),
        },
        alwaysOn: ALWAYS_ON_AGENTS,
        ephemeral: EPHEMERAL_AGENTS,
        recentHopeResults: this.hopeResults.length,
      },
    };
  }

  /**
   * GET /v1/metrics — observability snapshot. Defaults to a JSON snapshot; pass
   * `?format=prometheus` (or `text`) for a Prometheus-ish exposition. Read-only: it only
   * reflects APEX traffic the gateway already routed via APEX + KNOLL.
   */
  handleMetrics(format?: string): GatewayResponse {
    if (format === 'prometheus' || format === 'text') {
      return {
        status: 200,
        body: {},
        text: this.metrics.toPrometheus(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      };
    }
    return {
      status: 200,
      body: { ...this.metrics.snapshot(), recentTrace: this.tracer.recent(20) },
    };
  }

  /**
   * Route a parsed request to a handler. Async so a real body read can be awaited by the
   * server wrapper; handlers themselves are synchronous. This is the single mapping table.
   */
  async route(method: string, pathname: string, query: URLSearchParams, body: unknown): Promise<GatewayResponse> {
    const m = method.toUpperCase();
    if (m === 'POST' && pathname === '/v1/intent') return this.handleIntent(body);
    if (m === 'GET' && pathname === '/v1/health') return this.handleHealth();
    if (m === 'GET' && pathname === '/v1/ledger') return this.handleLedger(numParam(query.get('limit')));
    if (m === 'GET' && pathname === '/v1/audit') return this.handleAudit(numParam(query.get('limit')));
    if (m === 'GET' && pathname === '/v1/matrix/stats') return this.handleMatrixStats();
    if (m === 'GET' && pathname === '/v1/metrics') return this.handleMetrics(query.get('format') ?? undefined);
    return { status: 404, body: { error: `no route for ${m} ${pathname}` } };
  }

  /** Build a node:http server bound to this gateway's routes (no framework). */
  createServer(): http.Server {
    return http.createServer((req, res) => {
      void this.serve(req, res);
    });
  }

  /** Start listening. Resolves once bound. */
  listen(port: number): Promise<http.Server> {
    const server = this.createServer();
    return new Promise((resolve) => {
      server.listen(port, () => resolve(server));
    });
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const start = Date.now();
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const guardReq = {
      method,
      pathname: url.pathname,
      headers: req.headers,
      ip: clientIp(req.headers, req.socket?.remoteAddress ?? undefined),
    };

    const log = (status: number): void => {
      this.logger({
        method: method.toUpperCase(),
        path: url.pathname,
        status,
        durationMs: Date.now() - start,
        ip: guardReq.ip,
        authState: this.middleware.authState(guardReq),
      });
    };

    try {
      // Front-door guards: CORS + auth + rate limiting. May short-circuit (204/401/429).
      const guard = this.middleware.guard(guardReq, start);
      if (guard.response) {
        writeJson(res, guard.response.status, guard.response.body, guard.headers);
        log(guard.response.status);
        return;
      }

      const body = method === 'POST' || method === 'PUT' ? await readJsonBody(req) : undefined;
      const result = await this.route(method, url.pathname, url.searchParams, body);
      if (typeof result.text === 'string') {
        writeText(res, result.status, result.text, result.contentType ?? 'text/plain; charset=utf-8', guard.headers);
      } else {
        writeJson(res, result.status, result.body, guard.headers);
      }
      log(result.status);
    } catch (err) {
      writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) }, this.middleware.corsHeaders());
      log(500);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function extractUtterance(body: unknown): string | undefined {
  if (body !== null && typeof body === 'object' && 'utterance' in body) {
    const u = (body as { utterance?: unknown }).utterance;
    if (typeof u === 'string' && u.trim().length > 0) return u.trim();
  }
  return undefined;
}

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

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), 500);
}

function numParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Guard against unbounded bodies (1 MiB cap).
      if (size > 1_048_576) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  // 204 (e.g. CORS preflight) carries no message body per HTTP semantics.
  if (status === 204) {
    res.writeHead(status, extraHeaders);
    res.end();
    return;
  }
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(payload);
}

/** Write a raw text response (e.g. Prometheus exposition) with the given content type. */
function writeText(
  res: http.ServerResponse,
  status: number,
  text: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': contentType, ...extraHeaders });
  res.end(text);
}
