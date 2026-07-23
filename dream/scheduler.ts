/**
 * dream/scheduler.ts — energy/event-driven scheduling hooks for DREAM (Phase 2).
 *
 * This is an APEX-SIDE hook: APEX watches a synthetic "stream" of events and asks the
 * scheduler whether a DREAM simulation is warranted. When it is, the scheduler dispatches
 * an APEX → DREAM packet through the injected `sendViaApex` transport. DREAM therefore
 * remains reachable ONLY via APEX — the scheduler never touches DREAM directly.
 *
 * CONSTRAINT: the scheduler does not govern DREAM's *content*; it only decides *when* to
 * ask APEX to schedule a simulation, based on stream energy and event type.
 */
import { AgentRole, type PacketPriority } from '../config/routing_schema.js';
import type { CreatePacketInput, DispatchResult } from '../apex/index.js';

export type StreamEventType = 'ENERGY_SPIKE' | 'USER_REQUEST' | 'IDLE_TICK';

export interface StreamEvent {
  type: StreamEventType;
  /** Normalized 0..1 energy level associated with the event. */
  energy?: number;
  /** The intent to simulate (defaults per event type). */
  intent?: string;
  data?: Record<string, unknown>;
  at?: number;
}

export interface ScheduleDecision {
  shouldSchedule: boolean;
  reason: string;
  priority: PacketPriority;
  breadth: number;
  depth: number;
}

export interface DreamSchedulerOptions {
  /** Energy at/above which an ENERGY_SPIKE schedules a simulation. Default 0.7. */
  spikeThreshold?: number;
  /** IDLE_TICKs to accumulate before a speculative background sim. Default 5. */
  idleTicksPerSpeculation?: number;
}

export type SendViaApex = (input: CreatePacketInput) => DispatchResult;

export class DreamScheduler {
  private readonly spikeThreshold: number;
  private readonly idleTicksPerSpeculation: number;
  private idleTicks = 0;

  constructor(options: DreamSchedulerOptions = {}) {
    this.spikeThreshold = options.spikeThreshold ?? 0.7;
    this.idleTicksPerSpeculation = options.idleTicksPerSpeculation ?? 5;
  }

  /** Decide whether an event warrants scheduling a DREAM simulation (no side effects). */
  evaluate(event: StreamEvent): ScheduleDecision {
    switch (event.type) {
      case 'USER_REQUEST':
        return {
          shouldSchedule: true,
          reason: 'user request always warrants simulation',
          priority: (event.energy ?? 0) >= this.spikeThreshold ? 'CRITICAL' : 'STANDARD',
          breadth: 3,
          depth: 2,
        };
      case 'ENERGY_SPIKE': {
        const energy = event.energy ?? 0;
        const hot = energy >= this.spikeThreshold;
        return {
          shouldSchedule: hot,
          reason: hot
            ? `energy ${energy} >= spike threshold ${this.spikeThreshold}`
            : `energy ${energy} below spike threshold ${this.spikeThreshold}`,
          priority: energy >= 0.9 ? 'CRITICAL' : 'STANDARD',
          // Hotter streams explore wider/deeper.
          breadth: energy >= 0.9 ? 4 : 3,
          depth: energy >= 0.9 ? 3 : 2,
        };
      }
      case 'IDLE_TICK': {
        this.idleTicks += 1;
        const due = this.idleTicks >= this.idleTicksPerSpeculation;
        if (due) this.idleTicks = 0;
        return {
          shouldSchedule: due,
          reason: due
            ? `accumulated ${this.idleTicksPerSpeculation} idle ticks — speculative sim`
            : `idle (${this.idleTicks}/${this.idleTicksPerSpeculation})`,
          priority: 'BACKGROUND',
          breadth: 2,
          depth: 1,
        };
      }
      default:
        return { shouldSchedule: false, reason: 'unknown event type', priority: 'BACKGROUND', breadth: 0, depth: 0 };
    }
  }

  /**
   * Evaluate an event and, if warranted, dispatch an APEX → DREAM simulation packet via
   * the injected transport. Returns the decision plus the dispatch result (if scheduled).
   * DREAM is reached ONLY through APEX here.
   */
  schedule(event: StreamEvent, send: SendViaApex): { decision: ScheduleDecision; result?: DispatchResult } {
    const decision = this.evaluate(event);
    if (!decision.shouldSchedule) return { decision };
    const result = send({
      source: AgentRole.APEX,
      destination: AgentRole.DREAM,
      intent: event.intent ?? defaultIntent(event.type),
      data: {
        ...(event.data ?? {}),
        scheduledBy: 'DreamScheduler',
        eventType: event.type,
        breadth: decision.breadth,
        depth: decision.depth,
      },
      priority: decision.priority,
    });
    return { decision, result };
  }
}

function defaultIntent(type: StreamEventType): string {
  switch (type) {
    case 'USER_REQUEST':
      return 'simulate outcomes for the pending user request';
    case 'ENERGY_SPIKE':
      return 'simulate outcomes triggered by a stream energy spike';
    case 'IDLE_TICK':
    default:
      return 'speculative idle-time outcome simulation';
  }
}
