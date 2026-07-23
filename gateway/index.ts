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
  defaultLogger,
  DEFAULT_RATE_LIMIT,
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
