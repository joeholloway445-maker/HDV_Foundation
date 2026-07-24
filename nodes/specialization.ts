/**
 * nodes/specialization.ts — persona specialization & the SpecialtyRouter (Phase 7).
 *
 * A "mixture-of-personas" seam: a single Big AI (e.g. DREAM or VISION) spawns ephemeral
 * personas that specialize — a researcher gathers, a writer drafts, a critic reviews, a coder
 * implements, an analyst measures, a guardian self-checks. Given a task, the `SpecialtyRouter`
 * ranks these specialties by keyword affinity and picks the specialist(s) best suited to it.
 *
 * Constitutional guardrails (this module changes NO routing rule):
 *   - It only ever picks personas UNDER ONE Big AI owner. It never selects a cross-agent
 *     destination and never mints or sends a RoutingPacket — inter-agent traffic still flows
 *     SOURCE → APEX → KNOLL → DEST. This is intra-owner persona selection only.
 *   - The `guardian` specialty is a persona-level SELF-review role for the owner's own output.
 *     It is NOT a governance power: KNOLL remains the one and only master auditor.
 */
import { AgentRole } from '../config/routing_schema.js';

/** The six persona specialties a Big AI's node matrix can spawn. */
export type PersonaSpecialty =
  | 'researcher'
  | 'writer'
  | 'critic'
  | 'coder'
  | 'analyst'
  | 'guardian';

export const PERSONA_SPECIALTIES: readonly PersonaSpecialty[] = [
  'researcher',
  'writer',
  'critic',
  'coder',
  'analyst',
  'guardian',
];

export interface PersonaSpecialization {
  specialty: PersonaSpecialty;
  /** One-line description of the specialist's single job. */
  description: string;
  /** Lowercase keyword/stem affinities used to score a task. */
  keywords: readonly string[];
  /** Tie-break weight (higher wins on equal keyword affinity). 0..1. */
  weight: number;
}

/**
 * The specialty roster. Keywords are deliberately broad stems; the router matches them
 * case-insensitively as substrings of the task text, so "researching" hits "research".
 */
export const SPECIALIZATIONS: Record<PersonaSpecialty, PersonaSpecialization> = {
  researcher: {
    specialty: 'researcher',
    description: 'Gathers, searches, and synthesizes source material for a task.',
    keywords: ['research', 'find', 'search', 'gather', 'investigate', 'explore', 'discover', 'survey', 'source', 'reference'],
    weight: 0.5,
  },
  writer: {
    specialty: 'writer',
    description: 'Drafts, summarizes, and documents prose and reports.',
    keywords: ['write', 'draft', 'summar', 'document', 'compose', 'narrat', 'describe', 'explain', 'report', 'article'],
    weight: 0.5,
  },
  critic: {
    specialty: 'critic',
    description: 'Reviews, critiques, and stress-tests proposals and outputs.',
    keywords: ['review', 'critique', 'evaluate', 'assess', 'judge', 'compare', 'improve', 'refine', 'feedback', 'weakness'],
    weight: 0.5,
  },
  coder: {
    specialty: 'coder',
    description: 'Implements, refactors, and debugs code and scripts.',
    keywords: ['code', 'implement', 'build', 'refactor', 'debug', 'function', 'script', 'compile', 'program', 'api'],
    weight: 0.6,
  },
  analyst: {
    specialty: 'analyst',
    description: 'Measures, models, and reasons over data and metrics.',
    keywords: ['analy', 'data', 'metric', 'measure', 'statistic', 'forecast', 'model', 'calculate', 'quantif', 'chart'],
    weight: 0.5,
  },
  guardian: {
    specialty: 'guardian',
    description: 'Self-checks the owner\u2019s own output for safety and policy (not governance).',
    keywords: ['verify', 'validate', 'check', 'audit', 'safe', 'secur', 'policy', 'comply', 'risk', 'sanitize'],
    weight: 0.4,
  },
};

/** A scored specialty candidate for a task. */
export interface SpecialtyMatch {
  specialty: PersonaSpecialty;
  /** Affinity 0..1 for the task (keyword coverage + tie-break weight). */
  score: number;
  /** The keyword stems that matched the task text. */
  matchedKeywords: string[];
}

/** The router's decision: a primary specialist and a ranked support cast, all under one owner. */
export interface SpecialtyAssignment {
  /** The single Big AI these specialists all run under. */
  owner: AgentRole;
  task: string;
  primary: SpecialtyMatch;
  /** Ranked specialists (includes the primary first) above the inclusion threshold. */
  specialists: SpecialtyMatch[];
}

export interface SpecialtyRouterOptions {
  /** Restrict routing to a subset of specialties (an owner's allowed roster). Defaults to all six. */
  roster?: readonly PersonaSpecialty[];
  /** Minimum score for a NON-primary specialist to be included. Default 0.1. */
  minScore?: number;
  /** Max specialists returned (including the primary). Default 3. */
  maxSpecialists?: number;
}

/**
 * SpecialtyRouter — picks the best persona specialist(s) for a task, all under ONE Big AI.
 *
 * The owner is fixed at construction so the router can never fan a task across agents; it only
 * chooses which of the owner's own specialized personas to spawn. Selection is deterministic:
 * the same task always yields the same ranking.
 */
export class SpecialtyRouter {
  readonly owner: AgentRole;
  private readonly roster: readonly PersonaSpecialty[];
  private readonly minScore: number;
  private readonly maxSpecialists: number;

  constructor(owner: AgentRole, options: SpecialtyRouterOptions = {}) {
    this.owner = owner;
    const roster = options.roster ?? PERSONA_SPECIALTIES;
    if (roster.length === 0) throw new Error('SpecialtyRouter: roster must not be empty');
    this.roster = roster;
    this.minScore = options.minScore ?? 0.1;
    this.maxSpecialists = Math.max(1, options.maxSpecialists ?? 3);
  }

  /** Rank every rostered specialty by affinity for the task (highest first). */
  rank(task: string): SpecialtyMatch[] {
    const text = task.toLowerCase();
    return this.roster
      .map((specialty) => scoreSpecialty(specialty, text))
      .sort((a, b) => b.score - a.score || cmp(a.specialty, b.specialty));
  }

  /**
   * Route a task to specialists under this owner. Always returns at least a primary (the
   * top-ranked specialty, even on a weak match — a Big AI must field *someone*). Additional
   * specialists are included only when they clear `minScore`, up to `maxSpecialists`.
   */
  route(task: string): SpecialtyAssignment {
    if (typeof task !== 'string' || task.trim().length === 0) {
      throw new Error('SpecialtyRouter.route: task must be a non-empty string');
    }
    const ranked = this.rank(task);
    const primary = ranked[0];
    const specialists = [primary, ...ranked.slice(1).filter((m) => m.score >= this.minScore)].slice(
      0,
      this.maxSpecialists,
    );
    return { owner: this.owner, task, primary, specialists };
  }
}

function scoreSpecialty(specialty: PersonaSpecialty, loweredTask: string): SpecialtyMatch {
  const spec = SPECIALIZATIONS[specialty];
  const matchedKeywords: string[] = [];
  for (const kw of spec.keywords) {
    if (loweredTask.includes(kw)) matchedKeywords.push(kw);
  }
  // Coverage: fraction of this specialty's keywords present, saturating quickly (3 hits ≈ full).
  const coverage = Math.min(1, matchedKeywords.length / 3);
  // Blend coverage with the tie-break weight so a total miss still orders sensibly.
  const score = round4(coverage === 0 ? 0 : 0.85 * coverage + 0.15 * spec.weight);
  return { specialty, score, matchedKeywords };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}
