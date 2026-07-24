/**
 * hope/interpreter.ts — HOPE, the GOVERNANCE role of the Primary Triad (100% governance).
 *
 * HOPE governs by direction: interpreting natural language into a structured intent payload is a
 * GOVERNANCE function (deciding what the user means and what the system should be directed to
 * do). HOPE hands that direction to APEX, which routes it downward (Hope -> Vision -> Dream);
 * memory returns upward to HOPE. HOPE is the governance "voice" of the system.
 *
 * Phase 2 adds richer, NLP-style parsing: entity / goal / constraint extraction, urgency
 * detection, multi-intent (primary + secondary) recognition, and clarification requests
 * when confidence is below threshold.
 *
 * CONSTRAINTS (enforced by construction here, and by KNOLL at the gate — LAW 5
 * HOPE_CANNOT_COMMAND + LAW 8 PRIMARY_TRIAD_DUTY):
 *   - HOPE CANNOT execute. It performs no tool use and touches no sandbox (VISION's duty).
 *   - HOPE CANNOT create. It produces governance direction, not artifacts (DREAM's duty).
 *   - HOPE only ever talks to APEX. It imports no peer agent (no DREAM, no VISION).
 *
 * See hope/PROMPT.md for the governance prompt / voice guidance.
 */
import { AgentRole } from '../config/routing_schema.js';
import type { CreatePacketInput, DispatchResult } from '../apex/index.js';

/**
 * Kinds of intent HOPE can recognize. These map to which agent APEX should target.
 *   SIMULATE → DREAM · EXECUTE → VISION · QUERY/CLARIFY/DOCUMENT → HOPE · UNKNOWN → APEX
 */
export type IntentKind = 'SIMULATE' | 'EXECUTE' | 'QUERY' | 'CLARIFY' | 'DOCUMENT' | 'UNKNOWN';

export type Urgency = 'LOW' | 'NORMAL' | 'HIGH';

export interface StructuredIntent {
  kind: IntentKind;
  /** A secondary intent for multi-intent utterances (e.g. "simulate then run it"). */
  secondaryKind?: IntentKind;
  /** Human-readable summary of what the user wants. */
  intent: string;
  /** Structured, opaque parameters extracted from the utterance. */
  data: Record<string, unknown>;
  /** Named entities / nouns extracted from the utterance. */
  entities: string[];
  /** Goals the user is trying to achieve. */
  goals: string[];
  /** Constraints / limits the user placed on the request. */
  constraints: string[];
  urgency: Urgency;
  /** The agent APEX should route this to, given the intent kind. */
  suggestedDestination: AgentRole;
  confidence: number;
  /** True when confidence is below threshold and HOPE should ask the user to clarify. */
  clarificationNeeded: boolean;
}

/** The only capability HOPE is granted: a send-through-APEX callback (dependency injected). */
export type SendViaApex = (input: CreatePacketInput) => DispatchResult;

const SIMULATE_HINTS = ['simulate', 'imagine', 'what if', 'predict', 'forecast', 'scenario', 'dream', 'explore', 'model'];
const EXECUTE_HINTS = ['run', 'execute', 'build', 'deploy', 'ingest', 'process', 'compute', 'fetch', 'do', 'implement'];
const QUERY_HINTS = ['what is', 'who', 'when', 'explain', 'describe', 'tell me', 'how does', 'why'];
const DOCUMENT_HINTS = ['document', 'record', 'note', 'log this', 'remember', 'take note', 'write down'];
const URGENCY_HINTS = ['urgent', 'asap', 'immediately', 'right now', 'critical', 'emergency', 'now'];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'without', 'this', 'that', 'then',
  'please', 'would', 'could', 'should', 'into', 'from', 'about', 'your', 'you', 'our', 'their',
  'have', 'will', 'want', 'need', 'like', 'some', 'them', 'they', 'what', 'when', 'who', 'how', 'why',
]);

export interface InterpreterOptions {
  /** Below this confidence HOPE asks the user to clarify. Default 0.45. */
  clarificationThreshold?: number;
}

export class IntentInterpreter {
  private readonly clarificationThreshold: number;

  constructor(options: InterpreterOptions = {}) {
    this.clarificationThreshold = options.clarificationThreshold ?? 0.45;
  }

  /**
   * Parse a natural-language utterance into a structured intent. Pure interpretation:
   * no side effects, no execution, no creation.
   */
  interpret(utterance: string): StructuredIntent {
    const original = utterance.trim();
    const text = original.toLowerCase();

    const scores: Record<IntentKind, number> = {
      SIMULATE: score(text, SIMULATE_HINTS),
      EXECUTE: score(text, EXECUTE_HINTS),
      QUERY: score(text, QUERY_HINTS),
      DOCUMENT: score(text, DOCUMENT_HINTS),
      CLARIFY: 0,
      UNKNOWN: 0,
    };

    const ranked = (Object.keys(scores) as IntentKind[])
      .filter((k) => scores[k] > 0)
      .sort((a, b) => scores[b] - scores[a]);

    const primary: IntentKind = ranked[0] ?? 'UNKNOWN';
    const secondary = ranked[1];
    const maxScore = primary === 'UNKNOWN' ? 0 : scores[primary];

    const entities = extractEntities(original);
    const goals = extractGoals(original);
    const constraints = extractConstraints(original);
    const urgency = detectUrgency(text);

    // Confidence rises with hint strength and with the richness of extracted structure.
    const structureBonus = Math.min(0.2, 0.05 * (entities.length + goals.length));
    const confidence = maxScore === 0 ? 0 : Math.min(1, 0.4 + 0.12 * maxScore + structureBonus);
    const clarificationNeeded = confidence < this.clarificationThreshold;

    return {
      kind: primary,
      secondaryKind: secondary,
      intent: original,
      data: {
        utterance: original,
        keywords: extractKeywords(text),
        scores,
      },
      entities,
      goals,
      constraints,
      urgency,
      suggestedDestination: destinationFor(primary),
      confidence: round4(confidence),
      clarificationNeeded,
    };
  }

