/**
 * persistence/kafka_stub.ts — Phase 4 distributed task-queue abstraction.
 *
 * Phase 2 shipped an in-memory Redis-like queue (redis_router_stub.ts) with a single
 * shared FIFO/priority stream (enqueue/dequeue/ack/nack). Phase 4 introduces the richer
 * abstraction the 20,480-node fleet actually needs: a *partitioned, consumer-group* event
 * log — i.e. a Kafka-shaped `TaskQueue` with `publish` / `subscribe` / `ack` / `nack`,
 * partitioned by the destination `AgentRole`.
 *
 * SEMANTICS (Kafka-like):
 *   - Each destination AgentRole is a partition. `publish` appends to that partition's
 *     append-only log and assigns a monotonically-increasing offset.
 *   - Consumers join a named CONSUMER GROUP. Every group receives its own independent copy
 *     of the stream (fan-out across groups). Within a group a message is delivered exactly
 *     once, to whichever subscription in the group *owns* that partition (Kafka partition
 *     assignment: one partition → at most one consumer per group).
 *   - A delivered message is held in the group's in-flight set until `ack` (commit) or
 *     `nack` (redeliver). This mirrors at-least-once delivery with manual commits.
 *
 * ARCHITECTURE / INVARIANTS: this file is dependency-light — it imports ONLY from
 * `config/`, so it introduces no cross-agent coupling. It transports RoutingPackets; it
 * never inspects, mutates, or bypasses them. KNOLL still gates every packet when the
 * ApexOrchestrator consumes the queue and calls `dispatch` — the queue is pure transport.
 *
 * MIGRATION PATH TO REAL KAFKA:
 *   - Partition key → Kafka partition (hash of AgentRole, or an explicit key). Keep the
 *     partition count == number of AgentRoles (5) or a multiple for parallelism.
 *   - `publish` → producer.send({ topic: 'routing-packets', key: destination, value }).
 *   - `subscribe(group, ...)` → consumer.subscribe + consumer.run with `groupId: group`.
 *   - `ack` → manual offset commit (consumer.commitOffsets); `nack` → seek back / DLQ.
 *   - Replace RoutingPacket JSON with a schema-registry-backed Avro/Protobuf serializer;
 *     the RoutingPacket contract stays authoritative (KNOLL validates the deserialized
 *     packet exactly as today). Nothing above the interface changes.
 *   - Durability/ordering: Kafka gives per-partition ordering + replay; this stub already
 *     preserves per-partition offset ordering so consumer code ports unchanged.
 */
import { randomUUID } from 'node:crypto';
import { AgentRole, type RoutingPacket } from '../config/routing_schema.js';

/** A published message: one record appended to a partition's log. */
export interface QueueMessage {
  messageId: string;
  /** Partition key — the destination AgentRole this packet is bound for. */
  partition: AgentRole;
  /** Monotonic per-partition offset (0-based). */
  offset: number;
  enqueuedAt: number;
  packet: RoutingPacket;
}

/** A message handed to a consumer group; must be ack'd or nack'd to leave in-flight. */
export interface DeliveredMessage extends QueueMessage {
  consumerGroup: string;
  deliveredAt: number;
  deliveryCount: number;
}

/** Handler a subscription registers to receive delivered messages. */
export type QueueSubscriber = (message: DeliveredMessage) => void;

/** A live subscription handle; call `close()` to leave the consumer group. */
export interface Subscription {
  group: string;
  partitions: readonly AgentRole[];
  close(): void;
}

export interface SubscribeOptions {
  /**
   * Partitions this subscription consumes. Omit (or pass 'ALL') to consume every
   * partition. Multiple subscriptions in the same group split partitions between them.
   */
  partitions?: AgentRole[] | 'ALL';
  /**
   * When true, the subscriber is immediately replayed every message already in its
   * partitions (from offset 0) that the group has not yet committed. Enables
   * publish-before-subscribe. Default false (only future messages are delivered).
   */
  replayFromStart?: boolean;
}

/**
 * The Phase 4 task-queue contract. Partitioned by AgentRole, consumer-group aware.
 */
export interface TaskQueue {
  /** Append a packet to its destination partition and fan it out to subscribed groups. */
  publish(packet: RoutingPacket): QueueMessage;
  /** Join a consumer group and receive messages for the given partitions. */
  subscribe(group: string, handler: QueueSubscriber, options?: SubscribeOptions): Subscription;
  /** Commit a delivered message for a group (remove from in-flight). */
  ack(group: string, messageId: string): boolean;
  /** Redeliver a delivered message for a group (consumer failed). */
  nack(group: string, messageId: string): boolean;
  /** The partition (AgentRole) a packet belongs to. */
  partitionOf(packet: RoutingPacket): AgentRole;
  /** Backlog depth: undelivered messages across all partitions (or one partition). */
  depth(partition?: AgentRole): number;
  /** In-flight (delivered, unacked) count across all groups (or one group). */
  inFlight(group?: string): number;
  /** Reset the whole broker (logs, groups, offsets). */
  clear(): void;
}

interface GroupSubscription {
  id: string;
  partitions: Set<AgentRole>;
  handler: QueueSubscriber;
}

interface ConsumerGroup {
  name: string;
  subscriptions: GroupSubscription[];
  /** Next offset the group will consume, per partition (its committed cursor). */
  cursor: Map<AgentRole, number>;
  /** Delivered-but-unacked messages for this group, keyed by messageId. */
  inFlight: Map<string, DeliveredMessage>;
}

const ALL_PARTITIONS: readonly AgentRole[] = Object.values(AgentRole);

/**
 * In-memory, Kafka-like partitioned task queue with consumer groups.
 *
 * Not durable and single-process — but the delivery semantics (partitioned append-only
 * logs, per-group offsets, at-least-once with manual ack) match real Kafka closely enough
 * that consumer code written against this interface ports to a real broker unchanged.
 */
