/**
 * observability/trace.ts — PacketTracer (Phase 5 observability).
 *
 * A lightweight, fixed-size in-memory ring buffer of packet trace spans. Like the
 * MetricsCollector, it plugs into the router's read-only `DispatchObserver` seam and only
 * observes completed dispatches — it never touches routing, KNOLL, or any packet payload.
 *
 * Each span is a compact projection: packetId, source, destination, duration, verdict, and
 * a wall-clock timestamp. The buffer is bounded (oldest spans are overwritten) so tracing is
 * safe to leave on indefinitely without unbounded memory growth. No payload contents are
 * retained — only routing metadata — so tracing never leaks packet data.
 */
import type { AgentRole, RoutingStatus } from '../config/routing_schema.js';
import type { DispatchEvent, DispatchObserver } from '../apex/router.js';

export interface TraceSpan {
  packetId: string;
  source: AgentRole;
  dest: AgentRole;
  /** Gated-dispatch duration (KNOLL + handler), in milliseconds. */
  durationMs: number;
  verdict: RoutingStatus;
  /** Wall-clock timestamp when the span was recorded. */
  at: number;
}

export const DEFAULT_TRACE_CAPACITY = 256;

export interface PacketTracerOptions {
  /** Max spans retained before the oldest are overwritten. Default 256. */
  capacity?: number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
}

export class PacketTracer {
  readonly capacity: number;
  private readonly now: () => number;
  private readonly buffer: TraceSpan[] = [];
  /** Next write index within the ring. */
  private cursor = 0;
  private filled = 0;

  constructor(options: PacketTracerOptions = {}) {
    const cap = options.capacity ?? DEFAULT_TRACE_CAPACITY;
    this.capacity = cap > 0 ? Math.floor(cap) : DEFAULT_TRACE_CAPACITY;
    this.now = options.now ?? Date.now;
  }

  /** Bind this tracer as a router `DispatchObserver`. */
  observer(): DispatchObserver {
    return (event: DispatchEvent) => this.record(event);
  }

  /** Append a span derived from a dispatch event (overwriting the oldest when full). */
  record(event: DispatchEvent): void {
    const span: TraceSpan = {
      packetId: event.packetId,
      source: event.source,
      dest: event.destination,
      durationMs: event.durationMs,
      verdict: event.status,
      at: this.now(),
    };
    this.buffer[this.cursor] = span;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  /** Number of spans currently retained. */
  get size(): number {
    return this.filled;
  }

  /** All retained spans in chronological order (oldest first). */
  spans(): TraceSpan[] {
    if (this.filled < this.capacity) {
      // Not yet wrapped: entries [0, cursor) are already in order.
      return this.buffer.slice(0, this.filled);
    }
    // Wrapped: oldest sits at `cursor`, newest at `cursor - 1`.
    return [...this.buffer.slice(this.cursor), ...this.buffer.slice(0, this.cursor)];
  }

  /** The most recent `n` spans (newest last), capped to what's retained. */
  recent(n: number): TraceSpan[] {
    const all = this.spans();
    if (!Number.isFinite(n) || n <= 0) return all;
    return all.slice(-Math.floor(n));
  }

  clear(): void {
    this.buffer.length = 0;
    this.cursor = 0;
    this.filled = 0;
  }
}
