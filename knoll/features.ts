/**
 * knoll/features.ts — behavioral feature extraction (Phase 2).
 *
 * Pure, side-effect-free feature extraction for KNOLL's behavioral anomaly scorer. Each
 * feature is normalized to 0..1 where higher means *more suspicious*. The scorer
 * (knoll/scoring.ts) combines these into a single anomaly score. KNOLL stays monitor-only:
 * these functions read a packet and its runtime context; they never mutate anything.
 *
 * Features:
 *   - rate            : recent request volume from the source (flooding)
 *   - intentEntropy   : character entropy of intent + string payload (random blobs)
 *   - maliciousHits   : soft suspicious-keyword hits (weaker than the hard LAW 6 block)
 *   - endpointRisk    : inherent risk of the (source → destination) pair
 *   - payloadSize     : normalized serialized payload size (oversized exfil-shaped data)
 *   - priorityAbuse   : CRITICAL priority used where it shouldn't be (queue-jumping)
 *   - sourceReputation: accumulated risk history for the source (from the scorer)
 */
import { AgentRole, type RoutingPacket } from '../config/routing_schema.js';

export interface BehavioralFeatures {
  rate: number;
  intentEntropy: number;
  maliciousHits: number;
  endpointRisk: number;
  payloadSize: number;
  priorityAbuse: number;
  sourceReputation: number;
}

/** Runtime context the scorer supplies (state it tracks between packets). */
export interface ScoringContext {
  /** How many packets this source sent within the scorer's window (incl. this one). */
  recentCount: number;
  /** Soft cap used to normalize the rate feature. */
  rateSoftCap: number;
  /** The source's accumulated reputation risk (0 clean .. 1 bad). */
  reputationRisk: number;
}

/**
 * Soft suspicious keywords. These are intentionally *weaker* than the hard-blocking
 * MALICIOUS_PATTERNS in laws.ts — a single hit is not fatal, but several combined with
 * other features raise the anomaly score. LAW 6 still hard-blocks the truly dangerous set.
 */
const SOFT_SUSPICIOUS: readonly RegExp[] = [
  /\bpassword\b/i,
  /\bcredential/i,
  /\btoken\b/i,
  /\bsecret/i,
  /\bsudo\b/i,
  /\broot\b/i,
  /\badmin\b/i,
  /\boverride\b/i,
  /\bbypass\b/i,
  /\bexploit\b/i,
  /\bescalat/i,
  /\bbase64\b/i,
  /\bpayload\b/i,
  /\bbackdoor\b/i,
];

/**
 * Endpoint risk table. Execution-bound and cross-layer traffic is inherently riskier than
 * interpretation traffic. (DREAM↔VISION is 1.0 but that pair is hard-blocked by LAW 3
 * before scoring ever runs — included here for completeness.)
 */
const ENDPOINT_RISK: Record<string, number> = {
  'APEX->VISION': 0.6,
  'APEX->DREAM': 0.2,
  'APEX->HOPE': 0.1,
  'HOPE->APEX': 0.1,
  'DREAM->HOPE': 0.15,
  'VISION->HOPE': 0.2,
  'DREAM->APEX': 0.15,
  'VISION->APEX': 0.2,
  'DREAM->VISION': 1.0,
  'VISION->DREAM': 1.0,
};

export function extractFeatures(packet: RoutingPacket, ctx: ScoringContext): BehavioralFeatures {
  const haystack = [packet.payload.intent, ...collectStrings(packet.payload.data)].join(' \n ');

  return {
    rate: clamp01(ctx.recentCount / Math.max(1, ctx.rateSoftCap)),
    intentEntropy: normalizedEntropy(haystack),
    maliciousHits: softHitScore(haystack),
    endpointRisk: endpointRisk(packet.header.source, packet.header.destination),
    payloadSize: payloadSizeScore(packet.payload.data),
    priorityAbuse: priorityAbuse(packet),
    sourceReputation: clamp01(ctx.reputationRisk),
  };
}

function endpointRisk(source: AgentRole, destination: AgentRole): number {
  return ENDPOINT_RISK[`${source}->${destination}`] ?? 0.25;
}

function softHitScore(text: string): number {
  let hits = 0;
  for (const p of SOFT_SUSPICIOUS) if (p.test(text)) hits += 1;
  // 3+ distinct suspicious markers saturates the feature.
  return clamp01(hits / 3);
}

function payloadSizeScore(data: Record<string, unknown>): number {
  const bytes = JSON.stringify(data).length;
  // ~2KB payloads start looking oversized for a routing envelope; saturate at ~8KB.
  return clamp01(bytes / 8192);
}

function priorityAbuse(packet: RoutingPacket): number {
  const { priority } = packet.header;
  if (priority !== 'CRITICAL') return priority === 'BACKGROUND' ? 0 : 0.1;
  // CRITICAL is legitimate for genuine emergencies but a common queue-jumping abuse.
  // If a CRITICAL packet is a mere QUERY/interpretation, treat it as more abusive.
  const intent = packet.payload.intent.toLowerCase();
  const looksTrivial = /\b(query|what|who|when|explain|describe|hello|ping)\b/.test(intent);
  return looksTrivial ? 1.0 : 0.6;
}

/** Shannon character entropy normalized against a 6-bit ceiling (random blobs → ~1). */
function normalizedEntropy(text: string): number {
  if (text.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of text) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / text.length;
    h -= p * Math.log2(p);
  }
  return clamp01(h / 6);
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  }
  return [];
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