export class InMemoryKafkaStub implements TaskQueue {
  /** Append-only log per partition (AgentRole). */
  private readonly logs = new Map<AgentRole, QueueMessage[]>();
  private readonly groups = new Map<string, ConsumerGroup>();

  constructor() {
    for (const role of ALL_PARTITIONS) this.logs.set(role, []);
  }

  partitionOf(packet: RoutingPacket): AgentRole {
    // Partition key is the destination role — all work for one Big AI stays in-order.
    return packet.header.destination;
  }

  publish(packet: RoutingPacket): QueueMessage {
    const partition = this.partitionOf(packet);
    const log = this.logs.get(partition)!;
    const message: QueueMessage = {
      messageId: `msg_${randomUUID()}`,
      partition,
      offset: log.length,
      enqueuedAt: Date.now(),
      packet,
    };
    log.push(message);
    // Fan out to every group that owns this partition. Each group is independent.
    for (const group of this.groups.values()) this.deliverNew(group, partition);
    return message;
  }

  subscribe(group: string, handler: QueueSubscriber, options: SubscribeOptions = {}): Subscription {
    const partitions = normalizePartitions(options.partitions);
    const g = this.ensureGroup(group);
    const sub: GroupSubscription = { id: `sub_${randomUUID()}`, partitions, handler };
    g.subscriptions.push(sub);

    if (options.replayFromStart) {
      // Rewind this subscription's owned partitions to offset 0 so already-published
      // messages are (re)delivered to the newly-joined group.
      for (const p of partitions) g.cursor.set(p, 0);
    }
    // Deliver any backlog now visible to this subscription's partitions.
    for (const p of partitions) this.deliverNew(g, p);

    return {
      group,
      partitions: Array.from(partitions),
      close: () => {
        g.subscriptions = g.subscriptions.filter((s) => s.id !== sub.id);
      },
    };
  }

  ack(group: string, messageId: string): boolean {
    const g = this.groups.get(group);
    if (!g) return false;
    return g.inFlight.delete(messageId);
  }

  nack(group: string, messageId: string): boolean {
    const g = this.groups.get(group);
    if (!g) return false;
    const msg = g.inFlight.get(messageId);
    if (!msg) return false;
    g.inFlight.delete(messageId);
    // Redeliver immediately to the owning subscription with an incremented count.
    const owner = this.ownerFor(g, msg.partition);
    if (owner) {
      const redelivered: DeliveredMessage = {
        ...msg,
        deliveredAt: Date.now(),
        deliveryCount: msg.deliveryCount + 1,
      };
      g.inFlight.set(redelivered.messageId, redelivered);
      owner.handler(redelivered);
    }
    return true;
  }

  depth(partition?: AgentRole): number {
    // Undelivered = log length minus the max committed cursor across groups for that
    // partition. With no groups, everything is backlog.
    const partitions = partition ? [partition] : ALL_PARTITIONS;
    let total = 0;
    for (const p of partitions) {
      const log = this.logs.get(p)!;
      if (this.groups.size === 0) {
        total += log.length;
        continue;
      }
      let minConsumed = log.length;
      for (const g of this.groups.values()) {
        minConsumed = Math.min(minConsumed, g.cursor.get(p) ?? 0);
      }
      total += log.length - minConsumed;
    }
    return total;
  }

  inFlight(group?: string): number {
    if (group) return this.groups.get(group)?.inFlight.size ?? 0;
    let n = 0;
    for (const g of this.groups.values()) n += g.inFlight.size;
    return n;
  }

  /** Committed offset for a group on a partition (how far it has consumed). */
  committedOffset(group: string, partition: AgentRole): number {
    return this.groups.get(group)?.cursor.get(partition) ?? 0;
  }

  /** Total messages published to a partition (its log length / high-water mark). */
  highWaterMark(partition: AgentRole): number {
    return this.logs.get(partition)!.length;
  }

  clear(): void {
    for (const log of this.logs.values()) log.length = 0;
    this.groups.clear();
  }

  private ensureGroup(name: string): ConsumerGroup {
    let g = this.groups.get(name);
    if (!g) {
      g = { name, subscriptions: [], cursor: new Map(), inFlight: new Map() };
      for (const role of ALL_PARTITIONS) g.cursor.set(role, 0);
      this.groups.set(name, g);
    }
    return g;
  }

  /** Deliver all not-yet-consumed messages on a partition to the group's owning sub. */
  private deliverNew(group: ConsumerGroup, partition: AgentRole): void {
    const owner = this.ownerFor(group, partition);
    if (!owner) return;
    const log = this.logs.get(partition)!;
    let cursor = group.cursor.get(partition) ?? 0;
    while (cursor < log.length) {
      const message = log[cursor];
      cursor += 1;
      group.cursor.set(partition, cursor);
      const delivered: DeliveredMessage = {
        ...message,
        consumerGroup: group.name,
        deliveredAt: Date.now(),
        deliveryCount: 1,
      };
      group.inFlight.set(delivered.messageId, delivered);
      owner.handler(delivered);
    }
  }

  /** The single subscription in a group that owns a partition (Kafka assignment). */
  private ownerFor(group: ConsumerGroup, partition: AgentRole): GroupSubscription | undefined {
    // First-registered subscription whose filter includes the partition wins ownership —
    // one partition is consumed by at most one consumer within a group.
    return group.subscriptions.find((s) => s.partitions.has(partition));
  }
}

function normalizePartitions(partitions?: AgentRole[] | 'ALL'): Set<AgentRole> {
  if (!partitions || partitions === 'ALL') return new Set(ALL_PARTITIONS);
  return new Set(partitions);
}
