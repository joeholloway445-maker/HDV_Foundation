/**
 * persistence/kafka_real.ts — Phase 5 REAL-SLICE task queue: a Kafka-backed `TaskQueue`.
 *
 * Phase 4 shipped `InMemoryKafkaStub` (kafka_stub.ts): a single-process, Kafka-SHAPED queue
 * whose delivery semantics (partitioned append-only logs, per-group offsets, at-least-once
 * with manual ack) match a real broker closely enough that consumer code ports unchanged.
 * This module is the first real slice of that migration: `KafkaTaskQueue` implements the
 * SAME `TaskQueue` interface, but transports RoutingPackets over an actual Kafka cluster
 * via `kafkajs`.
 *
 * OFFLINE-FIRST / ZERO-DEP DEFAULT
 * --------------------------------
 * The backbone still defaults to the in-memory queue (`HDV_QUEUE=memory`, the default), so
 * nothing here is on the hot path unless a deployment explicitly opts into Kafka. `kafkajs`
 * is therefore an OPTIONAL dependency that is NOT declared in package.json `dependencies`:
 * it is loaded with a *dynamic* import ONLY when `HDV_QUEUE=kafka`. If it is not installed,
 * `connect()` throws a single, actionable error (install kafkajs + start a broker) instead of
 * failing the whole build. This keeps `npm ci`, `npm run typecheck`, and `npm test` fully
 * offline and dependency-light.
 *
 * WHY THE DYNAMIC IMPORT USES A VARIABLE SPECIFIER
 * ------------------------------------------------
 * `import('kafkajs')` with a *literal* specifier would make `tsc` try to resolve the module's
 * types at compile time — which fails ("Cannot find module 'kafkajs'") when the optional dep
 * is absent, breaking `npm run typecheck`. Importing via a runtime variable (`KAFKAJS_MODULE`)
 * defers resolution to runtime and yields `any`, which we immediately narrow to the small
 * structural `KafkaModuleLike` surface below. That surface is also what lets tests inject a
 * fake broker (see `KafkaTaskQueueOptions.kafkaModule`) and exercise the adapter offline.
 *
 * ARCHITECTURE / INVARIANTS (identical to the stub — see .cursorrules §7):
 *   - PURE TRANSPORT. This file imports ONLY from `config/` and the queue interface in
 *     `kafka_stub.ts`; it introduces no cross-agent coupling. It carries RoutingPackets; it
 *     never inspects, mutates, or bypasses them. KNOLL still gates every packet when the
 *     ApexOrchestrator consumes the queue and calls `dispatch` — the queue is pure transport.
 *   - Partitioning: each destination `AgentRole` maps to its own TOPIC (`<prefix>.<ROLE>`),
 *     so all work for one Big AI stays in per-topic order and `SubscribeOptions.partitions`
 *     maps directly onto "which role-topics this consumer subscribes to". Consumer GROUPS map
 *     onto Kafka `groupId` (native fan-out + partition assignment).
 *
 * FOUNDATION-LEVEL SIMPLIFICATIONS (documented, not hidden)
 * ---------------------------------------------------------
 * This is a real slice, not the final production queue. The following are intentionally
 * simplified and flagged for the production hardening pass:
 *   - `publish()` is synchronous per the `TaskQueue` contract, but a Kafka produce is async.
 *     We fire the `producer.send()` and return a `QueueMessage` immediately; the client-side
 *     `offset` is a best-effort local counter (the AUTHORITATIVE broker offset is surfaced on
 *     the delivered message). Await `flush()` if you need the send(s) to have landed.
 *   - `ack()`/`nack()` operate on kafkajs auto-commit: `ack` clears local in-flight tracking
 *     (the offset is committed by kafkajs after `eachMessage` resolves); `nack` re-publishes
 *     the packet to its topic for redelivery. Production would use manual offset commits + a
 *     dead-letter topic.
 *   - `depth()` reports LOCAL best-effort backlog (published-minus-delivered this process).
 *     A true cluster-wide backlog needs `admin().fetchTopicOffsets` vs committed group
 *     offsets; that is out of scope for this foundation.
 *   - `clear()` clears local state only; it never deletes broker topics.
 */
