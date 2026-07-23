/**
 * hope/voice.ts — HOPE's forward-facing voice (Phase 2).
 *
 * HOPE is the UI/UX voice of the system: it formats user-facing acknowledgements,
 * clarification requests, and status replies. It reflects the user's goal back to them
 * and surfaces KNOLL denials gracefully.
 *
 * CONSTRAINT: the voice ONLY formats text. It never executes a tool, creates an artifact,
 * or routes a packet. It imports no peer agent. All strings describe what *will be
 * requested of* the system, never claim HOPE did the work itself.
 */
import type { DispatchResult } from '../apex/index.js';
import type { StructuredIntent } from './interpreter.js';

export class HopeVoice {
  /** A calm, precise acknowledgement that reflects the parsed intent back to the user. */
  acknowledge(intent: StructuredIntent): string {
    const goal = intent.goals[0] ? ` I understand you want to ${intent.goals[0]}.` : '';
    const action = describeAction(intent);
    const urgency = intent.urgency === 'HIGH' ? " I'll flag this as urgent." : '';
    return `Got it.${goal} ${action}${urgency}`.replace(/\s+/g, ' ').trim();
  }

  /** A clarification request used when confidence is below threshold. */
  clarify(intent: StructuredIntent): string {
    const hints: string[] = [];
    if (intent.entities.length === 0) hints.push('what specifically this concerns');
    if (intent.goals.length === 0) hints.push('what outcome you want');
    if (intent.kind === 'UNKNOWN') hints.push('whether you want to simulate, execute, or ask a question');
    const ask = hints.length ? ` Could you tell me ${joinList(hints)}?` : ' Could you rephrase that with a bit more detail?';
    return `I want to make sure I get this right.${ask}`;
  }

  /** A status reply summarizing what the router/KNOLL did with a dispatched intent. */
  status(result: DispatchResult): string {
    switch (result.status) {
      case 'SUCCESS':
        return `Done — your request was routed and processed (ref ${short(result.packetId)}).`;
      case 'BLOCKED':
        return this.deny(result.knoll.reasoning);
      case 'FAILED':
      default:
        return `Something went wrong handling your request (ref ${short(result.packetId)})${
          result.error ? `: ${result.error}` : ''
        }.`;
    }
  }

  /** Surface a KNOLL denial to the user gracefully, without leaking internals. */
  deny(reasoning?: string): string {
    const detail = reasoning ? ` (${reasoning})` : '';
    return `That request was blocked by policy${detail}. I can't proceed with it as stated.`;
  }
}

function describeAction(intent: StructuredIntent): string {
  switch (intent.kind) {
    case 'SIMULATE':
      return "I'll ask the system to simulate possible outcomes for this.";
    case 'EXECUTE':
      return "I'll ask the system to carry this out in a sandbox and report back.";
    case 'QUERY':
      return "I'll answer this as an interpretation — no action will be taken.";
    case 'DOCUMENT':
      return "I've documented this intent for the record.";
    case 'CLARIFY':
      return 'I need a little more detail first.';
    default:
      return "I'll route this for the system to decide the best handling.";
  }
}

function joinList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}
