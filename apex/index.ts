/**
 * apex/index.ts — public surface of the APEX orchestration layer (master router).
 * No agent may communicate with another without passing through APEX, and APEX calls
 * KNOLL before every route.
 */
export { ApexRouter } from './router.js';
export type { ApexRouterOptions, AgentHandler, DispatchResult } from './router.js';
export { InMemoryLedger } from './ledger.js';
export type { BillingLedger, LedgerEntry, LogRequestInput } from './ledger.js';
export { createPacket, isRoutingPacket, verifyPacketHash } from './packet.js';
export type { CreatePacketInput } from './packet.js';
