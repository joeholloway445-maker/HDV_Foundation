/**
 * hope/interpreter.ts — HOPE, the Interface Layer (master interpreter).
 *
 * HOPE parses natural language into a structured intent payload and hands it to APEX to
 * route. HOPE is the UI/UX "voice" of the system.
 *
 * CONSTRAINTS (enforced by construction here, and by KNOLL at the gate):
 *   - HOPE CANNOT execute. It performs no tool use and touches no sandbox.
 *   - HOPE CANNOT create. It produces interpretations, not artifacts.
 *   - HOPE only ever talks to APEX. It imports no peer agent (no DREAM, no VISION).
 *
 * See hope/PROMPT.md for the interpreter template / voice guidance.
 */
import { AgentRole } from '../config/routing_schema.js';
import type { CreatePacketInput, DispatchResult } from '../apex/index.js';

/** Kinds of intent HOPE can recognize. These map to which agent APEX should target. */
export type IntentKind = 'SIMULATE' | 'EXECUTE' | 'QUERY' | 'UNKNOWN';

export interface StructuredIntent {
  kind: IntentKind;
  /** Human-readable summary of what the user wants. */
  intent: string;
  /** Structured, opaque parameters extracted from the utterance. */
  data: Record<string, unknown>;
  /** The agent APEX should route this to, given the intent kind. */
  suggestedDestination: AgentRole;
  confidence: number;
}

/** The only capability HOPE is granted: a send-through-APEX callback (dependency injected). */
export type SendViaApex = (input: CreatePacketInput) => DispatchResult;

const SIMULATE_HINTS = ['simulate', 'imagine', 'what if', 'predict', 'forecast', 'scenario', 'dream', 'explore'];
const EXECUTE_HINTS = ['run', 'execute', 'build', 'deploy', 'ingest', 'process', 'compute', 'fetch', 'do'];
const QUERY_HINTS = ['what is', 'who', 'when', 'explain', 'describe', 'tell me'];

export class IntentInterpreter {
  /**
   * Parse a natural-language utterance into a structured intent. Pure interpretation:
   * no side effects, no execution, no creation.
   */
  interpret(utterance: string): StructuredIntent {
    const text = utterance.toLowerCase().trim();

    const simulate = score(text, SIMULATE_HINTS);
    const execute = score(text, EXECUTE_HINTS);
    const query = score(text, QUERY_HINTS);
    const max = Math.max(simulate, execute, query);

    let kind: IntentKind = 'UNKNOWN';
    let destination = AgentRole.APEX;
    if (max > 0) {
      if (max === simulate) {
        kind = 'SIMULATE';
        destination = AgentRole.DREAM;
      } else if (max === execute) {
        kind = 'EXECUTE';
        destination = AgentRole.VISION;
      } else {
        kind = 'QUERY';
        destination = AgentRole.HOPE;
      }
    }

    return {
      kind,
      intent: utterance.trim(),
      data: { utterance: utterance.trim(), keywords: extractKeywords(text) },
      suggestedDestination: destination,
      confidence: max === 0 ? 0 : Math.min(1, 0.5 + 0.1 * max),
    };
  }

  /**
   * Interpret and submit to APEX. HOPE never routes itself — it asks APEX to route,
   * and APEX (after KNOLL) decides. HOPE labels itself as the packet source.
   */
  submit(utterance: string, send: SendViaApex): { intent: StructuredIntent; result: DispatchResult } {
    const intent = this.interpret(utterance);
    // HOPE always sources packets from HOPE and asks APEX to mediate. Note: KNOLL
    // forbids HOPE from directly targeting DREAM/VISION, so HOPE addresses APEX, and
    // the orchestrator forwards. The suggestedDestination travels inside the payload.
    const result = send({
      source: AgentRole.HOPE,
      destination: AgentRole.APEX,
      intent: intent.intent,
      data: { ...intent.data, kind: intent.kind, suggestedDestination: intent.suggestedDestination },
      priority: 'STANDARD',
    });
    return { intent, result };
  }
}

function score(text: string, hints: readonly string[]): number {
  return hints.reduce((n, h) => (text.includes(h) ? n + 1 : n), 0);
}

function extractKeywords(text: string): string[] {
  return Array.from(new Set(text.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3)));
}
