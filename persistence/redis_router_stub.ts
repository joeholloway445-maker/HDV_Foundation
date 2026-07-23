/**
 * persistence/redis_router_stub.ts — real-time task queue interface + in-memory stub.
 *
 * Phase 2 introduces a queue abstraction so APEX can (later) hand ephemeral work to a
 * real-time broker instead of running it inline. This file defines the `TaskQueue`
 * interface (enqueue / dequeue / ack / nack) and an in-memory Redis-like implementation
 * with per-priority ordering and an in-flight (unacked) set.
 *
 * ROADMAP: Phase 2 uses this in-memory stub. A Redis-backed implementation slots in
 * behind the same interface next. **Kafka** (durable, partitioned event streaming for
 * the 20,480-node fleet) is deferred to **Phase 4** — see README Phase status table.
 *
 * Dependency-light: imports only from `config/` so no agent coupling is introduced.
 */
import { randomUUID } from 'node:crypto';
import type { PacketPriority, RoutingPacket } from '../config/routing_schema.js';

/** A queued unit of work. In Phase 2 the payload is a full RoutingPacket. */
export interface QueuedTask {
  taskId: string;
  priority: PacketPriority;
  enqueuedAt: number;
  packet: RoutingPacket;
}

/** A message handed to a consumer; must be ack'd or nack'd to leave the in-flight set. */
export interface DeliveredTask extends QueuedTask {
  deliveredAt: number;
  deliveryCount: number;
}

export interface TaskQueue {
  enqueue(packet: RoutingPacket): QueuedTask;
  dequeue(): DeliveredTask | undefined;
  ack(taskId: string): boolean;
  /** Requeue an in-flight task (e.g. consumer failed). Returns false if unknown. */
  nack(taskId: string): boolean;
  depth(): number;
  inFlight(): number;
  clear(): void;
}

const PRIORITY_ORDER: Record<PacketPriority, number> = {
  CRITICAL: 0,
  STANDARD: 1,
  BACKGROUND: 2,
};

/**
 * In-memory, Redis-like task queue. Ordering is priority-first, FIFO within a priority.
 * Delivered-but-unacked tasks are held in an in-flight map so a nack can requeue them.
 */
export class InMemoryRedisRouterStub implements TaskQueue {
  private readonly ready: QueuedTask[] = [];
  private readonly flight = new Map<string, DeliveredTask>();

  enqueue(packet: RoutingPacket): QueuedTask {
    const task: QueuedTask = {
      taskId: `task_${randomUUID()}`,
      priority: packet.header.priority,
      enqueuedAt: Date.now(),
      packet,
    };
    this.ready.push(task);
    // Stable priority sort: CRITICAL first, then STANDARD, then BACKGROUND.
    this.ready.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    return task;
  }

  dequeue(): DeliveredTask | undefined {
    const next = this.ready.shift();
    if (!next) return undefined;
    const delivered: DeliveredTask = {
      ...next,
      deliveredAt: Date.now(),
      deliveryCount: 1,
    };
    this.flight.set(delivered.taskId, delivered);
    return delivered;
  }

  ack(taskId: string): boolean {
    return this.flight.delete(taskId);
  }

  nack(taskId: string): boolean {
    const t = this.flight.get(taskId);
    if (!t) return false;
    this.flight.delete(taskId);
    this.ready.push({
      taskId: t.taskId,
      priority: t.priority,
      enqueuedAt: t.enqueuedAt,
      packet: t.packet,
    });
    this.ready.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    return true;
  }

  depth(): number {
    return this.ready.length;
  }

  inFlight(): number {
    return this.flight.size;
  }

  clear(): void {
    this.ready.length = 0;
    this.flight.clear();
  }
}
