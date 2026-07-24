/**
 * knoll/laws.ts — the hard-coded "virtual laws" KNOLL enforces on every packet.
 *
 * Each law is a pure function returning a verdict. KNOLL runs them in order and blocks
 * on the first failure. Laws never mutate the packet — they only allow or deny.
 */
import { AgentRole, type RoutingPacket } from '../config/routing_schema.js';
import { isWellFormedKnollToken } from '../config/hash.js';
import {
  FORBIDDEN,
  ROLE_DUTY,
  isPrimaryTriadRole,
  dutyForIntentKind,
  asDutyClass,
  type DutyClass,
} from '../config/duty.js';

export interface LawVerdict {
  passed: boolean;
  law: string;
  reasoning?: string;
}

/**
 * Optional runtime context KNOLL passes to laws that need to know something about the
 * *caller* beyond the packet bytes. Today only NO_CROSS_TENANT uses it (the authenticated
 * tenant of the source). Additive: laws that ignore it keep their `(packet) => LawVerdict`
 * shape, and callers that omit it fall back to dev-mode (single-tenant) behavior.
 */
export interface KnollLawContext {
  /** The tenant KNOLL believes the packet's SOURCE is authenticated as, if any. */
  sourceTenantId?: string;
}

/** A virtual law: a pure verdict over a packet plus optional runtime context. */
export type KnollLaw = (packet: RoutingPacket, context?: KnollLawContext) => LawVerdict;

/** Directed pairs that may NEVER appear as (source, destination). */
const ILLEGAL_DIRECT_PAIRS: ReadonlyArray<readonly [AgentRole, AgentRole]> = [
  [AgentRole.DREAM, AgentRole.VISION],
  [AgentRole.VISION, AgentRole.DREAM],
];

/** Simple heuristic keywords/patterns that indicate malicious intent. */
const MALICIOUS_PATTERNS: readonly RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bdrop\s+table\b/i,
  /\bdelete\s+from\b/i,
  /;\s*shutdown\b/i,
  /\bexfiltrate\b/i,
  /\bsteal\s+(?:credentials|secrets|tokens|passwords)\b/i,
  /\b(?:disable|bypass|kill)\s+knoll\b/i,
  /\bfork\s*bomb\b/i,
  /:\(\)\s*\{.*\}\s*;\s*:/, // classic bash fork bomb signature
];

/** LAW 1 — the token must be structurally well-formed. */
export function lawTokenWellFormed(packet: RoutingPacket): LawVerdict {
  const ok = isWellFormedKnollToken(packet.security.knoll_token);
  return {
    passed: ok,
    law: 'TOKEN_WELL_FORMED',
    reasoning: ok ? undefined : 'knoll_token missing or malformed',
  };
}

/** LAW 2 — source and destination must be distinct, valid roles. */
export function lawValidEndpoints(packet: RoutingPacket): LawVerdict {
  const { source, destination } = packet.header;
  const roles = Object.values(AgentRole);
  if (!roles.includes(source) || !roles.includes(destination)) {
    return { passed: false, law: 'VALID_ENDPOINTS', reasoning: 'unknown source or destination role' };
  }
  if (source === destination) {
    return {
      passed: false,
      law: 'VALID_ENDPOINTS',
      reasoning: `self-addressed packet (${source} -> ${destination}) is illegal`,
    };
  }
  return { passed: true, law: 'VALID_ENDPOINTS' };
}

/**
 * LAW 3 — DREAM and VISION must never communicate directly, in either direction.
 * They are the simulation and action layers and are strictly isolated from each other.
 */
export function lawNoDirectDreamVision(packet: RoutingPacket): LawVerdict {
  const { source, destination } = packet.header;
  for (const [a, b] of ILLEGAL_DIRECT_PAIRS) {
    if (source === a && destination === b) {
      return {
        passed: false,
        law: 'NO_DIRECT_DREAM_VISION',
        reasoning: `direct ${a} -> ${b} traffic is forbidden; must be mediated by APEX`,
      };
    }
  }
  return { passed: true, law: 'NO_DIRECT_DREAM_VISION' };
}

/**
 * LAW 4 — no agent may forge the KNOLL identity as a packet source. Only genuine
 * security-layer traffic may claim KNOLL, and in Phase 1 KNOLL never originates
 * business packets, so a KNOLL source is treated as a forgery attempt.
 */
export function lawNoKnollForgery(packet: RoutingPacket): LawVerdict {
  if (packet.header.source === AgentRole.KNOLL) {
    return {
      passed: false,
      law: 'NO_KNOLL_FORGERY',
      reasoning: 'KNOLL is monitor-only and never originates packets; source=KNOLL is a forgery',
    };
  }
  return { passed: true, law: 'NO_KNOLL_FORGERY' };
}

/**
 * LAW 5 — HOPE is the GOVERNANCE voice (rule-making, policy, system direction) and cannot
 * execute or create. Authority flows downward via APEX, never by HOPE reaching around it:
 * HOPE may not directly target VISION (execution) or DREAM (creation); it hands structured
 * intent to APEX, which decides routing. (Duty separation itself is LAW 8 PRIMARY_TRIAD_DUTY.)
 */
