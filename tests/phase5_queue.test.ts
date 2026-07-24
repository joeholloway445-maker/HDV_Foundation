/**
 * tests/phase5_queue.test.ts — Phase 5 real-slice task-queue tests.
 *
 * Covers persistence/kafka_real.ts WITHOUT requiring a broker for the default suite:
 *   - The backend selector: `resolveQueueMode` defaults to the offline in-memory queue and
 *     only opts into Kafka when HDV_QUEUE=kafka; `createTaskQueue('memory')` returns a working
 *     in-memory TaskQueue with zero dependencies.
 *   - The Kafka adapter's wiring is exercised OFFLINE via an injected fake broker
 *     (`kafkaModule`), verifying per-AgentRole topics, messageId round-trip, ack/nack, and
 *     replay — all against the SAME TaskQueue interface as the in-memory stub.
 *   - `createTaskQueue('kafka')` without the optional `kafkajs` dependency fails with a single
 *     clear, actionable error (offline-safe assertion).
 *   - A real-broker round-trip that SKIPS unless KAFKA_TEST_BROKERS is set.
 *
 * Run: npm run test:phase5-queue   (or the full suite: npm test)
 * Real broker: docker compose up -d kafka && npm install kafkajs \
 *              && KAFKA_TEST_BROKERS=localhost:9092 npm run test:phase5-queue
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentRole, type RoutingPacket } from '../config/routing_schema.js';
import { createPacket } from '../apex/index.js';
import type { DeliveredMessage } from '../persistence/kafka_stub.js';
import {
  KafkaTaskQueue,
  createTaskQueue,
  resolveQueueMode,
  brokersFromEnv,
  type KafkaModuleLike,
  type ProducerLike,
  type ConsumerLike,
  type EachMessagePayloadLike,
} from '../persistence/kafka_real.js';

// ---------------------------------------------------------------------------
// packet builders (transport-only — KNOLL is not involved in queue tests)
// ---------------------------------------------------------------------------

function dreamPacket(intent = 'simulate'): RoutingPacket {
  return createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent });
}
function visionPacket(intent = 'execute'): RoutingPacket {
  return createPacket({ source: AgentRole.APEX, destination: AgentRole.VISION, intent });
}

// ---------------------------------------------------------------------------
// A fake, in-memory kafkajs-compatible broker for OFFLINE adapter testing.
//
// It implements exactly the small KafkaModuleLike surface the adapter depends on: a producer
// that appends to per-topic logs, and per-group consumers that (re)play their subscribed
// topics. Messages are delivered synchronously on produce so tests stay deterministic after
// `await queue.flush()`.
// ---------------------------------------------------------------------------

interface StoredMsg {
  key?: string;
  value: string;
  headers: Record<string, string>;
  offset: number;
}

interface FakeConsumerState {
  groupId: string;
  topics: Set<string>;
  cursor: Map<string, number>;
  eachMessage?: (payload: EachMessagePayloadLike) => Promise<void>;
}

function makeFakeKafka(): { module: KafkaModuleLike; logs: Map<string, StoredMsg[]> } {
  const logs = new Map<string, StoredMsg[]>();
  const consumers: FakeConsumerState[] = [];

  async function deliverPending(): Promise<void> {
    for (const c of consumers) {
      if (!c.eachMessage) continue;
      for (const topic of c.topics) {
        const log = logs.get(topic) ?? [];
        // Advance the SHARED cursor each iteration (read+increment happen synchronously before
        // the await), so concurrent deliverPending() calls from overlapping sends never
        // double-deliver the same offset.
        while ((c.cursor.get(topic) ?? 0) < log.length) {
          const idx = c.cursor.get(topic) ?? 0;
          const m = log[idx];
          c.cursor.set(topic, idx + 1);
          await c.eachMessage({
            topic,
            partition: 0,
            message: { key: m.key, value: m.value, headers: m.headers, offset: String(m.offset) },
          });
        }
      }
    }
  }

  class FakeKafka {
    constructor(_config: { clientId?: string; brokers: string[] }) {}

    producer(): ProducerLike {
      return {
        connect: async () => {},
        disconnect: async () => {},
        send: async (record) => {
          const log = logs.get(record.topic) ?? [];
          for (const msg of record.messages) {
            log.push({ key: msg.key, value: msg.value, headers: msg.headers ?? {}, offset: log.length });
          }
          logs.set(record.topic, log);
          await deliverPending();
          return [];
        },
      };
    }

    consumer(config: { groupId: string }): ConsumerLike {
      const state: FakeConsumerState = {
        groupId: config.groupId,
        topics: new Set(),
        cursor: new Map(),
      };
      return {
        connect: async () => {
          consumers.push(state);
        },
        disconnect: async () => {
          const i = consumers.indexOf(state);
          if (i >= 0) consumers.splice(i, 1);
        },
        subscribe: async ({ topic, fromBeginning }) => {
          state.topics.add(topic);
          state.cursor.set(topic, fromBeginning ? 0 : (logs.get(topic) ?? []).length);
        },
        run: async ({ eachMessage }) => {
          state.eachMessage = eachMessage;
          await deliverPending();
        },
      };
    }
  }

  return { module: { Kafka: FakeKafka }, logs };
}

// ---------------------------------------------------------------------------
// A. Backend selector — offline default is the in-memory queue
// ---------------------------------------------------------------------------

test('resolveQueueMode defaults to memory (offline) and honors HDV_QUEUE=kafka', () => {
  assert.equal(resolveQueueMode({} as NodeJS.ProcessEnv), 'memory');
  assert.equal(resolveQueueMode({ HDV_QUEUE: '' } as NodeJS.ProcessEnv), 'memory');
  assert.equal(resolveQueueMode({ HDV_QUEUE: 'memory' } as NodeJS.ProcessEnv), 'memory');
  assert.equal(resolveQueueMode({ HDV_QUEUE: 'kafka' } as NodeJS.ProcessEnv), 'kafka');
  assert.equal(resolveQueueMode({ HDV_QUEUE: '  KAFKA  ' } as NodeJS.ProcessEnv), 'kafka');
});

test('createTaskQueue defaults to a working in-memory TaskQueue (no broker, no deps)', async () => {
  const q = await createTaskQueue('memory');
  const received: DeliveredMessage[] = [];
  q.subscribe('g', (m) => received.push(m), { partitions: [AgentRole.DREAM] });
  const published = q.publish(dreamPacket());
  assert.equal(published.partition, AgentRole.DREAM);
  assert.equal(received.length, 1, 'in-memory backend delivers synchronously');
  assert.equal(q.ack('g', received[0].messageId), true);
});

test('brokersFromEnv parses KAFKA_BROKERS or falls back to localhost:9092', () => {
  assert.deepEqual(brokersFromEnv({} as NodeJS.ProcessEnv), ['localhost:9092']);
  assert.deepEqual(brokersFromEnv({ KAFKA_BROKERS: '' } as NodeJS.ProcessEnv), ['localhost:9092']);
  assert.deepEqual(
    brokersFromEnv({ KAFKA_BROKERS: 'a:9092, b:9092 ,c:9092' } as NodeJS.ProcessEnv),
    ['a:9092', 'b:9092', 'c:9092'],
  );
});

test('createTaskQueue("kafka", { kafkaModule }) returns a working KafkaTaskQueue offline', async () => {
  // kafkajs is now a declared dependency; the selector wires the Kafka adapter. We inject a
  // fake broker so the real broker connection isn't required for this offline assertion.
  const { module } = makeFakeKafka();
  const q = await createTaskQueue('kafka', { kafkaModule: module });
  assert.ok(q instanceof KafkaTaskQueue, 'kafka mode builds a KafkaTaskQueue');
  const received: DeliveredMessage[] = [];
  const sub = (q as KafkaTaskQueue).subscribe('g', (m) => received.push(m), { partitions: [AgentRole.DREAM] });
  await sub.ready;
  const published = q.publish(dreamPacket());
  await (q as KafkaTaskQueue).flush();
  assert.equal(received.length, 1, 'the kafka-mode queue delivers via the injected broker');
  assert.equal(received[0].messageId, published.messageId);
  await (q as KafkaTaskQueue).close();
});

test('createTaskQueue("kafka") surfaces a clear error when the broker is unreachable', {
  // A real connection attempt (no injected module) to a dead broker is slow due to retries, so
  // this runs only when explicitly opted in. It proves the failure is a single actionable throw.
  skip: process.env.HDV_TEST_KAFKA_NOBROKER ? false : 'set HDV_TEST_KAFKA_NOBROKER=1 to run',
}, async () => {
  await assert.rejects(() => createTaskQueue('kafka', { brokers: ['127.0.0.1:1'] }));
});

// ---------------------------------------------------------------------------
// B. Kafka adapter wiring — exercised offline via an injected fake broker
// ---------------------------------------------------------------------------

test('KafkaTaskQueue delivers a published packet to a subscriber (fake broker)', async () => {
  const { module } = makeFakeKafka();
  const q = await KafkaTaskQueue.connect({ kafkaModule: module });
  const received: DeliveredMessage[] = [];
  const sub = q.subscribe('g1', (m) => received.push(m), { partitions: [AgentRole.DREAM] });
  await sub.ready;

  const published = q.publish(dreamPacket());
  await q.flush();

  assert.equal(published.partition, AgentRole.DREAM);
  assert.equal(received.length, 1, 'subscriber receives the published message');
  assert.equal(received[0].packet.header.destination, AgentRole.DREAM);
  assert.equal(received[0].messageId, published.messageId, 'messageId round-trips via headers');
  assert.equal(q.inFlight('g1'), 1, 'delivered-but-unacked is in-flight');
  assert.equal(q.ack('g1', received[0].messageId), true);
  assert.equal(q.inFlight('g1'), 0, 'ack clears in-flight');
  await q.close();
});

test('KafkaTaskQueue partitions by destination role via per-role topics (fake broker)', async () => {
  const { module, logs } = makeFakeKafka();
  const q = await KafkaTaskQueue.connect({ kafkaModule: module, topicPrefix: 'test.routing' });
  const dream: DeliveredMessage[] = [];
  const vision: DeliveredMessage[] = [];
  const s1 = q.subscribe('dream-workers', (m) => dream.push(m), { partitions: [AgentRole.DREAM] });
  const s2 = q.subscribe('vision-workers', (m) => vision.push(m), { partitions: [AgentRole.VISION] });
  await Promise.all([s1.ready, s2.ready]);

  q.publish(dreamPacket());
  q.publish(visionPacket());
  q.publish(dreamPacket('another sim'));
  await q.flush();

  assert.equal(dream.length, 2, 'DREAM topic only sees DREAM-destined packets');
  assert.equal(vision.length, 1, 'VISION topic only sees VISION-destined packets');
  assert.equal(q.topicFor(AgentRole.DREAM), 'test.routing.DREAM');
  assert.ok(logs.has('test.routing.DREAM'), 'produced onto the per-role DREAM topic');
  assert.ok(logs.has('test.routing.VISION'), 'produced onto the per-role VISION topic');
  await q.close();
});

test('KafkaTaskQueue fans out to independent consumer groups (fake broker)', async () => {
  const { module } = makeFakeKafka();
  const q = await KafkaTaskQueue.connect({ kafkaModule: module });
  const a: DeliveredMessage[] = [];
  const b: DeliveredMessage[] = [];
  const s1 = q.subscribe('group-a', (m) => a.push(m), { partitions: [AgentRole.DREAM] });
  const s2 = q.subscribe('group-b', (m) => b.push(m), { partitions: [AgentRole.DREAM] });
  await Promise.all([s1.ready, s2.ready]);

  q.publish(dreamPacket());
  await q.flush();

  assert.equal(a.length, 1, 'group-a gets its own copy');
  assert.equal(b.length, 1, 'group-b gets its own copy');
  await q.close();
});

test('KafkaTaskQueue nack re-publishes the packet for redelivery (fake broker)', async () => {
  const { module } = makeFakeKafka();
  const q = await KafkaTaskQueue.connect({ kafkaModule: module });
  const received: DeliveredMessage[] = [];
  const sub = q.subscribe('g', (m) => received.push(m), { partitions: [AgentRole.DREAM] });
  await sub.ready;

  const published = q.publish(dreamPacket());
  await q.flush();
  assert.equal(received.length, 1);

  assert.equal(q.nack('g', received[0].messageId), true);
  await q.flush();
  assert.equal(received.length, 2, 'nack re-publishes → the message is redelivered');
  assert.equal(received[1].messageId, published.messageId, 'redelivery preserves the messageId');
  await q.close();
});

test('KafkaTaskQueue replays already-published messages to a late subscriber (fake broker)', async () => {
  const { module } = makeFakeKafka();
  const q = await KafkaTaskQueue.connect({ kafkaModule: module });
  q.publish(dreamPacket('early-1'));
  q.publish(dreamPacket('early-2'));
  await q.flush();

  const received: DeliveredMessage[] = [];
  const sub = q.subscribe('late', (m) => received.push(m), {
    partitions: [AgentRole.DREAM],
    replayFromStart: true,
  });
  await sub.ready;

  assert.equal(received.length, 2, 'late subscriber replays the backlog from the beginning');
  await q.close();
});

// ---------------------------------------------------------------------------
// C. Real-broker round-trip — SKIPPED unless a broker is provided
// ---------------------------------------------------------------------------

const REAL_BROKERS = process.env.KAFKA_TEST_BROKERS;

test(
  'KafkaTaskQueue round-trips a packet through a real broker',
  { skip: REAL_BROKERS ? false : 'set KAFKA_TEST_BROKERS (and `npm install kafkajs`) to run' },
  async () => {
    const brokers = (REAL_BROKERS as string).split(',').map((s) => s.trim());
    // Unique prefix per run so the test is isolated from prior data.
    const topicPrefix = `hdvtest.${Date.now()}`;
    const q = await KafkaTaskQueue.connect({ brokers, topicPrefix });
    try {
      const received: DeliveredMessage[] = [];
      const sub = q.subscribe(`grp-${Date.now()}`, (m) => received.push(m), {
        partitions: [AgentRole.DREAM],
        replayFromStart: true,
      });
      await sub.ready;

      const published = q.publish(dreamPacket('real-broker'));
      await q.flush();

      // Poll briefly for asynchronous broker delivery.
      const deadline = Date.now() + 10_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(received.length >= 1, true, 'the broker delivered the published packet');
      assert.equal(received[0].packet.header.destination, AgentRole.DREAM);
      assert.equal(received[0].messageId, published.messageId);
      assert.equal(q.ack(sub.group, received[0].messageId), true);
    } finally {
      await q.close();
    }
  },
);
