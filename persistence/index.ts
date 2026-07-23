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

export type { TaskQueue, QueuedTask, DeliveredTask } from './redis_router_stub.js';
export { InMemoryRedisRouterStub } from './redis_router_stub.js';
