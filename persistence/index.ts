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
  RequestLogRepository,
  NodeIdentityRepository,
  SecurityAuditRepository,
  IntentArchiveRepository,
} from './repositories.js';
export {
  InMemoryRequestLogRepository,
  InMemoryNodeIdentityRepository,
  InMemorySecurityAuditRepository,
  InMemoryIntentArchiveRepository,
  newRowId,
} from './repositories.js';

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
