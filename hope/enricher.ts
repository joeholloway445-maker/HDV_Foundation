/**
 * hope/enricher.ts — OPTIONAL, dependency-injected LLM enrichment of HOPE's intent summary.
 *
 * HOPE's job is INTERPRETATION. Its heuristic interpreter (interpreter.ts) already classifies
 * an utterance into a StructuredIntent. This module can, WHEN and ONLY WHEN an LlmProvider is
 * explicitly injected, rewrite the human-readable `intent` summary into a crisper one-line
 * paraphrase — purely to improve the "voice". It changes NOTHING else about the intent:
 *   - It runs AFTER heuristic classification; it never re-classifies kind/destination.
 *   - It NEVER executes, creates, routes, or touches a peer agent — it only produces text.
 *   - If no provider is injected, or the provider fails/returns nothing, it FALLS BACK to the
 *     deterministic heuristic summary. HOPE therefore stays fully functional offline.
 *
 * This keeps the constitution intact: the provider is a pure text transducer supplied by DI;
 * HOPE remains interpretation-only and imports no peer agent.
 */
import type { StructuredIntent } from './interpreter.js';
import type { CompleteOptions, LlmProvider } from '../providers/types.js';

/** Where an enriched summary came from, for transparency in UIs, logs, and tests. */
export type SummarySource = 'heuristic' | 'llm';

export interface EnrichedSummary {
  /** The (possibly improved) one-line summary of what the user wants. */
  summary: string;
  /** Whether the summary came from the injected provider or the heuristic fallback. */
  source: SummarySource;
  /** The model that produced an LLM summary (absent for heuristic). */
  model?: string;
  /** Present when an injected provider failed and we fell back to heuristics. */
  error?: string;
}

export interface IntentEnricherOptions {
  /**
   * Optional LLM provider (dependency-injected). If omitted, the enricher is heuristic-only.
   * Providers are pure text transducers; they never execute or route.
   */
  provider?: LlmProvider;
  /** Max tokens for the summary completion. Kept small — this is a one-liner. Default 80. */
  maxTokens?: number;
  /** Temperature for the summary. Low by default for stable, reviewable text. Default 0.2. */
  temperature?: number;
  /** Max characters to keep from the model's summary. Default 240. */
  maxSummaryChars?: number;
}

const SYSTEM_PROMPT =
  'You are HOPE, an interpretation-only assistant. You NEVER execute, build, run, or create ' +
  'anything — you only restate intent. Given a classified user request, reply with ONE concise ' +
  'sentence (max 30 words) paraphrasing what the user wants. Do not add new actions, do not ' +
  'offer to do the task, and do not include preamble or quotes — output only the sentence.';

export class IntentEnricher {
  private readonly provider?: LlmProvider;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly maxSummaryChars: number;

  constructor(options: IntentEnricherOptions = {}) {
    this.provider = options.provider;
    this.maxTokens = options.maxTokens ?? 80;
    this.temperature = options.temperature ?? 0.2;
    this.maxSummaryChars = options.maxSummaryChars ?? 240;
  }

  /** Whether a provider is wired in. When false, enrichment is heuristic-only. */
  get canEnrich(): boolean {
    return this.provider !== undefined;
  }

  /**
   * Produce an improved one-line summary for an already-classified intent. Falls back to the
   * deterministic heuristic summary if there is no provider or the provider fails.
   */
  async enrich(intent: StructuredIntent): Promise<EnrichedSummary> {
    const fallback = heuristicSummary(intent);
    if (!this.provider) {
      return { summary: fallback, source: 'heuristic' };
    }

    const opts: CompleteOptions = {
      system: SYSTEM_PROMPT,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
    };

    try {
      const result = await this.provider.complete(buildPrompt(intent), opts);
      const cleaned = sanitize(result.text, this.maxSummaryChars);
      if (!cleaned) {
        return { summary: fallback, source: 'heuristic', error: 'provider returned empty text' };
      }
      return { summary: cleaned, source: 'llm', model: result.model };
    } catch (err) {
      return {
        summary: fallback,
        source: 'heuristic',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Return a shallow copy of the intent with its `intent` summary replaced by an enriched
   * (or heuristic-fallback) one. Only the summary text changes — kind, destination, entities,
   * goals, constraints, confidence, etc. are untouched.
   */
  async enrichIntent(
    intent: StructuredIntent,
  ): Promise<{ intent: StructuredIntent; summary: EnrichedSummary }> {
    const summary = await this.enrich(intent);
    return { intent: { ...intent, intent: summary.summary }, summary };
  }
}

/**
 * Deterministic, dependency-free summary used as the default and the fallback. It restates
 * the classified intent from already-extracted structure — no model, no network.
 */
export function heuristicSummary(intent: StructuredIntent): string {
  const verb = KIND_VERB[intent.kind];
  const parts: string[] = [];

  if (intent.goals.length > 0) {
    parts.push(intent.goals.slice(0, 2).join(' and '));
  } else if (intent.entities.length > 0) {
    parts.push(intent.entities.slice(0, 3).join(', '));
  } else {
    parts.push(condense(intent.intent));
  }

  let line = `${verb} ${parts.join('; ')}`.trim();
  if (intent.constraints.length > 0) {
    line += ` (constraints: ${intent.constraints.slice(0, 2).join('; ')})`;
  }
  return capitalize(line);
}

const KIND_VERB: Record<StructuredIntent['kind'], string> = {
  SIMULATE: 'Simulate',
  EXECUTE: 'Execute',
  QUERY: 'Answer a question about',
  DOCUMENT: 'Document',
  CLARIFY: 'Clarify',
  UNKNOWN: 'Interpret request regarding',
};

/** Build the user prompt for the provider from the already-classified intent. */
function buildPrompt(intent: StructuredIntent): string {
  const lines = [
    `Utterance: ${intent.intent}`,
    `Classified kind: ${intent.kind}`,
  ];
  if (intent.entities.length > 0) lines.push(`Entities: ${intent.entities.join(', ')}`);
  if (intent.goals.length > 0) lines.push(`Goals: ${intent.goals.join('; ')}`);
  if (intent.constraints.length > 0) lines.push(`Constraints: ${intent.constraints.join('; ')}`);
  lines.push('Reply with one concise sentence paraphrasing what the user wants.');
  return lines.join('\n');
}

/** Trim, drop surrounding quotes, collapse whitespace, and cap length. */
function sanitize(text: string, maxChars: number): string {
  let t = text.replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (t.length > maxChars) t = `${t.slice(0, maxChars - 3).trimEnd()}...`;
  return t;
}

function condense(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}
