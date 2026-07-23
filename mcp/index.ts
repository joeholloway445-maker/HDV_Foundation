/**
 * mcp/index.ts — public surface of the MCP tool-provider front door.
 *
 * HDV exposed as a Model Context Protocol tool provider so external agents / IDEs (e.g.
 * Cursor) can drive the matrix. Like the HTTP gateway, this is a composition root: every
 * intent still flows HOPE → APEX → KNOLL → target. MCP never bypasses APEX or KNOLL.
 */
export { HdvToolProvider, TOOL_NAMES } from './tools.js';
export type {
  HdvToolProviderOptions,
  ToolDefinition,
  ToolCallResult,
  ToolName,
} from './tools.js';

export { createHdvMcpServer, startStdioServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export type { HdvMcpServerOptions } from './server.js';

export {
  estimateCost,
  modelMultiplier,
  DEFAULT_RATE_PER_BILLION_PARAM_HOUR,
  MODEL_RATE_MULTIPLIERS,
} from './estimate.js';
export type { EstimateCostInput, EstimateCostResult } from './estimate.js';

export { loadModelCatalog, BUILTIN_MODELS } from './models.js';
export type { ModelInfo, ModelCatalog } from './models.js';