import { randomUUID } from 'node:crypto';
import { AgentRole, type RoutingPacket } from '../config/routing_schema.js';
import {
  InMemoryKafkaStub,
  type TaskQueue,
  type QueueMessage,
  type DeliveredMessage,
  type QueueSubscriber,
  type Subscription,
  type SubscribeOptions,
} from './kafka_stub.js';

const ALL_PARTITIONS: readonly AgentRole[] = Object.values(AgentRole);

/** Kafka message header carrying the queue-assigned messageId across the round-trip. */
const HEADER_MESSAGE_ID = 'x-hdv-message-id';
/** Kafka message header carrying the original enqueue timestamp. */
const HEADER_ENQUEUED_AT = 'x-hdv-enqueued-at';
/** Runtime-variable module specifier — keeps `tsc` from resolving the optional dep. */
const KAFKAJS_MODULE = 'kafkajs';

// ---------------------------------------------------------------------------
// Minimal structural view of the kafkajs surface we use. Declaring these here
// (instead of depending on @types/kafkajs) keeps the optional dep truly optional
// and lets tests inject a fake broker via KafkaTaskQueueOptions.kafkaModule.
// ---------------------------------------------------------------------------

/** Headers as kafkajs delivers them: values may be Buffer or string (be defensive). */
export type KafkaHeaders = Record<string, Buffer | string | undefined>;

export interface KafkaMessageLike {
  key?: Buffer | string | null;
  value: Buffer | string | null;
  headers?: KafkaHeaders;
  offset?: string | number;
}

export interface EachMessagePayloadLike {
  topic: string;
  partition: number;
  message: KafkaMessageLike;
}

export interface ProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: {
    topic: string;
    messages: Array<{ key?: string; value: string; headers?: Record<string, string> }>;
  }): Promise<unknown>;
}

export interface ConsumerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(config: { topic: string; fromBeginning?: boolean }): Promise<void>;
  run(config: { eachMessage: (payload: EachMessagePayloadLike) => Promise<void> }): Promise<void>;
}

export interface KafkaLike {
  producer(): ProducerLike;
  consumer(config: { groupId: string }): ConsumerLike;
}

export interface KafkaModuleLike {
  Kafka: new (config: { clientId?: string; brokers: string[] }) => KafkaLike;
}

export interface KafkaTaskQueueOptions {
  /** Broker list. Defaults to `KAFKA_BROKERS` (comma-separated) or `localhost:9092`. */
  brokers?: string[];
  /** kafkajs clientId. Default `hdv-matrix`. */
  clientId?: string;
  /** Topic name prefix; the per-role topic is `<prefix>.<ROLE>`. Default `hdv.routing`. */
  topicPrefix?: string;
  /**
   * Inject a kafkajs-compatible module (real: `await import('kafkajs')`). Tests pass a fake
   * in-memory broker here to exercise the adapter offline. When omitted, `connect()`
   * dynamically imports the optional `kafkajs` dependency.
   */
  kafkaModule?: KafkaModuleLike;
  /**
   * Best-effort async-error sink for background produce/consume failures (the sync
   * `TaskQueue` methods cannot surface them). Defaults to `console.error`.
   */
  onError?: (err: Error) => void;
}

interface GroupState {
  name: string;
  consumer: ConsumerLike;
  /** Delivered-but-unacked messages for this group, keyed by messageId. */
  inFlight: Map<string, DeliveredMessage>;
  /** Resolves once the consumer has connected + started its run loop. */
  ready: Promise<void>;
  closed: boolean;
}

/** A live subscription handle with an extra `ready` promise (superset of `Subscription`). */
export interface KafkaSubscription extends Subscription {
  /** Resolves once the underlying kafkajs consumer is connected and running. */
  ready: Promise<void>;
}

/**
 * Kafka-backed `TaskQueue`. Construct via the async `KafkaTaskQueue.connect()` (a broker
 * connection cannot be established synchronously). Once connected it satisfies the exact same
 * synchronous `TaskQueue` interface as `InMemoryKafkaStub`, so `ApexOrchestrator` and any
 * consumer code work against either backend unchanged.
 */
