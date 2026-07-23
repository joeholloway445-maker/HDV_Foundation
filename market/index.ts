/**
 * market/index.ts — public surface of the launch GTM waitlist (market/).
 *
 * A thin go-to-market surface: capture inbound interest (waitlist signups) and report aggregate,
 * privacy-safe stats. It is NOT a Big 5 agent — it never routes a RoutingPacket, never touches
 * APEX/KNOLL/HOPE/DREAM/VISION, and never spends the ledger. The HOPE gateway mounts these
 * handlers as additive, standalone routes (POST /v1/waitlist, GET /v1/waitlist/stats).
 */
export * from './types.js';
export { WaitlistStore, DEFAULT_MAX_ENTRIES, normaliseEmail } from './store.js';
export type { WaitlistStoreOptions } from './store.js';
export { handleWaitlistSignup, handleWaitlistStats } from './handlers.js';
export type { MarketResponse, WaitlistSignupContext } from './handlers.js';
