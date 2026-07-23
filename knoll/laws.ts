/**
 * knoll/laws.ts — the hard-coded "virtual laws" KNOLL enforces on every packet.
 *
 * Each law is a pure function returning a verdict. KNOLL runs them in order and blocks
 * on the first failure. Laws never mutate the packet — they only allow or deny.
 */
import { AgentRole, type RoutingPacket } from '../config/routing_schema.js';
import { isWellFormedKnollToken } from '../config/hash.js';

export interface LawVerdict {
  passed: boolean;
  law: string;
  reasoning?: string;
}

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
 * LAW 5 — HOPE is the interface/interpreter and cannot execute or create. It may not
 * directly target VISION (execution) or DREAM (creation/simulation); it must hand
 * structured intent to APEX, which decides routing.
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

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  }
  return [];
}

/** The ordered law set KNOLL applies to structural/relational validation. */
export const VIRTUAL_LAWS: ReadonlyArray<(packet: RoutingPacket) => LawVerdict> = [
  lawTokenWellFormed,
  lawValidEndpoints,
  lawNoDirectDreamVision,
  lawNoKnollForgery,
  lawHopeCannotCommand,
  lawNoMaliciousIntent,
];
