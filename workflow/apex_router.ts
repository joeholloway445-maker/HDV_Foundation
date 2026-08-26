/**
 * workflow/apex_router.ts — APEX Mixture-of-Experts model router.
 *
 * Provides heuristic and (optionally) remote MoE routing for AI workflow nodes.
 * The ApexMoERouter selects the optimal Claude model based on:
 *   - Task category (code, creative, security, analysis, vision, chat)
 *   - Budget tier (low | medium | high)
 *   - Speed preference
 *   - Remote APEX endpoint (when APEX_BASE_URL is configured)
 */
import type { RouteDecision } from './types.js';

const MODEL_MAP = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
  fable: 'claude-fable-5',
} as const;

export type BudgetTier = 'low' | 'medium' | 'high';
export type TaskCategory =
  | 'security' | 'audit'
  | 'code' | 'analysis'
  | 'creative' | 'simulation'
  | 'vision' | 'multimodal'
  | 'chat' | 'support'
  | 'general';

/** Pure heuristic — no network required. */
export function heuristicRoute(intent: string, category: TaskCategory | string, budgetTier: BudgetTier): string {
  const low = budgetTier === 'low';
  const high = budgetTier === 'high';

  switch (category) {
    case 'security': case 'audit':
      return high ? MODEL_MAP.opus : MODEL_MAP.sonnet;
    case 'code': case 'analysis':
      return low ? MODEL_MAP.haiku : high ? MODEL_MAP.opus : MODEL_MAP.sonnet;
    case 'creative': case 'simulation':
      return high ? MODEL_MAP.fable : MODEL_MAP.sonnet;
    case 'vision': case 'multimodal':
      return MODEL_MAP.sonnet;
    case 'chat': case 'support':
      return low ? MODEL_MAP.haiku : MODEL_MAP.sonnet;
    default: {
      const lower = intent.toLowerCase();
      if (/secur|audit|knoll/.test(lower)) return MODEL_MAP.opus;
      if (/dream|simulat|creat/.test(lower)) return MODEL_MAP.fable;
      if (/cod|debug|refactor/.test(lower)) return MODEL_MAP.sonnet;
      return low ? MODEL_MAP.haiku : MODEL_MAP.sonnet;
    }
  }
}

export interface ApexMoERouterOptions {
  apexBaseUrl?: string;
  apexApiKey?: string;
  timeoutMs?: number;
}

export class ApexMoERouter {
  private readonly apexBaseUrl?: string;
  private readonly apexApiKey?: string;
  private readonly timeoutMs: number;

  constructor(options: ApexMoERouterOptions = {}) {
    this.apexBaseUrl = options.apexBaseUrl?.replace(/\/$/, '');
    this.apexApiKey = options.apexApiKey;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async route(
    intent: string,
    category: TaskCategory | string = 'general',
    budgetTier: BudgetTier = 'medium',
  ): Promise<RouteDecision> {
    // Try remote APEX endpoint first
    if (this.apexBaseUrl) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const resp = await fetch(`${this.apexBaseUrl}/route`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apexApiKey ? { Authorization: `Bearer ${this.apexApiKey}` } : {}),
          },
          body: JSON.stringify({ intent, category, budgetTier }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (resp.ok) {
          const data = (await resp.json()) as { model?: string };
          if (data.model) {
            return {
              model: data.model,
              category,
              budgetTier,
              routedByApex: true,
              reasoning: `Remote APEX endpoint selected ${data.model}`,
            };
          }
        }
      } catch {
        // Fall through to heuristic
      }
    }

    const model = heuristicRoute(intent, category, budgetTier);
    return {
      model,
      category,
      budgetTier,
      routedByApex: false,
      reasoning: `Heuristic: category="${category}" budget="${budgetTier}" → ${model}`,
    };
  }
}
