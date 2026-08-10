/**
 * gateway/index.ts — public surface of the HOPE HTTP API gateway (Phase 4).
 * Kept modular so the transport can be swapped without touching HOPE or the orchestrator.
 */
export { HopeGateway } from './server.js';
export type { HopeGatewayOptions, GatewayResponse } from './server.js';
export {
  GatewayMiddleware,
  RateLimiter,
  resolveSecurityConfig,
  extractKey,
  keysMatch,
  clientIp,
  tenantFromHeaders,
  rawTenantId,
  defaultLogger,
  DEFAULT_RATE_LIMIT,
  DEFAULT_AUTH_RATE_LIMIT,
  DEFAULT_TENANT_RATE_LIMIT,
  RATE_LIMIT_WINDOW_MS,
  DEFAULT_CORS_ORIGIN,
} from './middleware.js';
export type {
  GatewaySecurityConfig,
  SecurityOverrides,
  GuardRequest,
  GuardOutcome,
  LogEntry,
  GatewayLogger,
} from './middleware.js';
export { runDeepHealthChecks, DEFAULT_DEEP_HEALTH_TIMEOUT_MS } from './deep_health.js';
export type { DeepHealthOptions, DeepHealthReport, DeepHealthChecks, DeepCheckResult, ProbeResult } from './deep_health.js';
