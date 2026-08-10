/**
 * companion/memory.ts — opt-in companion relationship memory (companion/).
 *
 * Same thin PRODUCT surface posture as the rest of `companion/`: it is NOT one of the Big 5
 * agents, holds no routing/security/execution logic, and NEVER talks to APEX/KNOLL/HOPE/
 * DREAM/VISION. It only turns a durable `CompanionMemoryRecord` (persistence/repositories.ts)
 * into a short prompt fragment, and turns a completed chat turn into an updated record — pure
 * data transformation, dependency-injected the same way companion/handlers.ts's LlmProvider is.
 *
 * DESIGN CHOICE — heuristic update, not a second LLM call:
 * `updateMemoryAfterTurn` uses a lightweight keyword-sentiment heuristic (approach "b" from the
 * design options) rather than asking the LlmProvider for a fresh summary via a second
 * `.complete()` call (approach "a"). Reasons:
 *   - It has to work correctly with NO provider configured (the default, fully-offline stub
 *     path) — a heuristic trivially satisfies that; an LLM-summary approach would have to be
 *     entirely skipped in that case anyway, so the offline behavior converges either way.
 *   - It never adds a second network round-trip (cost or latency) to every single chat turn —
 *     companion chat is a high-volume PRODUCT surface, and doubling the LLM calls per turn
 *     doubles both spend and the chance of a slow/failed turn.
 *   - It is deterministic and trivially unit-testable (no fake-provider plumbing needed to
 *     exercise the memory-update logic itself).
 * The tradeoff is a cruder, less semantically rich running summary than an LLM could produce.
 * If that tradeoff stops being acceptable, swap this function's body for an approach-(a)
 * implementation that calls `provider.complete()` with a tight `maxTokens` cap, guarded so it
 * is skipped (memory just doesn't update that turn) whenever `provider` is undefined or is the
 * offline stub — the `provider` parameter below is already threaded through in anticipation of
 * that swap, and every caller stays unchanged either way.
 */
import type { CompanionMemoryRecord } from '../persistence/repositories.js';
import type { LlmProvider } from '../providers/types.js';

const DEFAULT_AFFECTION = 50;
const MIN_AFFECTION = 0;
const MAX_AFFECTION = 100;

/** Hard cap on the running summary's length — keeps it cheap to fold into every system prompt. */
const MAX_SUMMARY_CHARS = 600;
/** Max characters kept from each side of a single exchange when appended to the summary. */
const MAX_SNIPPET_CHARS = 100;

/** Fresh, never-persisted defaults for a companionId with no existing memory row. */
export function defaultCompanionMemory(companionId: string): CompanionMemoryRecord {
  return { companionId, affectionLevel: DEFAULT_AFFECTION, summary: '', turnCount: 0, updatedAt: Date.now() };
}

/**
 * A short paragraph folding the companion's remembered relationship state into the system
 * prompt — mirrors how companion/handlers.ts's systemPrompt() already folds in
 * `persona.backstory`. Never throws; always returns a non-empty string.
 */
export function buildMemoryContext(memory: CompanionMemoryRecord): string {
  const level = clampAffection(memory.affectionLevel);
  const summary = memory.summary.trim() || "You have no shared history yet — this is your first conversation.";
  return `Relationship history: ${summary}. Current affection level: ${level}/100.`;
}

/** Very small positive/negative keyword lists driving the affection-delta heuristic below. */
const POSITIVE_KEYWORDS = [
  'love', 'miss you', 'beautiful', 'amazing', 'happy', 'thank you', 'thanks', 'sweet',
  'wonderful', 'perfect', 'adore', 'care about you', 'glad', 'excited', 'cute', 'xoxo',
  'good morning', 'good night', 'appreciate', 'grateful',
];
const NEGATIVE_KEYWORDS = [
  'hate', 'stupid', 'annoying', 'angry', 'mad at you', 'shut up', 'ugly', 'boring',
  'leave me alone', 'worthless', 'dumb', 'sick of you', 'done with you',
];

/** Count non-overlapping keyword hits (case-insensitive) in `text`. */
function countHits(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) hits += 1;
  }
  return hits;
}

/** Clamp an integer into the 0-100 affection range. */
function clampAffection(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AFFECTION;
  return Math.min(MAX_AFFECTION, Math.max(MIN_AFFECTION, Math.round(value)));
}

/** Trim, collapse whitespace, and cap a snippet for inclusion in the rolling summary. */
function snippet(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1).trimEnd()}…` : cleaned;
}

/** Keep only the tail of `text` (most recent content) within `maxChars`, on a clean boundary. */
function capToTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tail = text.slice(text.length - maxChars);
  const cut = tail.indexOf(' | ');
  return cut === -1 ? tail : tail.slice(cut + 3);
}

/**
 * After a REAL (non-fallback) LLM reply, produce the next memory record: a small
 * sentiment-driven affection nudge plus a truncated recent-exchange snippet appended to a
 * length-capped rolling summary. See the module doc comment for why this is heuristic rather
 * than a second LLM call.
 *
 * Never throws and never requires a provider — `provider` is accepted (and currently unused)
 * only so callers and a future LLM-summary implementation share one signature; see the
 * module-level design note.
 */
export async function updateMemoryAfterTurn(
  memory: CompanionMemoryRecord,
  userMessage: string,
  botReply: string,
  _provider?: LlmProvider,
): Promise<CompanionMemoryRecord> {
  const positive = countHits(userMessage, POSITIVE_KEYWORDS);
  const negative = countHits(userMessage, NEGATIVE_KEYWORDS);
  // A small "still talking to each other" baseline, nudged by sentiment, clamped per turn so
  // no single message can swing the level wildly.
  const delta = Math.min(6, Math.max(-6, 1 + positive * 2 - negative * 3));
  const affectionLevel = clampAffection(memory.affectionLevel + delta);

  const exchange = `User: "${snippet(userMessage, MAX_SNIPPET_CHARS)}" → Reply: "${snippet(botReply, MAX_SNIPPET_CHARS)}"`;
  const combined = memory.summary.trim() ? `${memory.summary.trim()} | ${exchange}` : exchange;
  const summary = capToTail(combined, MAX_SUMMARY_CHARS);

  return {
    companionId: memory.companionId,
    affectionLevel,
    summary,
    turnCount: memory.turnCount + 1,
    updatedAt: Date.now(),
  };
}