export function lawHopeCannotCommand(packet: RoutingPacket): LawVerdict {
  const { source, destination } = packet.header;
  if (source === AgentRole.HOPE && (destination === AgentRole.VISION || destination === AgentRole.DREAM)) {
    return {
      passed: false,
      law: 'HOPE_CANNOT_COMMAND',
      reasoning: `HOPE cannot directly target ${destination}; HOPE routes intent through APEX only`,
    };
  }
  return { passed: true, law: 'HOPE_CANNOT_COMMAND' };
}

/** LAW 6 — malicious-intent detection over the packet intent + string payload values. */
export function lawNoMaliciousIntent(packet: RoutingPacket): LawVerdict {
  const haystack = [packet.payload.intent, ...collectStrings(packet.payload.data)].join(' \n ');
  for (const pattern of MALICIOUS_PATTERNS) {
    if (pattern.test(haystack)) {
      return {
        passed: false,
        law: 'NO_MALICIOUS_INTENT',
        reasoning: `blocked by malicious-intent heuristic: ${pattern}`,
      };
    }
  }
  return { passed: true, law: 'NO_MALICIOUS_INTENT' };
}

/**
 * LAW 7 — NO_CROSS_TENANT (Phase 8 multi-tenancy isolation).
 *
 * A packet may never cross a tenant boundary. If KNOLL knows the authenticated tenant of the
 * source (context.sourceTenantId) AND the packet carries a header.tenantId, the two MUST match
 * or the packet is denied. When either side is absent the system is treated as single-tenant /
 * dev mode and the law passes — this is what keeps legacy Phase 1 (tenant-less) packets legal.
 */
export function lawNoCrossTenant(packet: RoutingPacket, context?: KnollLawContext): LawVerdict {
  const packetTenant = packet.header.tenantId;
  const sourceTenant = context?.sourceTenantId;
  // Dev mode: no tenant on the packet or no known source tenant → nothing to isolate.
  if (!packetTenant || !sourceTenant) {
    return { passed: true, law: 'NO_CROSS_TENANT' };
  }
  if (packetTenant !== sourceTenant) {
    return {
      passed: false,
      law: 'NO_CROSS_TENANT',
      reasoning: `cross-tenant traffic denied: source tenant "${sourceTenant}" may not address packet tenant "${packetTenant}"`,
    };
  }
  return { passed: true, law: 'NO_CROSS_TENANT' };
}

/**
 * LAW 8 — PRIMARY_TRIAD_DUTY. Absolute separation of duty across the Primary Triad.
 *
 * Authority flows downward Hope -> Vision -> Dream; each triad role owns exactly ONE duty at
 * 100% and is FORBIDDEN the other two:
 *   HOPE   = GOVERNANCE  (cannot execute, cannot create)
 *   VISION = EXECUTION   (cannot govern,  cannot create)
 *   DREAM  = CREATION    (cannot govern,  cannot execute)
 *
 * A packet declares the duty it asks the DESTINATION to perform via `payload.data.duty`
 * (explicit `DutyClass`) or `payload.data.kind` (a HOPE `IntentKind`). If that requested duty
 * is forbidden for the destination triad role, the packet is a duty violation and is blocked
 * (e.g. asking HOPE to execute/create, VISION to govern/create, DREAM to govern/execute).
 *
 * ADDITIVE / backward-compatible: packets that declare no duty, or address APEX/KNOLL (outside
 * the triad), pass — mirroring how NO_CROSS_TENANT treats tenant-less packets as dev mode. This
 * law never mutates the packet; like every KNOLL law it only allows or denies.
 */
export function lawPrimaryTriadDuty(packet: RoutingPacket): LawVerdict {
  const dest = packet.header.destination;
  if (!isPrimaryTriadRole(dest)) {
    return { passed: true, law: 'PRIMARY_TRIAD_DUTY' };
  }
  const requested = requestedDuty(packet);
  if (!requested) {
    return { passed: true, law: 'PRIMARY_TRIAD_DUTY' };
  }
  if (FORBIDDEN[dest].includes(requested)) {
    return {
      passed: false,
      law: 'PRIMARY_TRIAD_DUTY',
      reasoning: `duty violation: ${dest} is 100% ${ROLE_DUTY[dest]} and is forbidden ${requested} (authority flows Hope -> Vision -> Dream)`,
    };
  }
  return { passed: true, law: 'PRIMARY_TRIAD_DUTY' };
}

/** The duty a packet asks its destination to perform: explicit `data.duty` wins, else `data.kind`. */
function requestedDuty(packet: RoutingPacket): DutyClass | undefined {
  const data = packet.payload.data as Record<string, unknown>;
  return (
    asDutyClass(data.duty) ??
    asDutyClass(data.requestedDuty) ??
    dutyForIntentKind(typeof data.kind === 'string' ? data.kind : undefined)
  );
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  }
  return [];
}

/** The ordered law set KNOLL applies to structural/relational validation. */
export const VIRTUAL_LAWS: ReadonlyArray<KnollLaw> = [
  lawTokenWellFormed,
  lawValidEndpoints,
  lawNoDirectDreamVision,
  lawNoKnollForgery,
  lawHopeCannotCommand,
  lawNoMaliciousIntent,
  lawNoCrossTenant,
  lawPrimaryTriadDuty,
];
