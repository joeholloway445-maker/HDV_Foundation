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
import type {
  RequestLogRepository,
  SecurityAuditRepository,
  CompanionMemoryRepository,
  TaskQueue,
  UserRepository,
  SessionRepository,
} from '../persistence/index.js';
import { InMemoryUserRepository, InMemorySessionRepository } from '../persistence/index.js';
import { AuthService, AuthError } from '../auth/index.js';
import { InMemoryCompanionMemoryRepository } from '../persistence/index.js';
import { MetricsCollector, PacketTracer, combineObservers } from '../observability/index.js';
import { BillingService, isPlanTier, type PlanTier } from '../billing/index.js';
import { IntentInterpreter, HopeDocumenter, HopeVoice, IntentEnricher } from '../hope/index.js';
import type { LlmProvider } from '../providers/types.js';
import { createProviderOrStub } from '../providers/index.js';
import { SimulationEngine } from '../dream/index.js';
import { ExecutionEngine } from '../vision/index.js';
import { WaitlistStore, handleWaitlistSignup, handleWaitlistStats } from '../market/index.js';
import {
  handleCompanionChat,
  handleCompanionChatStream,
  handlePortraitRequest,
  handleSceneRequest,
  defaultCompanionMemory,
} from '../companion/index.js';
import { createImageProviderOrStub } from '../providers/image_factory.js';
import type { ImageProvider } from '../providers/image_types.js';
import { createVideoProviderOrStub } from '../providers/video_factory.js';
import type { VideoProvider } from '../providers/video_types.js';
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
  MODEL_SIZE,
} from '../nodes/index.js';

/**
 * POST /v1/companion/chat/stream — the SSE twin of POST /v1/companion/chat. Its own module-level
 * constant (rather than a literal buried in `serve()`) because it's checked in TWO places: the
 * `serve()` bypass below, and gateway/middleware.ts's AUTH_EXEMPT_PATHS (same public-but-rate-
 * limited posture as /v1/companion/chat — no API key, but still rate-limited).
 */