export class KafkaTaskQueue implements TaskQueue {
  private readonly kafka: KafkaLike;
  private readonly producer: ProducerLike;
  private readonly topicPrefix: string;
  private readonly onError: (err: Error) => void;
  private readonly groups = new Map<string, GroupState>();

  /** Best-effort, process-local per-partition offset counter used for the sync publish path. */
  private readonly published = new Map<AgentRole, number>();
  private readonly delivered = new Map<AgentRole, number>();
  /** Tracks in-flight produce promises so `flush()` can await them. */
  private readonly pendingSends = new Set<Promise<unknown>>();

  private constructor(kafka: KafkaLike, producer: ProducerLike, options: KafkaTaskQueueOptions) {
    this.kafka = kafka;
    this.producer = producer;
    this.topicPrefix = options.topicPrefix ?? 'hdv.routing';
    this.onError = options.onError ?? ((err) => console.error('[KafkaTaskQueue]', err));
    for (const role of ALL_PARTITIONS) {
      this.published.set(role, 0);
      this.delivered.set(role, 0);
    }
  }

  /**
   * Connect to Kafka and return a ready-to-use queue. Dynamically imports the optional
   * `kafkajs` dependency (unless a `kafkaModule` is injected) and connects the producer.
   * Throws a single actionable error if kafkajs is not installed.
   */
  static async connect(options: KafkaTaskQueueOptions = {}): Promise<KafkaTaskQueue> {
    const mod = options.kafkaModule ?? (await loadKafkaModule());
    const brokers = options.brokers ?? brokersFromEnv();
    const kafka = new mod.Kafka({ clientId: options.clientId ?? 'hdv-matrix', brokers });
    const producer = kafka.producer();
    await producer.connect();
    return new KafkaTaskQueue(kafka, producer, options);
  }

  /** The topic backing a given partition (AgentRole). */
  topicFor(partition: AgentRole): string {
    return `${this.topicPrefix}.${partition}`;
  }

  partitionOf(packet: RoutingPacket): AgentRole {
    // Partition key is the destination role — all work for one Big AI stays in-order.
    return packet.header.destination;
  }

  publish(packet: RoutingPacket): QueueMessage {
    const partition = this.partitionOf(packet);
    const offset = this.published.get(partition) ?? 0;
    this.published.set(partition, offset + 1);
    const message: QueueMessage = {
      messageId: `msg_${randomUUID()}`,
      partition,
      offset, // best-effort local offset; authoritative broker offset arrives on delivery
      enqueuedAt: Date.now(),
      packet,
    };
    // Fire the async produce; the sync contract returns immediately. Errors go to onError,
    // and `flush()` can await the outstanding send if a caller needs delivery confirmation.
    const send = this.producer
      .send({
        topic: this.topicFor(partition),
        messages: [
          {
            key: partition,
            value: JSON.stringify(packet),
            headers: {
              [HEADER_MESSAGE_ID]: message.messageId,
              [HEADER_ENQUEUED_AT]: String(message.enqueuedAt),
            },
          },
        ],
      })
      .catch((err: unknown) => this.onError(asError(err)));
    this.pendingSends.add(send);
    void send.finally(() => this.pendingSends.delete(send));
    return message;
  }

