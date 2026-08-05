/**
 * companion/index.ts — public surface of companion chat (companion/).
 *
 * A thin PRODUCT surface: turn a persona + history into one in-character reply. It is NOT a
 * Big 5 agent — it never routes a RoutingPacket, never touches APEX/KNOLL/HOPE/DREAM/VISION.
 * The HOPE gateway mounts this handler as an additive, standalone route (POST
 * /v1/companion/chat), the same way market/ mounts the waitlist.
 */
export * from './types.js';
export { handleCompanionChat } from './handlers.js';
export type { CompanionResponse, CompanionChatOptions } from './handlers.js';