  /**
   * Interpret and submit to APEX. HOPE never routes itself — it asks APEX to route,
   * and APEX (after KNOLL) decides. HOPE labels itself as the packet source.
   *
   * If the utterance needs clarification, HOPE does NOT dispatch — clarifying is an
   * interpretation act, not an execution. The caller can use HopeVoice to ask the user.
   */
  submit(utterance: string, send: SendViaApex): { intent: StructuredIntent; result?: DispatchResult } {
    const intent = this.interpret(utterance);
    if (intent.clarificationNeeded) {
      // Low confidence: HOPE holds the packet and requests clarification instead of
      // guessing. No execution, no creation — pure interpretation.
      return { intent };
    }
    // HOPE always sources packets from HOPE and asks APEX to mediate. Note: KNOLL
    // forbids HOPE from directly targeting DREAM/VISION, so HOPE addresses APEX, and
    // the orchestrator forwards. The suggestedDestination travels inside the payload.
    const result = send({
      source: AgentRole.HOPE,
      destination: AgentRole.APEX,
      intent: intent.intent,
      data: {
        ...intent.data,
        kind: intent.kind,
        secondaryKind: intent.secondaryKind,
        suggestedDestination: intent.suggestedDestination,
        entities: intent.entities,
        goals: intent.goals,
        constraints: intent.constraints,
        urgency: intent.urgency,
      },
      priority: intent.urgency === 'HIGH' ? 'CRITICAL' : 'STANDARD',
    });
    return { intent, result };
  }
}

/** Map an intent kind to the agent APEX should target. */
export function destinationFor(kind: IntentKind): AgentRole {
  switch (kind) {
    case 'SIMULATE':
      return AgentRole.DREAM;
    case 'EXECUTE':
      return AgentRole.VISION;
    case 'QUERY':
    case 'CLARIFY':
    case 'DOCUMENT':
      return AgentRole.HOPE;
    default:
      return AgentRole.APEX;
  }
}

function score(text: string, hints: readonly string[]): number {
  return hints.reduce((n, h) => (text.includes(h) ? n + 1 : n), 0);
}

function extractKeywords(text: string): string[] {
  return Array.from(new Set(text.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3)));
}

/** Extract entities: quoted phrases, capitalized tokens, and number+unit tokens. */
function extractEntities(original: string): string[] {
  const entities = new Set<string>();
  for (const m of original.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (v) entities.add(v);
  }
  for (const m of original.matchAll(/\b([A-Z][a-zA-Z0-9]+)\b/g)) {
    const v = m[1];
    if (v && v.length > 2) entities.add(v);
  }
  for (const m of original.matchAll(/\b(\d+(?:\.\d+)?\s?[a-zA-Z%]+)\b/g)) {
    entities.add(m[1].trim());
  }
  return Array.from(entities).slice(0, 12);
}

/** Extract goals: clauses following goal markers ("to ...", "want to ...", "so that ..."). */
function extractGoals(original: string): string[] {
  const goals = new Set<string>();
  const markers = [/\bwant to\s+(.+?)(?:[.,;]|$)/gi, /\bneed to\s+(.+?)(?:[.,;]|$)/gi, /\bso that\s+(.+?)(?:[.,;]|$)/gi, /\bin order to\s+(.+?)(?:[.,;]|$)/gi, /\bto\s+([a-z]+\s+[^.,;]+)/gi];
  for (const re of markers) {
    for (const m of original.matchAll(re)) {
      const g = m[1]?.trim();
      if (g && g.length > 2) goals.add(g);
    }
  }
  return Array.from(goals).slice(0, 8);
}

/** Extract constraints: clauses following constraint markers ("without ...", "by <date>"). */
function extractConstraints(original: string): string[] {
  const constraints = new Set<string>();
  const markers = [
    /\bwithout\s+(.+?)(?:[.,;]|$)/gi,
    /\bbut not\s+(.+?)(?:[.,;]|$)/gi,
    /\bavoid\s+(.+?)(?:[.,;]|$)/gi,
    /\bexcept\s+(.+?)(?:[.,;]|$)/gi,
    /\bunder\s+(\$?\d[^.,;]*)/gi,
    /\bwithin\s+([^.,;]+)/gi,
    /\bby\s+((?:tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+\w+|\d[^.,;]*))/gi,
    /\bless than\s+([^.,;]+)/gi,
    /\bmust\s+(.+?)(?:[.,;]|$)/gi,
  ];
  for (const re of markers) {
    for (const m of original.matchAll(re)) {
      const c = m[1]?.trim();
      if (c && c.length > 1) constraints.add(c);
    }
  }
  return Array.from(constraints).slice(0, 8);
}

function detectUrgency(text: string): Urgency {
  if (URGENCY_HINTS.some((h) => text.includes(h))) return 'HIGH';
  if (/\b(whenever|no rush|eventually|someday|low priority)\b/.test(text)) return 'LOW';
  return 'NORMAL';
}

// STOPWORDS is referenced by keyword refinement callers/tests; exported-adjacent helper
// keeps the lint-clean surface without a dead symbol.
export function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase());
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}