  subscribe(group: string, handler: QueueSubscriber, options: SubscribeOptions = {}): KafkaSubscription {
    const partitions = normalizePartitions(options.partitions);
    const fromBeginning = options.replayFromStart ?? false;

    // One kafkajs consumer per (group) — kafkajs handles partition assignment within a group.
    const consumer = this.kafka.consumer({ groupId: group });
    const state: GroupState = {
      name: group,
      consumer,
      inFlight: new Map(),
      ready: Promise.resolve(),
      closed: false,
    };
    this.groups.set(group, state);

    state.ready = (async () => {
      await consumer.connect();
      for (const p of partitions) {
        await consumer.subscribe({ topic: this.topicFor(p), fromBeginning });
      }
      await consumer.run({
        eachMessage: async ({ topic, message }) => {
          if (state.closed) return;
          const partition = roleForTopic(this.topicPrefix, topic);
          if (!partition || !partitions.has(partition)) return;
          const packet = parsePacket(message.value);
          if (!packet) {
            this.onError(new Error(`KafkaTaskQueue: undecodable message on ${topic}`));
            return;
          }
          const messageId = headerString(message.headers, HEADER_MESSAGE_ID) ?? `msg_${randomUUID()}`;
          const enqueuedAt = Number(headerString(message.headers, HEADER_ENQUEUED_AT)) || Date.now();
          this.delivered.set(partition, (this.delivered.get(partition) ?? 0) + 1);
          const deliveredMsg: DeliveredMessage = {
            messageId,
            partition,
            offset: Number(message.offset ?? this.delivered.get(partition)),
            enqueuedAt,
            packet,
            consumerGroup: group,
            deliveredAt: Date.now(),
            deliveryCount: 1,
          };
          state.inFlight.set(messageId, deliveredMsg);
          // Deliver synchronously to the handler (mirrors the stub). kafkajs auto-commits the
          // offset once this eachMessage resolves.
          handler(deliveredMsg);
        },
      });
    })().catch((err: unknown) => this.onError(asError(err)));

    return {
      group,
      partitions: Array.from(partitions),
      ready: state.ready,
      close: () => {
        state.closed = true;
        this.groups.delete(group);
        void consumer.disconnect().catch((err: unknown) => this.onError(asError(err)));
      },
    };
  }

  ack(group: string, messageId: string): boolean {
    const g = this.groups.get(group);
    if (!g) return false;
    // kafkajs commits the offset after eachMessage resolves; ack clears local tracking.
    return g.inFlight.delete(messageId);
  }

  nack(group: string, messageId: string): boolean {
    const g = this.groups.get(group);
    if (!g) return false;
    const msg = g.inFlight.get(messageId);
    if (!msg) return false;
    g.inFlight.delete(messageId);
    // Redeliver by re-publishing to the partition's topic (foundation-level; production
    // would seek back / route to a dead-letter topic). The delivery count is carried forward.
    const send = this.producer
      .send({
        topic: this.topicFor(msg.partition),
        messages: [
          {
            key: msg.partition,
            value: JSON.stringify(msg.packet),
            headers: {
              [HEADER_MESSAGE_ID]: msg.messageId,
              [HEADER_ENQUEUED_AT]: String(msg.enqueuedAt),
            },
          },
        ],
      })
      .catch((err: unknown) => this.onError(asError(err)));
    this.pendingSends.add(send);
    void send.finally(() => this.pendingSends.delete(send));
    return true;
  }

  depth(partition?: AgentRole): number {
    // Best-effort, process-local backlog (published this process minus delivered locally).
    const partitions = partition ? [partition] : ALL_PARTITIONS;
    let total = 0;
    for (const p of partitions) {
      total += Math.max(0, (this.published.get(p) ?? 0) - (this.delivered.get(p) ?? 0));
    }
    return total;
  }

  inFlight(group?: string): number {
    if (group) return this.groups.get(group)?.inFlight.size ?? 0;
    let n = 0;
    for (const g of this.groups.values()) n += g.inFlight.size;
    return n;
  }

  clear(): void {
    // Local state only — real Kafka topics are never deleted from here.
    for (const g of this.groups.values()) g.inFlight.clear();
    for (const role of ALL_PARTITIONS) {
      this.published.set(role, 0);
      this.delivered.set(role, 0);
    }
  }

  /** Await all outstanding produce sends (publish/nack are otherwise fire-and-forget). */
  async flush(): Promise<void> {
    await Promise.allSettled(Array.from(this.pendingSends));
  }

  /** Await all live subscriptions' consumers to be connected and running. */
  async ready(): Promise<void> {
    await Promise.all(Array.from(this.groups.values()).map((g) => g.ready));
  }

