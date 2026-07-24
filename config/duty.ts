/**
 * config/duty.ts — the Primary Triad duty vocabulary (audited HDV constitution).
 *
 * AUTHORITATIVE LAW (Primary Triad, absolute separation of duty):
 *   Authority flows DOWNWARD  Hope -> Vision -> Dream.  Memory returns UPWARD to Hope.
 *
 *   HOPE   = 100% GOVERNANCE  (rule-making, policy, system direction).  CANNOT execute. CANNOT create.
 *   VISION = 100% EXECUTION   (pipelines, processing, delivery).        CANNOT govern.  CANNOT create.
 *   DREAM  = 100% CREATION    (generative / UI / content).              CANNOT govern.  CANNOT execute.
 *
 * KNOLL (independent foundational entity — active routing + enforcement) and APEX (orchestration
 * layer among the Big Five) sit OUTSIDE the triad and are not duty-bound by this vocabulary.
 *
 * This file is dependency-free (like routing_schema.ts) so every layer can import it without
 * cross-agent coupling. The public constitution kit (packages/constitution) RE-EXPORTS this
 * file, so the published law book can never drift from what the engine enforces.
 */
import { AgentRole } from './routing_schema.js';

/** The three duties. In the Primary Triad each role owns exactly one, at 100%. */
export type DutyClass = 'GOVERNANCE' | 'EXECUTION' | 'CREATION';

/** All duty classes, as a stable list. */
export const DUTY_CLASSES: readonly DutyClass[] = ['GOVERNANCE', 'EXECUTION', 'CREATION'];

/**
 * The Primary Triad — the three roles under ABSOLUTE separation of duty. Ordered by the
 * downward authority flow: Hope (governance) -> Vision (execution) -> Dream (creation).
 */
export const PRIMARY_TRIAD = [AgentRole.HOPE, AgentRole.VISION, AgentRole.DREAM] as const;
export type PrimaryTriadRole = (typeof PRIMARY_TRIAD)[number];

/**
 * The directional spine of the constitution. Authority flows DOWNWARD Hope -> Vision -> Dream;
 * memory (results, learnings, audit) returns UPWARD to Hope, which governs on it.
 */
export const AUTHORITY_FLOW = {
  /** Downward chain of authority. */
  downward: [AgentRole.HOPE, AgentRole.VISION, AgentRole.DREAM] as const,
  /** Memory returns upward to this role. */
  memoryReturnsTo: AgentRole.HOPE,
} as const;

/** Each Primary Triad role owns exactly ONE duty — its 100% allotment. */
export const ROLE_DUTY: Readonly<Record<PrimaryTriadRole, DutyClass>> = {
  [AgentRole.HOPE]: 'GOVERNANCE',
  [AgentRole.VISION]: 'EXECUTION',
  [AgentRole.DREAM]: 'CREATION',
};

/**
 * Duty allocation per role: 100% to its own duty, 0% to the two it is forbidden. The absolute
 * separation is expressed as percentages so audits can assert "sums to 100, single non-zero".
 */
export const ROLE_DUTY_PERCENT: Readonly<Record<PrimaryTriadRole, Readonly<Record<DutyClass, number>>>> = {
  [AgentRole.HOPE]: { GOVERNANCE: 100, EXECUTION: 0, CREATION: 0 },
  [AgentRole.VISION]: { GOVERNANCE: 0, EXECUTION: 100, CREATION: 0 },
  [AgentRole.DREAM]: { GOVERNANCE: 0, EXECUTION: 0, CREATION: 100 },
};

/** The duties each Primary Triad role is FORBIDDEN from performing (its two 0% duties). */
export const FORBIDDEN: Readonly<Record<PrimaryTriadRole, readonly DutyClass[]>> = {
  [AgentRole.HOPE]: ['EXECUTION', 'CREATION'],
  [AgentRole.VISION]: ['GOVERNANCE', 'CREATION'],
  [AgentRole.DREAM]: ['GOVERNANCE', 'EXECUTION'],
};

/** True if `role` is one of the three Primary Triad roles (HOPE, VISION, DREAM). */
export function isPrimaryTriadRole(role: AgentRole): role is PrimaryTriadRole {
  return (PRIMARY_TRIAD as readonly AgentRole[]).includes(role);
}

/**
 * Map a HOPE `IntentKind` string to the duty it requests, when determinable.
 * Intent interpretation is itself a GOVERNANCE function, so QUERY/CLARIFY/DOCUMENT are governance.
 */
export function dutyForIntentKind(kind: string | undefined): DutyClass | undefined {
  switch (kind) {
    case 'EXECUTE':
      return 'EXECUTION';
    case 'SIMULATE':
      return 'CREATION';
    case 'QUERY':
    case 'CLARIFY':
    case 'DOCUMENT':
      return 'GOVERNANCE';
    default:
      return undefined;
  }
}

/** Normalize an arbitrary value into a DutyClass, or `undefined` if it is not one. */
export function asDutyClass(value: unknown): DutyClass | undefined {
  return value === 'GOVERNANCE' || value === 'EXECUTION' || value === 'CREATION' ? value : undefined;
}