export const COMPANION_CHAT_STREAM_PATH = '/v1/companion/chat/stream';

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
  /**
   * PRODUCT metering layer (billing/). Bundles the pricing engine, per-tenant allowance store,
   * and the MeterService. When the gateway builds its own orchestrator (the default), the
   * meter is wired to the SAME read-only dispatch observer as metrics/tracing, so every gated
   * route is attributed to a tenant's allowance without touching routing or KNOLL. Defaults to
   * a BillingService loading config/pricing.json with the offline `demo` tenant seeded.
   */
  billing?: BillingService;
  /**
   * Launch GTM waitlist store (market/). Backs POST /v1/waitlist (public — auth-exempt but
   * rate-limited) and GET /v1/waitlist/stats (protected). It is a standalone data surface that
   * never routes, gates, or executes — it only captures inbound interest. Defaults to a new
   * in-memory store.
   */
  waitlist?: WaitlistStore;
  /**
   * Phase 5 durability. When the gateway builds its OWN orchestrator (the default), these are
   * forwarded to it so the APEX ledger and KNOLL audit trail are mirrored into durable
   * repositories (see persistence/). They are ignored when you inject your own `orchestrator`
   * (wire them into it yourself). The offline default leaves both undefined (pure in-memory).
   */
  requestLog?: RequestLogRepository;
  securityAudit?: SecurityAuditRepository;
  /**
   * Opt-in companion relationship memory (companion/memory.ts). Threaded through to
   * handleCompanionChat exactly like `requestLog`/`securityAudit` above: when the caller
   * (gateway/cli.ts) builds a Prisma-backed repository bundle because DATABASE_URL is set, it
   * forwards `repositories.companionMemory` here; otherwise this defaults to a fresh in-memory
   * repository. Memory only ever activates for a given chat call when the CLIENT also supplies
   * `companionId` — see companion/handlers.ts. Also backs GET /v1/companion/memory.
   */
  memoryRepository?: CompanionMemoryRepository;
  /**
   * Phase 5 async intake. When provided (and the gateway builds its own orchestrator), the
   * task queue is wired into the ApexOrchestrator so callers can `intake()` packets and a
   * consumer drains them through the SAME KNOLL-gated dispatch path. Pure transport: it never
   * bypasses APEX/KNOLL. Ignored when you inject your own `orchestrator`.
   */
  queue?: TaskQueue;
  /**
   * Optional LLM provider for HOPE intent-summary enrichment (text only — never routes).
   * When omitted, the gateway builds one from HDV_LLM_* env via createProviderOrStub
   * (defaults to the offline stub). Pass `false` to force heuristic-only (no provider).
   */
  provider?: LlmProvider | false;
  /** Optional IntentEnricher. When omitted, one is built from `provider` (or env). */
  enricher?: IntentEnricher;
  /**
   * Optional image provider for companion portraits (image only — never routes). When omitted,
   * the gateway builds one from HDV_IMAGE_* env via createImageProviderOrStub (defaults to the
   * offline stub). Pass `false` to force "unavailable" responses (no provider at all).
   */
  imageProvider?: ImageProvider | false;
  /**
   * Optional video provider for companion scenes/loops (video only — never routes). When
   * omitted, the gateway builds one from HDV_VIDEO_* env via createVideoProviderOrStub
   * (defaults to the offline stub). Pass `false` to force "unavailable" responses.
   */
  videoProvider?: VideoProvider | false;
  /**
   * Account/auth layer (auth/) — email+password signup/login and bearer session tokens,
   * surfaced at POST /v1/auth/{signup,login,logout} and GET /v1/auth/me. Provide a pre-wired
   * AuthService, or leave it undefined and instead pass `users`/`sessions` repositories (e.g.
   * Postgres-backed via persistence/factory.ts) — defaults to fresh in-memory repositories.
   * NOT wired into billing/checkout's tenant resolution in this pass — see the TODO next to
   * handleBillingCheckout.
   */
  auth?: AuthService;
  /** UserRepository backing the default AuthService. Ignored when `auth` is provided. */
  users?: UserRepository;
  /** SessionRepository backing the default AuthService. Ignored when `auth` is provided. */
  sessions?: SessionRepository;
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
  /** PRODUCT metering layer surfaced under GET/POST /v1/billing/*. */
  readonly billing: BillingService;
  /** Account/auth layer surfaced under POST/GET /v1/auth/*. See HopeGatewayOptions.auth. */
  readonly auth: AuthService;
  /** Launch GTM waitlist surfaced under POST /v1/waitlist and GET /v1/waitlist/stats. */
  readonly waitlist: WaitlistStore;
  /** HOPE intent-summary enricher (heuristic or LLM). Text only — never routes. */
  readonly enricher: IntentEnricher;
  /**
   * Shared LlmProvider instance used for companion chat (companion/), same env-driven
   * offline-first construction as the enricher's provider. Undefined ⇒ deterministic fallback
   * replies only (still fully functional offline).
   */
  private readonly companionProvider?: LlmProvider;
  /**
   * Opt-in companion relationship memory (companion/memory.ts). Defaults to a fresh in-memory
   * repository when not injected; gateway/cli.ts injects a Prisma-backed one when DATABASE_URL
   * is set (same wiring as `requestLog`/`securityAudit`). Only ever read/written by a chat call
   * that ALSO supplies `companionId` — see companion/handlers.ts.
   */
  private readonly companionMemory: CompanionMemoryRepository;
  /**
   * Shared ImageProvider instance used for companion portraits (companion/portrait_*), same
   * env-driven offline-first construction as companionProvider. Undefined ⇒ "unavailable"
   * response only (still fully functional offline — no crash, no placeholder pixel shown).
   */
  private readonly imageProvider?: ImageProvider;
  /**
   * Shared VideoProvider instance used for companion scenes/loops (companion/scene_*), same
   * env-driven offline-first construction as imageProvider. Undefined ⇒ "unavailable" response
   * only.
   */
  private readonly videoProvider?: VideoProvider;
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
    // PRODUCT metering plugs into the SAME read-only observer seam as metrics/tracing, so every
    // gated dispatch is attributed to a tenant allowance without ever touching routing or KNOLL.
    this.billing = options.billing ?? new BillingService();
    // Account/auth layer: in-memory repositories by default (zero external dependencies,
    // matching every other repository in persistence/); pass `users`/`sessions` for a
    // Postgres-backed AuthService, or a fully pre-wired `auth` to override entirely.
    this.auth =
      options.auth ??
      new AuthService({
        users: options.users ?? new InMemoryUserRepository(),
        sessions: options.sessions ?? new InMemorySessionRepository(),
      });
    // Launch waitlist: a standalone GTM capture surface, wholly independent of routing/KNOLL.
    this.waitlist = options.waitlist ?? new WaitlistStore();
    const observer = combineObservers(
      this.metrics.observer(),
      this.tracer.observer(),
      this.billing.meter.observer(),
    );
    this.orchestrator =
      options.orchestrator ??
      new ApexOrchestrator({
        defaultCostUsd: 0.02,
        observer,
        // Durable mirrors + async intake are additive: undefined ⇒ the offline in-memory path.
        requestLog: options.requestLog,
        securityAudit: options.securityAudit,
        queue: options.queue,
      });
    this.interpreter = options.interpreter ?? new IntentInterpreter();
    this.documenter = options.documenter ?? new HopeDocumenter();
    this.voice = options.voice ?? new HopeVoice();
    // Provider enrichment is optional and offline-safe: stub by default, real model when
    // HDV_LLM_* points at an OpenAI-compatible endpoint (e.g. co-located Ollama). Built once
    // and shared with companion chat below so both surfaces hit the same configured backend.
    const provider = options.provider === false ? undefined : options.provider ?? createProviderOrStub();
    this.companionProvider = provider;
    if (options.enricher) {
      this.enricher = options.enricher;
    } else {
      this.enricher = new IntentEnricher({ provider });
    }
    // Companion portraits: same offline-first construction, independent of the text provider
    // (an operator may run Ollama for text and a Colab-tunnel model for images, or vice versa).
    this.imageProvider =
      options.imageProvider === false ? undefined : options.imageProvider ?? createImageProviderOrStub();
    this.videoProvider =
      options.videoProvider === false ? undefined : options.videoProvider ?? createVideoProviderOrStub();
    this.companionMemory = options.memoryRepository ?? new InMemoryCompanionMemoryRepository();
    this.readLimit = options.readLimit ?? 50;
    this.middleware = new GatewayMiddleware(resolveSecurityConfig(options.security ?? {}));
    this.logger = options.logger === false ? () => {} : options.logger ?? defaultLogger;

    // Wire the ephemeral engines via DI (composition root — no peer imports between peers).
    // Live persona inference is env-gated (HDV_PERSONA_INFERENCE=1 → Ollama per persona).
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
   * Optionally enriches the human-readable intent summary via the injected LLM provider
   * (text only — never changes classification, routing, or governance).
   */
  async handleIntent(body: unknown): Promise<GatewayResponse> {
    const utterance = extractUtterance(body);
    if (!utterance) {
      return { status: 400, body: { error: 'body must be JSON with a non-empty "utterance" string' } };
    }

    const classified = this.interpreter.interpret(utterance);
    const { intent, summary: enriched } = await this.enricher.enrichIntent(classified);
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
          enrichment: { source: enriched.source, model: enriched.model ?? null },
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
        enrichment: { source: enriched.source, model: enriched.model ?? null },
      },
    };
  }

  /**
   * POST /v1/worker/report — RE-INGEST a horizontal worker's result through APEX only.
   *
   * Ephemeral DREAM/VISION Colab workers (see colab/worker_protocol.py) do one batch of work
   * and hand results back through APEX — never peer-to-peer, never DREAM↔VISION direct. This
   * endpoint accepts a `WorkerReport.to_apex_payload()`-shaped body
   * `{ source, destination?, intent?, data? }` and re-mints it as a RoutingPacket dispatched
   * via `sendViaApex` (→ KNOLL → HOPE). It NEVER bypasses APEX or KNOLL.
   *
   * Gateway-level worker-protocol invariants (enforced before dispatch, mirroring the Python
   * WorkerReport.validate()):
   *   - `source` MUST be an EPHEMERAL role (DREAM or VISION). HOPE/KNOLL/APEX are always-on
   *     and are never disposable workers, so they may not report via this endpoint.
   *   - A direct DREAM↔VISION hand-off is rejected outright (it is also blocked by KNOLL, but
   *     we fail fast with a clear 400 here).
   * Everything else remains KNOLL's authority: a BLOCKED verdict surfaces as HTTP 403.
   */
  handleWorkerReport(body: unknown): GatewayResponse {
    if (body === null || typeof body !== 'object') {
      return {
        status: 400,
        body: { error: 'body must be JSON: { source: "DREAM"|"VISION", destination?, intent?, data? }' },
      };
    }
    const b = body as Record<string, unknown>;

    const source = parseRole(b.source);
    if (source === undefined) {
      return { status: 400, body: { error: 'source must be a valid AgentRole (e.g. "DREAM" or "VISION")' } };
    }
    if (source !== AgentRole.DREAM && source !== AgentRole.VISION) {
      return {
        status: 400,
        body: {
          error: `source ${source} is not an ephemeral worker role; only DREAM and VISION report via APEX`,
        },
      };
    }

    // Destination defaults to HOPE — workers report their results back to HOPE via APEX.
    const destination = b.destination === undefined ? AgentRole.HOPE : parseRole(b.destination);
    if (destination === undefined) {
      return { status: 400, body: { error: 'destination must be a valid AgentRole (defaults to "HOPE")' } };
    }
    // Fail fast on the forbidden direct DREAM↔VISION hand-off (KNOLL also blocks this).
    if (
      (source === AgentRole.DREAM && destination === AgentRole.VISION) ||
      (source === AgentRole.VISION && destination === AgentRole.DREAM)
    ) {
      return {
        status: 400,
        body: {
          error: 'illegal report route: DREAM ↔ VISION direct is forbidden; report via APEX to HOPE',
        },
      };
    }

    const intent =
      typeof b.intent === 'string' && b.intent.trim().length > 0
        ? b.intent.trim()
        : `worker-result:${source.toLowerCase()}`;
    const data =
      b.data !== null && typeof b.data === 'object' ? (b.data as Record<string, unknown>) : {};
    const priority = parsePriority(b.priority);

    // Re-ingest through APEX. sendViaApex mints a legal, hashed, tokenized packet and dispatch
    // calls KNOLL first — the worker result is gated exactly like any other traffic.
    const result = this.orchestrator.sendViaApex({ source, destination, intent, data, priority });
    const workerId = typeof data.workerId === 'string' ? data.workerId : null;

    const httpStatus = result.status === 'SUCCESS' ? 200 : result.status === 'BLOCKED' ? 403 : 502;
    return {
      status: httpStatus,
      body: {
        accepted: true,
        ingested: result.status === 'SUCCESS',
        routingStatus: result.status,
        knoll: result.knoll,
        source,
        destination,
        intent,
        workerId,
        packetId: result.packetId,
        error: result.error,
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

  // -------------------------------------------------------------------------
  // Billing (PRODUCT metering) — GET/POST /v1/billing/*. Tenant via X-HDV-Tenant
  // (default "demo"). These only price + account; they never route, gate, or execute.
  // -------------------------------------------------------------------------

  /** GET /v1/billing/usage — a tenant's balance, spend, and recent occurrences. */
  handleBillingUsage(tenantId: string, limit?: number): GatewayResponse {
    const n = clampLimit(limit, this.readLimit);
    const balance = this.billing.store.balance(tenantId);
    const occurrences = this.billing.store.recentOccurrences(tenantId, n);
    return {
      status: 200,
      body: {
        tenantId: balance.tenantId,
        balance,
        meter: this.billing.meter.stats(),
        occurrences,
      },
    };
  }

  /** GET /v1/billing/pricing — the public, marketing-ready pricing table (no tenant needed). */
  handleBillingPricing(): GatewayResponse {
    return { status: 200, body: this.billing.pricing.publicTable() };
  }

  /**
   * POST /v1/billing/allowance — set/adjust a tenant's allowance (admin/dev for now).
   * Body: { tier?, includedAllowanceUsd?, hardCapUsd? }. Tenant via X-HDV-Tenant.
   */
  handleBillingAllowance(tenantId: string, body: unknown): GatewayResponse {
    if (body === null || typeof body !== 'object') {
      return { status: 400, body: { error: 'body must be JSON: { tier?, includedAllowanceUsd?, hardCapUsd? }' } };
    }
    const b = body as Record<string, unknown>;

    let tier: PlanTier | undefined;
    if (b.tier !== undefined) {
      const raw = typeof b.tier === 'string' ? b.tier.trim().toUpperCase() : b.tier;
      if (!isPlanTier(raw)) {
        return { status: 400, body: { error: `invalid tier — must be one of FREE, STARTER, PRO, ENTERPRISE, BYOK` } };
      }
      tier = raw;
    }

    const includedAllowanceUsd = optionalNonNegative(b.includedAllowanceUsd);
    if (includedAllowanceUsd === INVALID) {
      return { status: 400, body: { error: 'includedAllowanceUsd must be a non-negative number' } };
    }
    // hardCapUsd allows null to mean "unlimited".
    let hardCapUsd: number | null | undefined;
    if (b.hardCapUsd === null) hardCapUsd = null;
    else {
      const v = optionalNonNegative(b.hardCapUsd);
      if (v === INVALID) return { status: 400, body: { error: 'hardCapUsd must be a non-negative number or null' } };
      hardCapUsd = v;
    }

    if (tier === undefined && includedAllowanceUsd === undefined && hardCapUsd === undefined) {
      return { status: 400, body: { error: 'provide at least one of tier, includedAllowanceUsd, hardCapUsd' } };
    }

    this.billing.store.setAllowance(tenantId, { tier, includedAllowanceUsd, hardCapUsd });
    const balance = this.billing.store.balance(tenantId);
    return { status: 200, body: { ok: true, tenantId: balance.tenantId, balance } };
  }

  /**
   * GET /v1/billing/estimate — a cost estimate for a hypothetical unit of work. Inputs come
   * from the JSON body { activeParams, durationSec, model?, tier? } or the equivalent query
   * params. Returns the estimate for the caller's tier (X-HDV-Tenant / ?tier) plus a per-tier
   * comparison. Pricing is per-tier and model-agnostic (predictable); `model` is echoed as
   * metadata and recorded on real occurrences.
   */
  handleBillingEstimate(tenantId: string, query: URLSearchParams, body: unknown): GatewayResponse {
    const b = (body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {});
    const activeParams = firstNumber(b.activeParams, numParam(query.get('activeParams')));
    const durationSec = firstNumber(b.durationSec, numParam(query.get('durationSec')));
    const model = firstString(b.model, query.get('model')) ?? MODEL_SIZE;

    if (activeParams === undefined || activeParams <= 0) {
      return { status: 400, body: { error: 'activeParams must be a positive number (body or query)' } };
    }
    if (durationSec === undefined || durationSec <= 0) {
      return { status: 400, body: { error: 'durationSec must be a positive number (body or query)' } };
    }

    const rawTier = firstString(b.tier, query.get('tier'));
    let tier: PlanTier;
    if (rawTier !== undefined) {
      const upper = rawTier.trim().toUpperCase();
      if (!isPlanTier(upper)) {
        return { status: 400, body: { error: `invalid tier — must be one of FREE, STARTER, PRO, ENTERPRISE, BYOK` } };
      }
      tier = upper;
    } else {
      tier = this.billing.store.balance(tenantId).tier;
    }

    const priorSpendUsd = this.billing.store.balance(tenantId).spentUsd;
    const estimate = this.billing.pricing.estimate({ tier, activeParams, durationSec, priorSpendUsd });
    const perTier = this.billing.pricing.tiers().map((t) =>
      this.billing.pricing.estimate({ tier: t.tier, activeParams, durationSec }),
    );

    return {
      status: 200,
      body: {
        tenantId,
        tier,
        model,
        activeParams: estimate.activeParams,
        durationSec: estimate.durationSec,
        activeParamSeconds: estimate.activeParamSeconds,
        activePersonaSeconds: estimate.activePersonaSeconds,
        currency: estimate.currency,
        unit: estimate.unit,
        estimate,
        perTier,
      },
    };
  }

  /**
   * POST /v1/billing/checkout — start a (stub) Stripe Checkout session for a plan tier. Body:
   * { tier, interval?, quantity?, customerEmail? }. Tenant via X-HDV-Tenant. Returns the hosted
   * checkout `url` the client redirects to, plus the session id to poll/settle.
   *
   * STUB NOTE: with no STRIPE_SECRET_KEY configured (the default), this issues a fake but
   * well-formed test-mode session — no network call, no real charge, safe to expose publicly
   * today. Swapping in a real Stripe key later is a single-constructor change in
   * billing/stripe_stub.ts; at that point checkout confirmation MUST move to a real,
   * signature-verified Stripe webhook instead of the client-callable settle endpoint below.
   */
  handleBillingCheckout(tenantId: string, body: unknown): GatewayResponse {
    if (body === null || typeof body !== 'object') {
      return { status: 400, body: { error: 'body must be JSON: { tier, interval?, quantity?, customerEmail? }' } };
    }
    const b = body as Record<string, unknown>;
    if (typeof b.tier !== 'string' || !isPlanTier(b.tier.trim().toUpperCase())) {
      return { status: 400, body: { error: 'tier must be one of FREE, STARTER, PRO, ENTERPRISE, BYOK' } };
    }
    const interval = b.interval === 'year' ? 'year' : 'month';
    const quantity = typeof b.quantity === 'number' && b.quantity > 0 ? Math.floor(b.quantity) : 1;
    const customerEmail = typeof b.customerEmail === 'string' ? b.customerEmail.trim() || undefined : undefined;

    try {
      const session = this.billing.checkout.createCheckoutSession({
        tier: b.tier.trim().toUpperCase(),
        tenantId,
        interval,
        quantity,
        customerEmail,
      });
      return {
        status: 200,
        body: { sessionId: session.id, url: session.url, livemode: session.livemode, session },
      };
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  /** GET /v1/billing/checkout?session_id=... — look up a (stub) checkout session's status. */
  handleBillingCheckoutGet(sessionId: string | null): GatewayResponse {
    if (!sessionId) return { status: 400, body: { error: 'session_id query param is required' } };
    const session = this.billing.checkout.retrieveSession(sessionId);
    if (!session) return { status: 404, body: { error: 'unknown or expired session_id' } };
    return { status: 200, body: { session } };
  }

  /**
   * POST /v1/billing/checkout/settle — TEST-MODE ONLY: simulate the customer completing payment
   * (what a real `checkout.session.completed` Stripe webhook would confirm) and upgrade the
   * tenant's allowance to the purchased tier. Body: { sessionId }. Do not expose this once a
   * live STRIPE_SECRET_KEY is configured — replace with real webhook verification first.
   */
  handleBillingCheckoutSettle(body: unknown): GatewayResponse {
    if (body === null || typeof body !== 'object') {
      return { status: 400, body: { error: 'body must be JSON: { sessionId }' } };
    }
    const b = body as Record<string, unknown>;
    if (typeof b.sessionId !== 'string' || !b.sessionId.trim()) {
      return { status: 400, body: { error: '"sessionId" must be a non-empty string' } };
    }
    const session = this.billing.checkout.markSessionPaid(b.sessionId.trim());
    if (!session) return { status: 404, body: { error: 'unknown or expired session_id' } };
    if (session.status !== 'complete') {
      return { status: 200, body: { ok: false, session, reason: 'session expired before settling' } };
    }
    const tenantId = session.tenantId || 'demo';
    this.billing.store.setAllowance(tenantId, { tier: session.tier });
    const balance = this.billing.store.balance(tenantId);
    return { status: 200, body: { ok: true, session, tenantId, balance } };
  }

  // -------------------------------------------------------------------------
  // Auth (auth/) — POST /v1/auth/{signup,login,logout}, GET /v1/auth/me. All four are
  // auth-exempt (see AUTH_EXEMPT_PATHS in gateway/middleware.ts) — they ARE the account
  // system, so they can't require the operator's HDV_API_KEY to reach them. signup/login
  // additionally carry a stricter, dedicated per-IP rate limit (brute-force defense).
  //
  // NOT WIRED into billing/checkout's tenant resolution in this pass: X-HDV-Tenant keeps
  // working exactly as it does today (anonymous, client-supplied) so the existing billing
  // tests are unaffected by this change.
  // TODO(auth-billing): once clients migrate to real accounts, billing/checkout and
  // billing/checkout/settle should require a valid X-HDV-Session and derive tenantId from
  // the authenticated user instead of trusting a client-supplied X-HDV-Tenant header. That is
  // a breaking change for anonymous checkout and is deliberately left as a separate follow-up
  // — not implemented here.
  // -------------------------------------------------------------------------

  /**
   * POST /v1/auth/signup — { email, password } → { userId, email, sessionToken }. The password
   * hash is never returned (or stored anywhere but passwordHash). Email format is validated
   * loosely (must look like local@domain.tld); password must be 8+ characters.
   */
  handleAuthSignup(body: unknown): GatewayResponse {
    const { email, password } = extractCredentials(body);
    if (email === undefined || password === undefined) {
      return { status: 400, body: { error: 'body must be JSON: { email, password }' } };
    }
    try {
      const { user, sessionToken } = this.auth.signup(email, password);
      return { status: 200, body: { userId: user.userId, email: user.email, sessionToken } };
    } catch (err) {
      return authErrorResponse(err);
    }
  }

  /**
   * POST /v1/auth/login — { email, password } → same shape as signup, or 401 with a single
   * generic message ("invalid email or password") for BOTH an unknown email and a wrong
   * password — this never reveals which, so a caller can't enumerate registered emails.
   */
  handleAuthLogin(body: unknown): GatewayResponse {
    const { email, password } = extractCredentials(body);
    if (email === undefined || password === undefined) {
      return { status: 400, body: { error: 'body must be JSON: { email, password }' } };
    }
    try {
      const { user, sessionToken } = this.auth.login(email, password);
      return { status: 200, body: { userId: user.userId, email: user.email, sessionToken } };
    } catch (err) {
      return authErrorResponse(err);
    }
  }

  /**
   * POST /v1/auth/logout — session token via the X-HDV-Session header (preferred) or a JSON
   * body { sessionToken }. Idempotent: always 200, even for an unknown/already-expired token.
   */
  handleAuthLogout(
    body: unknown,
    headers?: Record<string, string | string[] | undefined>,
  ): GatewayResponse {
    this.auth.logout(sessionTokenFromRequest(headers, body));
    return { status: 200, body: { ok: true } };
  }

  /** GET /v1/auth/me — X-HDV-Session header → { userId, email }, or 401 if missing/invalid/expired. */
  handleAuthMe(headers?: Record<string, string | string[] | undefined>): GatewayResponse {
    const user = this.auth.getUserBySession(sessionTokenFromRequest(headers, undefined));
    if (!user) {
      return { status: 401, body: { error: 'invalid, missing, or expired session' } };
    }
    return { status: 200, body: { userId: user.userId, email: user.email } };
  }

  // -------------------------------------------------------------------------
  // Launch GTM waitlist (market/). POST /v1/waitlist is auth-exempt (public form) but
  // rate-limited; GET /v1/waitlist/stats is protected. Neither routes, gates, or executes —
  // they only capture inbound interest and report privacy-safe aggregate stats.
  // -------------------------------------------------------------------------

  /** POST /v1/waitlist — record a (public) waitlist signup. Idempotent by email. */
  handleWaitlistSignup(body: unknown, ip?: string): GatewayResponse {
    return handleWaitlistSignup(this.waitlist, body, { ip, defaultSource: 'api' });
  }

  /** GET /v1/waitlist/stats — privacy-safe aggregate signup stats (protected; counts only). */
  handleWaitlistStats(): GatewayResponse {
    return handleWaitlistStats(this.waitlist);
  }

  // -------------------------------------------------------------------------
  // Companion chat (companion/). POST /v1/companion/chat is auth-exempt (public product
  // surface — the FuckLike web client calls it directly with no key) but rate-limited. It
  // never routes, gates, or executes — it only turns a persona + history into one reply via
  // the same injected LlmProvider the HOPE enricher uses (offline stub ⇒ canned fallback).
  // -------------------------------------------------------------------------

  /**
   * POST /v1/companion/chat — one in-character reply for a companion persona. Memory
   * (companion/memory.ts) only activates when the request body ALSO supplies `companionId` —
   * see companion/handlers.ts. Passing the repository here unconditionally is safe: absent a
   * companionId, the handler never touches it.
   */
  async handleCompanionChat(body: unknown): Promise<GatewayResponse> {
    return handleCompanionChat(body, { provider: this.companionProvider, memoryRepository: this.companionMemory });
  }

  /**
   * GET /v1/companion/memory?companionId=... — read-only lookup of a companion's remembered
   * relationship state (affection level, running summary, turn count). Public/auth-exempt,
   * rate-limited posture, same as the other companion/ routes (see AUTH_EXEMPT_PATHS in
   * gateway/middleware.ts). Returns sensible defaults (never a 404) for a companionId with no
   * memory yet, so a frontend can render a fresh "relationship level" UI immediately.
   */
  handleCompanionMemoryGet(companionId: string | null): GatewayResponse {
    const trimmed = companionId?.trim() ?? '';
    if (!trimmed) {
      return { status: 400, body: { error: '"companionId" query parameter is required' } };
    }
    const memory = this.companionMemory.get(trimmed) ?? defaultCompanionMemory(trimmed);
    return { status: 200, body: { memory } };
  }

  /**
   * POST /v1/companion/chat/stream — token-by-token SSE twin of POST /v1/companion/chat.
   *
   * PURELY ADDITIVE: this does not alter handleCompanionChat or the buffered /v1/companion/chat
   * route in any way — they remain two independent handlers sharing only companion/handlers.ts's
   * internal validation/prompt/fallback logic (via handleCompanionChatStream).
   *
   * Writes Server-Sent Events directly to `res`:
   *   - one `data: {"delta":"..."}\n\n` frame per chunk of new text, in order;
   *   - a final `data: {"done":true,"source":"llm"|"fallback","model":...}\n\n` frame.
   * SSE headers are written lazily, on the FIRST event — so if validation fails
   * (handleCompanionChatStream returns 400 before firing any event, e.g. the 18+ floor), this
   * writes a normal buffered JSON 400 instead, exactly like /v1/companion/chat does. No provider,
   * the stub provider, or a provider without `completeStream` all fall back to the SAME
   * deterministic per-personality reply /v1/companion/chat uses (as one SSE chunk), so the SSE
   * contract is identical regardless of whether a real provider is streaming.
   *
   * Returns the HTTP status actually written, for request logging — same as every other route.
   */
  async serveCompanionChatStream(
    body: unknown,
    res: http.ServerResponse,
    responseHeaders: Record<string, string>,
  ): Promise<number> {
    let sseStarted = false;
    const startSse = (): void => {
      if (sseStarted) return;
      sseStarted = true;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        ...responseHeaders,
      });
    };
    const writeSseEvent = (data: Record<string, unknown>): void => {
      startSse();
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const result = await handleCompanionChatStream(
      body,
      { provider: this.companionProvider },
      {
        onDelta: (delta) => writeSseEvent({ delta }),
        onDone: (info) => {
          writeSseEvent({ done: true, ...info });
          res.end();
        },
      },
    );

    // Validation (e.g. missing persona / message, or the 18+ floor) failed BEFORE any event
    // fired — sseStarted is still false, so it's safe to answer with a normal buffered 400,
    // matching /v1/companion/chat's contract for the same input.
    if (result.status !== 200) {
      writeJson(res, result.status, result.body ?? { error: 'invalid request' }, responseHeaders);
      return result.status;
    }
    return 200;
  }

  /**
   * POST /v1/companion/portrait — one portrait image for a companion persona. Same
   * auth-exempt-but-rate-limited posture as chat; same offline-safe "unavailable" response
   * when no ImageProvider is configured. Provider-agnostic: HDV_IMAGE_PROVIDER selects
   * Google AI Studio (SFW) or a Colab tunnel (self-hosted, e.g. NSFW-capable) with no
   * frontend changes required either way.
   */
  async handlePortraitRequest(body: unknown): Promise<GatewayResponse> {
    return handlePortraitRequest(body, { provider: this.imageProvider });
  }

  /**
   * POST /v1/companion/scene — animate an existing portrait (client-supplied seed image) into
   * a short video/loop. Same auth-exempt-but-rate-limited posture; same offline-safe
   * "unavailable" response when no VideoProvider is configured (e.g. LingBot-World via a
   * Colab tunnel — see colab/08_scene_server.py).
   */
  async handleSceneRequest(body: unknown): Promise<GatewayResponse> {
    return handleSceneRequest(body, { provider: this.videoProvider });
  }

  /**
   * Route a parsed request to a handler. Async so a real body read can be awaited by the
   * server wrapper; handlers themselves are synchronous. This is the single mapping table.
   * `headers` is optional (only billing routes read it, for X-HDV-Tenant) so existing callers
   * are unaffected.
   */
  async route(
    method: string,
    pathname: string,
    query: URLSearchParams,
    body: unknown,
    headers?: Record<string, string | string[] | undefined>,
  ): Promise<GatewayResponse> {
    const m = method.toUpperCase();
    if (m === 'POST' && pathname === '/v1/intent') return await this.handleIntent(body);
    if (m === 'POST' && pathname === '/v1/worker/report') return this.handleWorkerReport(body);
    if (m === 'GET' && pathname === '/v1/health') return this.handleHealth();
    if (m === 'GET' && pathname === '/v1/ledger') return this.handleLedger(numParam(query.get('limit')));
    if (m === 'GET' && pathname === '/v1/audit') return this.handleAudit(numParam(query.get('limit')));
    if (m === 'GET' && pathname === '/v1/matrix/stats') return this.handleMatrixStats();
    if (m === 'GET' && pathname === '/v1/metrics') return this.handleMetrics(query.get('format') ?? undefined);
    // --- Billing (PRODUCT metering). Tenant resolved from X-HDV-Tenant (default "demo").
    if (m === 'GET' && pathname === '/v1/billing/pricing') return this.handleBillingPricing();
    if (m === 'GET' && pathname === '/v1/billing/usage') return this.handleBillingUsage(tenantFromHeaders(headers), numParam(query.get('limit')));
    if (m === 'GET' && pathname === '/v1/billing/estimate') return this.handleBillingEstimate(tenantFromHeaders(headers), query, body);
    if (m === 'POST' && pathname === '/v1/billing/allowance') return this.handleBillingAllowance(tenantFromHeaders(headers), body);
    if (m === 'POST' && pathname === '/v1/billing/checkout') return this.handleBillingCheckout(tenantFromHeaders(headers), body);
    if (m === 'GET' && pathname === '/v1/billing/checkout') return this.handleBillingCheckoutGet(query.get('session_id'));
    if (m === 'POST' && pathname === '/v1/billing/checkout/settle') return this.handleBillingCheckoutSettle(body);
    // --- Auth. Public/auth-exempt (they ARE the auth system); signup/login rate-limited tighter.
    if (m === 'POST' && pathname === '/v1/auth/signup') return this.handleAuthSignup(body);
    if (m === 'POST' && pathname === '/v1/auth/login') return this.handleAuthLogin(body);
    if (m === 'POST' && pathname === '/v1/auth/logout') return this.handleAuthLogout(body, headers);
    if (m === 'GET' && pathname === '/v1/auth/me') return this.handleAuthMe(headers);
    // --- Launch GTM waitlist. POST is public (auth-exempt, rate-limited); stats is protected.
    if (m === 'POST' && pathname === '/v1/waitlist') return this.handleWaitlistSignup(body, ipFromHeaders(headers));
    if (m === 'GET' && pathname === '/v1/waitlist/stats') return this.handleWaitlistStats();
    // --- Companion chat. Public (auth-exempt, rate-limited) — the web client has no API key.
    if (m === 'POST' && pathname === '/v1/companion/chat') return await this.handleCompanionChat(body);
    // --- Companion portrait. Same public posture as chat.
    if (m === 'POST' && pathname === '/v1/companion/portrait') return await this.handlePortraitRequest(body);
    // --- Companion scene/loop. Same public posture as chat and portrait.
    if (m === 'POST' && pathname === '/v1/companion/scene') return await this.handleSceneRequest(body);
    // --- Companion memory. Read-only; same public posture as chat/portrait/scene.
    if (m === 'GET' && pathname === '/v1/companion/memory') return this.handleCompanionMemoryGet(query.get('companionId'));
    return { status: 404, body: { error: `no route for ${m} ${pathname}` } };
  }

  /** Build a node:http server bound to this gateway's routes (no framework). */
  createServer(): http.Server {
    return http.createServer((req, res) => {
      void this.serve(req, res);
    });
  }

  /** Start listening. Resolves once bound. */
  listen(port: number, host = '0.0.0.0'): Promise<http.Server> {
    const server = this.createServer();
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve(server));
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

      // POST /v1/companion/chat/stream is the ONE route that bypasses the buffered
      // GatewayResponse path below: it streams SSE frames directly to `res` as they're produced
      // instead of computing a single { status, body } and writing it once. Carved out here,
      // BEFORE the generic route() dispatch, so every other route's request handling — including
      // the existing (buffered) POST /v1/companion/chat — is completely untouched.
      if (method.toUpperCase() === 'POST' && url.pathname === COMPANION_CHAT_STREAM_PATH) {
        const streamBody = await readJsonBody(req);
        const status = await this.serveCompanionChatStream(streamBody, res, guard.headers);
        log(status);
        return;
      }

      // Body is read for writes, and for GET /v1/billing/estimate which accepts a JSON body
      // (with query params as an equivalent fallback for GET-body-averse clients).
      const wantsBody =
        method === 'POST' || method === 'PUT' || (method === 'GET' && url.pathname === '/v1/billing/estimate');
      const body = wantsBody ? await readJsonBody(req) : undefined;
      const result = await this.route(method, url.pathname, url.searchParams, body, req.headers);
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

/** Narrow an unknown value to a valid AgentRole, or undefined. */
function parseRole(value: unknown): AgentRole | undefined {
  if (typeof value !== 'string') return undefined;
  return (Object.values(AgentRole) as string[]).includes(value) ? (value as AgentRole) : undefined;
}

/** Narrow an unknown value to a PacketPriority, or undefined (STANDARD is applied downstream). */
function parsePriority(value: unknown): 'CRITICAL' | 'STANDARD' | 'BACKGROUND' | undefined {
  return value === 'CRITICAL' || value === 'STANDARD' || value === 'BACKGROUND' ? value : undefined;
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

/** Sentinel distinguishing "invalid value" from "absent" in optional numeric parsing. */
const INVALID = Symbol('invalid');

/**
 * Parse an optional non-negative number from an unknown value. Returns `undefined` when the
 * field is absent, the INVALID sentinel when present but not a valid non-negative number, and
 * the number otherwise.
 */
function optionalNonNegative(value: unknown): number | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return INVALID;
  return n;
}

/** First finite number among (body value, query-derived number). */
function firstNumber(bodyValue: unknown, queryValue: number | undefined): number | undefined {
  if (typeof bodyValue === 'number' && Number.isFinite(bodyValue)) return bodyValue;
  if (typeof bodyValue === 'string') {
    const n = Number(bodyValue);
    if (Number.isFinite(n)) return n;
  }
  return queryValue;
}

/** First non-empty string among (body value, query value). */
function firstString(bodyValue: unknown, queryValue: string | null): string | undefined {
  if (typeof bodyValue === 'string' && bodyValue.trim().length > 0) return bodyValue.trim();
  if (queryValue !== null && queryValue.trim().length > 0) return queryValue.trim();
  return undefined;
}

/** Best-effort client IP from request headers (x-forwarded-for), for waitlist abuse triage. */
function ipFromHeaders(headers?: Record<string, string | string[] | undefined>): string | undefined {
  if (!headers) return undefined;
  const ip = clientIp(headers, undefined);
  return ip === 'unknown' ? undefined : ip;
}

/** Pull { email, password } string fields out of a JSON body; undefined if absent/wrong type. */
function extractCredentials(body: unknown): { email: string | undefined; password: string | undefined } {
  if (body === null || typeof body !== 'object') return { email: undefined, password: undefined };
  const b = body as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email : undefined;
  const password = typeof b.password === 'string' ? b.password : undefined;
  return { email, password };
}

/** Map a thrown AuthError to its HTTP status; any other error is a 400 (defensive fallback). */
function authErrorResponse(err: unknown): GatewayResponse {
  if (err instanceof AuthError) {
    const status = err.code === 'duplicate_email' ? 409 : err.code === 'invalid_credentials' ? 401 : 400;
    return { status, body: { error: err.message } };
  }
  return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
}

/** Session bearer token from the X-HDV-Session header (preferred), or a JSON body { sessionToken }. */
function sessionTokenFromRequest(
  headers: Record<string, string | string[] | undefined> | undefined,
  body: unknown,
): string | undefined {
  if (headers) {
    const raw = headers['x-hdv-session'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = value?.trim();
    if (trimmed && trimmed.length > 0) return trimmed;
  }
  if (body !== null && typeof body === 'object' && 'sessionToken' in (body as Record<string, unknown>)) {
    const t = (body as { sessionToken?: unknown }).sessionToken;
    if (typeof t === 'string' && t.trim().length > 0) return t.trim();
  }
  return undefined;
}

/** Resolve the billing tenant from the X-HDV-Tenant header (default "demo"). */
function tenantFromHeaders(headers?: Record<string, string | string[] | undefined>): string {
  if (!headers) return 'demo';
  const raw = headers['x-hdv-tenant'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'demo';
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