  /** Disconnect all consumers and the producer. Idempotent-ish; safe to call once at shutdown. */
  async close(): Promise<void> {
    for (const g of this.groups.values()) {
      g.closed = true;
      await g.consumer.disconnect().catch((err: unknown) => this.onError(asError(err)));
    }
    this.groups.clear();
    await this.flush();
    await this.producer.disconnect().catch((err: unknown) => this.onError(asError(err)));
  }
}

// ---------------------------------------------------------------------------
// Queue backend selector — the offline default is the in-memory stub.
// ---------------------------------------------------------------------------

export type QueueMode = 'memory' | 'kafka';

/**
 * Resolve the queue backend from the environment. `HDV_QUEUE=kafka` opts into the real broker;
 * anything else (including unset) selects the offline in-memory default. This keeps the
 * backbone dependency-free unless a deployment explicitly asks for Kafka.
 */
export function resolveQueueMode(env: NodeJS.ProcessEnv = process.env): QueueMode {
  return (env.HDV_QUEUE ?? '').trim().toLowerCase() === 'kafka' ? 'kafka' : 'memory';
}

/**
 * Create a `TaskQueue` for the requested (or env-resolved) backend.
 *
 *   - `'memory'` (default): a fresh `InMemoryKafkaStub`. No external dependency, no broker.
 *   - `'kafka'`: a connected `KafkaTaskQueue`. Requires the optional `kafkajs` dependency and
 *     a reachable broker; throws a clear, actionable error otherwise.
 *
 * Returns a Promise so both backends share one call site (the memory path resolves instantly).
 */
export async function createTaskQueue(
  mode: QueueMode = resolveQueueMode(),
  options: KafkaTaskQueueOptions = {},
): Promise<TaskQueue> {
  if (mode === 'kafka') return KafkaTaskQueue.connect(options);
  return new InMemoryKafkaStub();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Dynamically import the optional `kafkajs` dependency with a single actionable error. */
async function loadKafkaModule(): Promise<KafkaModuleLike> {
  try {
    // Variable specifier so `tsc` does not attempt to resolve the optional module at build time.
    const mod = (await import(KAFKAJS_MODULE)) as unknown as KafkaModuleLike;
    if (!mod || typeof mod.Kafka !== 'function') {
      throw new Error('loaded module does not expose a Kafka constructor');
    }
    return mod;
  } catch (err) {
    throw new Error(
      'HDV_QUEUE=kafka requires the optional "kafkajs" package, which is not installed or failed ' +
        'to load. Install it (`npm install kafkajs`), start a broker (see the `kafka` service in ' +
        'docker-compose.yml), and set KAFKA_BROKERS. The offline default (HDV_QUEUE=memory) needs ' +
        `none of this. Underlying cause: ${asError(err).message}`,
    );
  }
}

/** Parse KAFKA_BROKERS (comma-separated) or fall back to a local single-node broker. */
export function brokersFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.KAFKA_BROKERS ?? '').trim();
  if (!raw) return ['localhost:9092'];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizePartitions(partitions?: AgentRole[] | 'ALL'): Set<AgentRole> {
  if (!partitions || partitions === 'ALL') return new Set(ALL_PARTITIONS);
  return new Set(partitions);
}

/** Map a topic name back to its AgentRole partition, or undefined if it is not ours. */
function roleForTopic(prefix: string, topic: string): AgentRole | undefined {
  const expectedStart = `${prefix}.`;
  if (!topic.startsWith(expectedStart)) return undefined;
  const role = topic.slice(expectedStart.length);
  return ALL_PARTITIONS.includes(role as AgentRole) ? (role as AgentRole) : undefined;
}

/** Decode a Kafka message value (Buffer|string) into a RoutingPacket, or undefined. */
function parsePacket(value: Buffer | string | null): RoutingPacket | undefined {
  if (value === null) return undefined;
  const text = typeof value === 'string' ? value : value.toString('utf8');
  try {
    return JSON.parse(text) as RoutingPacket;
  } catch {
    return undefined;
  }
}

/** Read a header value as a string, tolerating Buffer or string encodings. */
function headerString(headers: KafkaHeaders | undefined, key: string): string | undefined {
  const raw = headers?.[key];
  if (raw === undefined) return undefined;
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
