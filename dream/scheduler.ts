/**
 * dream/scheduler.ts — energy/event-driven scheduling hooks for DREAM (Phase 2, extended
 * in Phase 4.2 with stream-energy accounting).
 *
 * This is an APEX-SIDE hook: APEX watches a synthetic "stream" of events and asks the
 * scheduler whether a DREAM simulation is warranted. When it is, the scheduler dispatches
 * an APEX → DREAM packet through the injected `sendViaApex` transport. DREAM therefore
 * remains reachable ONLY via APEX — the scheduler never touches DREAM directly.
 *
 * Phase 4.2: every observed event is folded into a {@link StreamEnergyMeter}. The
 * accumulated (decaying) energy — blended with the event's own magnitude — drives the
 * breadth / depth / priority of the simulation, and lets a *building* stream (repeated
 * chat bursts, anomaly near-misses) schedule work even when no single event is a spike.
 *
 * CONSTRAINT: the scheduler does not govern DREAM's *content*; it only decides *when* to
 * ask APEX to schedule a simulation, and how wide/deep, based on stream energy + event type.
 */
import { AgentRole, type PacketPriority } from '../config/routing_schema.js';
import type { CreatePacketInput, DispatchResult } from '../apex/index.js';
import {
  StreamEnergyMeter,
  type StreamEvent,
  type StreamEventType,
  type StreamEnergyMeterOptions,
} from './energy.js';

export type { StreamEvent, StreamEventType } from './energy.js';

export interface ScheduleDecision {
  shouldSchedule: boolean;
  reason: string;
  priority: PacketPriority;
  breadth: number;
  depth: number;
  /** Effective stream energy (accumulated meter level blended with the event's magnitude). */
  energy: number;
}

export interface DreamSchedulerOptions {
  /** Energy at/above which an ENERGY_SPIKE (or a USER_REQUEST) is treated as CRITICAL. Default 0.7. */
  spikeThreshold?: number;
  /** IDLE_TICKs to accumulate before a speculative background sim. Default 5. */
  idleTicksPerSpeculation?: number;
  /**
   * Accumulated energy at/above which building signals (CHAT_BURST, ANOMALY_NEAR_MISS)
   * schedule a simulation, and below which the stream is considered "quiet". Default 0.5.
   */
  scheduleThreshold?: number;
  /** Inject a shared energy meter; otherwise the scheduler constructs its own. */
  energyMeter?: StreamEnergyMeter;
  /** Options used when the scheduler constructs its own meter (ignored if `energyMeter` is set). */
  meter?: StreamEnergyMeterOptions;
}

export type SendViaApex = (input: CreatePacketInput) => DispatchResult;

export class DreamScheduler {
  private readonly spikeThreshold: number;
  private readonly idleTicksPerSpeculation: number;
  private readonly scheduleThreshold: number;
  private readonly meter: StreamEnergyMeter;
  private idleTicks = 0;

  constructor(options: DreamSchedulerOptions = {}) {
    this.spikeThreshold = options.spikeThreshold ?? 0.7;
    this.idleTicksPerSpeculation = options.idleTicksPerSpeculation ?? 5;
    this.scheduleThreshold = options.scheduleThreshold ?? 0.5;
    this.meter = options.energyMeter ?? new StreamEnergyMeter(options.meter);
  }

  /** Current accumulated stream energy (decayed to `at`, default now). Read-only. */
  energyLevel(at?: number): number {
    return this.meter.level(at);
  }

