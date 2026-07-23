/**
 * gateway/index.ts — public surface of the HOPE HTTP API gateway (Phase 4).
 * Kept modular so the transport can be swapped without touching HOPE or the orchestrator.
 */
export { HopeGateway } from './server.js';
export type { HopeGatewayOptions, GatewayResponse } from './server.js';
