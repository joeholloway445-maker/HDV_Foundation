/**
 * persistence/index.ts — public surface of the Phase 2 persistence layer.
 *
 * Repository interfaces mirror config/schema.prisma. In-memory implementations are the
 * default runtime store; APEX ledger, KNOLL audit, and HOPE's intent archive can wrap
 * these without requiring a real database. The Redis router stub is the Phase 2 task
 * queue abstraction (Kafka lands in Phase 4).
 */
export type {
  RequestLogRecord,
  NodeIdentityRecord,
  SecurityAuditRecord,
  IntentDocumentRecord,
  UserRecord,
  SessionRecord,
  RequestLogRepository,
  NodeIdentityRepository,
  SecurityAuditRepository,
  IntentArchiveRepository,
  UserRepository,
  SessionRepository,
} from './repositories.js';
export {
  InMemoryRequestLogRepository,
  InMemoryNodeIdentityRepository,
  InMemorySecurityAuditRepository,
  InMemoryIntentArchiveRepository,
  InMemoryUserRepository,
  InMemorySessionRepository,
  newRowId,
} from './repositories.js';

// Prisma-backed repositories (Phase 4 durability). These satisfy the same repository
// interfaces via a write-through cache; the in-memory implementations above remain the
// default backend. See prisma_repos.ts for the design rationale.
export {
  PrismaRequestLogRepository,
  PrismaNodeIdentityRepository,
  PrismaSecurityAuditRepository,
  PrismaIntentArchiveRepository,
  PrismaUserRepository,
  PrismaSessionRepository,
  createPrismaRepositories,
} from './prisma_repos.js';
export type { PrismaRepositoryBundle, PrismaBundleOptions } from './prisma_repos.js';

// Backend selector: createRepositories('memory' | 'prisma').
export { createRepositories } from './factory.js';
export type { RepositoryMode, RepositoryBundle } from './factory.js';

export type { TaskQueue as RedisTaskQueue, QueuedTask, DeliveredTask } from './redis_router_stub.js';
export { InMemoryRedisRouterStub } from './redis_router_stub.js';

// Phase 4: partitioned, consumer-group task queue (Kafka-shaped). The Phase 2 Redis
// stub remains for simple priority-FIFO use; the Kafka stub is the fleet-scale abstraction.
export type {
  TaskQueue,
  QueueMessage,
  DeliveredMessage,
  QueueSubscriber,
  Subscription,
  SubscribeOptions,
} from './kafka_stub.js';
export { InMemoryKafkaStub } from './kafka_stub.js';

// Phase 5 real-slice: a Kafka-backed TaskQueue over `kafkajs` (persistence/kafka_real.ts).
// `resolveQueueMode` selects the backend from HDV_QUEUE (offline in-memory default);
// `createTaskQueue` returns a ready TaskQueue for the resolved backend. The Kafka path is
// only touched when HDV_QUEUE=kafka, so the backbone stays broker- and dependency-free.
export { KafkaTaskQueue, createTaskQueue, resolveQueueMode, brokersFromEnv } from './kafka_real.js';
export type {
  QueueMode,
  KafkaTaskQueueOptions,
  KafkaSubscription,
  KafkaModuleLike,
  KafkaLike,
  ProducerLike,
  ConsumerLike,
  EachMessagePayloadLike,
  KafkaMessageLike,
  KafkaHeaders,
} from './kafka_real.js';
