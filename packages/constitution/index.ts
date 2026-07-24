/**
 * @big5-matrix/constitution — the PUBLIC, publishable constitution surface (open-core kit).
 *
 * This is the small, dependency-free "law book" of the Big 5 Matrix: the RoutingPacket
 * contract, the AgentRole vocabulary, the KNOLL law names, the ledger field list, and the
 * always-on / ephemeral lifecycle map. It is the seam along which the project is split into
 * an OPEN CORE (this constitution + the contracts every integrator must honor) and the
 * proprietary engine (the actual routers, workers, scorers, and node fleet).
 *
 * IMPORTANT (open-core boundary): this module RE-EXPORTS from `config/` rather than forking
 * it, so the published kit can never drift from what the running app enforces. The in-repo
 * app keeps importing `config/routing_schema.js` directly; nothing here changes app behavior.
 * When this directory is published as a standalone npm package, the two source-of-truth files
 * (`config/routing_schema.ts` and the law-name list) are vendored in at pack time — see
 * `README.md` §"Publishing".
 *
 * It intentionally contains NO agent internals: no router, no KNOLL engine, no node fleet.
 * A third party can depend on this to build a compliant client without ever touching — or
 * being able to weaken — the six hard laws.
 */

// ---------------------------------------------------------------------------
// 1. The RoutingPacket contract + role vocabulary (re-exported, single source of truth).
// ---------------------------------------------------------------------------
export {
  AgentRole,
} from '../../config/routing_schema.js';
export type {
  RoutingPacket,
  KnollValidationResponse,
  PacketPriority,
  RoutingStatus,
} from '../../config/routing_schema.js';

import { AgentRole } from '../../config/routing_schema.js';

// ---------------------------------------------------------------------------
// 2. KNOLL law names — the public, stable identifiers KNOLL emits per verdict.
// ---------------------------------------------------------------------------

/**
 * The hard "virtual laws" KNOLL applies to every packet, in order, plus the two
 * structural guards that run before them. These strings are the STABLE public contract —
 * they appear verbatim in `KnollValidationResponse.enforcedConstraints`. Integrators may
 * key dashboards, alerts, and tests off these names.
 *
 * Kept in sync with `knoll/laws.ts` by `tests/eval.test.ts`, which runs each real law and
 * asserts the emitted `.law` string matches this list. If a law is renamed, that test fails
 * until this constant is updated — the kit cannot silently drift from the engine.
 */
export const KNOLL_LAW_NAMES = [
  'TOKEN_WELL_FORMED', // LAW 1 — knoll_token is present and structurally well-formed
  'VALID_ENDPOINTS', // LAW 2 — source/destination are distinct, valid roles
  'NO_DIRECT_DREAM_VISION', // LAW 3 — DREAM and VISION never talk directly, either way
  'NO_KNOLL_FORGERY', // LAW 4 — no agent may forge KNOLL as a packet source
  'HOPE_CANNOT_COMMAND', // LAW 5 — HOPE routes intent via APEX; never commands DREAM/VISION
  'NO_MALICIOUS_INTENT', // LAW 6 — malicious-intent heuristic over intent + payload strings
  'NO_CROSS_TENANT', // LAW 7 — packets may not cross a tenant boundary (Phase 8 isolation)
] as const;

export type KnollLawName = (typeof KNOLL_LAW_NAMES)[number];

/**
 * Structural / cross-cutting guards KNOLL enforces AROUND the six laws (see
 * `knoll/validator.ts`). These are also valid `enforcedConstraints` values.
 */
export const KNOLL_GUARD_NAMES = [
  'STRUCTURE', // packet is not a strict RoutingPacket → refused before the laws
  'HASH_INTEGRITY', // SHA-256 over (header + payload) does not match → tampered
  'RATE_LIMIT', // per-source rate window exceeded
  'BEHAVIORAL_SCORE', // additive anomaly gate; can deny more, never allow past a hard law
] as const;

export type KnollGuardName = (typeof KNOLL_GUARD_NAMES)[number];

// ---------------------------------------------------------------------------
// 3. Ledger field list — the shape of every billed/audited row.
// ---------------------------------------------------------------------------

/**
 * Field list of one APEX ledger row (a `RequestLog`, see `config/schema.prisma` and
 * `apex/ledger.ts`). Every packet APEX attempts to route produces exactly one such row:
 * SUCCESS, BLOCKED, or FAILED — with a `cost_usd` and the KNOLL signature. This is the
 * open, auditable accounting contract.
 */
export const LEDGER_FIELDS = [
  'id',
  'packetId',
  'timestamp',
  'source',
  'destination',
  'status', // 'SUCCESS' | 'BLOCKED' | 'FAILED'
  'cost_usd',
  'knollSignature',
] as const;

export type LedgerField = (typeof LEDGER_FIELDS)[number];

// ---------------------------------------------------------------------------
// 4. Lifecycle map — the "infinite scale" shape: always-on trio tiny, workers to zero.
// ---------------------------------------------------------------------------

/** How an agent is scheduled. ALWAYS_ON agents are the tiny resident core; EPHEMERAL
 * agents are spawned on demand and torn down to zero, so idle cost trends to zero. */
export type AgentLifecycle = 'ALWAYS_ON' | 'EPHEMERAL';

/**
 * The lifecycle of each Big 5 agent. The three ALWAYS_ON agents (HOPE, KNOLL, APEX) are the
 * only permanently-resident processes — cheap and small. DREAM and VISION (and their entire
 * node matrix) are EPHEMERAL: they materialize per claim and scale back to zero, which is
 * what lets the conceptual 20,480-node / ~14.3-quadrillion-parameter fleet stay idle-cheap.
 */
export const AGENT_LIFECYCLE: Readonly<Record<AgentRole, AgentLifecycle>> = {
  [AgentRole.HOPE]: 'ALWAYS_ON',
  [AgentRole.KNOLL]: 'ALWAYS_ON',
  [AgentRole.APEX]: 'ALWAYS_ON',
  [AgentRole.DREAM]: 'EPHEMERAL',
  [AgentRole.VISION]: 'EPHEMERAL',
};

/** The tiny resident core that is always paid for. */
export const ALWAYS_ON_ROLES: readonly AgentRole[] = [AgentRole.HOPE, AgentRole.KNOLL, AgentRole.APEX];

/** The workers that scale to zero when idle. */
export const EPHEMERAL_ROLES: readonly AgentRole[] = [AgentRole.DREAM, AgentRole.VISION];

/** Pairs that may NEVER appear as (source, destination) — DREAM and VISION are isolated. */
export const ILLEGAL_DIRECT_PAIRS: ReadonlyArray<readonly [AgentRole, AgentRole]> = [
  [AgentRole.DREAM, AgentRole.VISION],
  [AgentRole.VISION, AgentRole.DREAM],
];

/** Version of the constitution surface (independent of the app version). */
export const CONSTITUTION_VERSION = '0.1.0';