  /**
   * Decide whether an event warrants scheduling a DREAM simulation. Folds the event into
   * the energy meter (so accumulation/decay is tracked) and derives breadth/depth/priority
   * from the resulting level. No packet is dispatched here.
   */
  evaluate(event: StreamEvent): ScheduleDecision {
    const accumulated = this.meter.observe(event);
    // A fresh, strong event should count even before it has accumulated in the meter.
    const energy = Math.max(accumulated, event.energy ?? 0);
    const shape = shapeFor(energy);

    switch (event.type) {
      case 'USER_REQUEST':
        return {
          shouldSchedule: true,
          reason: `user request always warrants simulation (energy ${round2(energy)})`,
          priority: energy >= this.spikeThreshold ? 'CRITICAL' : 'STANDARD',
          breadth: Math.max(3, shape.breadth),
          depth: Math.max(2, shape.depth),
          energy,
        };
      case 'ENERGY_SPIKE': {
        const hot = energy >= this.spikeThreshold;
        return {
          shouldSchedule: hot,
          reason: hot
            ? `energy ${round2(energy)} >= spike threshold ${this.spikeThreshold}`
            : `energy ${round2(energy)} below spike threshold ${this.spikeThreshold}`,
          priority: shape.priority,
          breadth: shape.breadth,
          depth: shape.depth,
          energy,
        };
      }
      case 'CHAT_BURST': {
        const due = energy >= this.scheduleThreshold;
        return {
          shouldSchedule: due,
          reason: due
            ? `chat activity accumulated energy ${round2(energy)} >= ${this.scheduleThreshold}`
            : `chat activity building (energy ${round2(energy)}/${this.scheduleThreshold})`,
          priority: shape.priority === 'BACKGROUND' ? 'STANDARD' : shape.priority,
          breadth: shape.breadth,
          depth: shape.depth,
          energy,
        };
      }
      case 'ANOMALY_NEAR_MISS': {
        const due = energy >= this.scheduleThreshold;
        return {
          shouldSchedule: due,
          reason: due
            ? `anomaly near-miss raised energy to ${round2(energy)} — simulating mitigations`
            : `anomaly near-miss noted (energy ${round2(energy)}/${this.scheduleThreshold})`,
          priority: energy >= this.spikeThreshold ? 'CRITICAL' : 'STANDARD',
          breadth: Math.max(3, shape.breadth),
          depth: Math.max(2, shape.depth),
          energy,
        };
      }
      case 'IDLE_TICK': {
        this.idleTicks += 1;
        const countDue = this.idleTicks >= this.idleTicksPerSpeculation;
        const quiet = energy < this.scheduleThreshold;
        const due = countDue && quiet;
        if (countDue) this.idleTicks = 0;
        return {
          shouldSchedule: due,
          reason: due
            ? `accumulated ${this.idleTicksPerSpeculation} idle ticks at low energy (${round2(energy)}) — speculative sim`
            : quiet
              ? `idle (${this.idleTicks}/${this.idleTicksPerSpeculation}, energy ${round2(energy)})`
              : `idle but stream still warm (energy ${round2(energy)}) — deferring speculation`,
          priority: 'BACKGROUND',
          breadth: 2,
          depth: 1,
          energy,
        };
      }
      default:
        return { shouldSchedule: false, reason: 'unknown event type', priority: 'BACKGROUND', breadth: 0, depth: 0, energy };
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
        streamEnergy: round2(decision.energy),
        breadth: decision.breadth,
        depth: decision.depth,
      },
      priority: decision.priority,
    });
    return { decision, result };
  }
}

/** Map an energy level (0..1) to a simulation shape: hotter streams explore wider/deeper. */
function shapeFor(energy: number): { breadth: number; depth: number; priority: PacketPriority } {
  if (energy >= 0.85) return { breadth: 4, depth: 3, priority: 'CRITICAL' };
  if (energy >= 0.55) return { breadth: 3, depth: 2, priority: 'STANDARD' };
  if (energy >= 0.3) return { breadth: 2, depth: 2, priority: 'STANDARD' };
  return { breadth: 2, depth: 1, priority: 'BACKGROUND' };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function defaultIntent(type: StreamEventType): string {
  switch (type) {
    case 'USER_REQUEST':
      return 'simulate outcomes for the pending user request';
    case 'ENERGY_SPIKE':
      return 'simulate outcomes triggered by a stream energy spike';
    case 'CHAT_BURST':
      return 'simulate outcomes for a burst of conversational activity';
    case 'ANOMALY_NEAR_MISS':
      return 'simulate mitigations following an anomaly near-miss';
    case 'IDLE_TICK':
    default:
      return 'speculative idle-time outcome simulation';
  }
}
