/**
 * companion/index.ts — public surface of companion chat (companion/).
 *
 * A thin PRODUCT surface: turn a persona + history into one in-character reply. It is NOT a
 * Big 5 agent — it never routes a RoutingPacket, never touches APEX/KNOLL/HOPE/DREAM/VISION.
 * The HOPE gateway mounts this handler as an additive, standalone route (POST
 * /v1/companion/chat), the same way market/ mounts the waitlist. handleCompanionChatStream is
 * the token-by-token twin, mounted at POST /v1/companion/chat/stream (Server-Sent Events).
 */
export * from './types.js';
export { handleCompanionChat, handleCompanionChatStream } from './handlers.js';
export type { CompanionResponse, CompanionChatOptions, CompanionChatStreamEvents } from './handlers.js';

export { buildMemoryContext, updateMemoryAfterTurn, defaultCompanionMemory } from './memory.js';

export {
  parsePortraitRequest,
  PortraitValidationError,
  type PortraitPersona,
  type PortraitStyle,
  type PortraitRequestInput,
} from './portrait_types.js';
export { handlePortraitRequest } from './portrait_handlers.js';
export type { PortraitResponse, PortraitOptions } from './portrait_handlers.js';

export {
  parseSceneRequest,
  SceneValidationError,
  type ScenePersona,
  type SceneRequestInput,
} from './scene_types.js';
export { handleSceneRequest } from './scene_handlers.js';
export type { SceneResponse, SceneOptions } from './scene_handlers.js';
export { buildActionString } from './action_string.js';

export {
  parseSpeakRequest,
  SpeakValidationError,
  type SpeakRequestInput,
} from './speak_types.js';
export { handleSpeakRequest } from './speak_handlers.js';
export type { SpeakResponse, SpeakOptions } from './speak_handlers.js';
