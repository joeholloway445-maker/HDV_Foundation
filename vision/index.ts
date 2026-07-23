/**
 * vision/index.ts — public surface of the VISION action layer.
 * VISION executes; it never creates or governs, and never talks to DREAM directly.
 */
export { ExecutionEngine } from './engine.js';
export type { ExecutionReport, SandboxKind, SendViaApex, ExecutionEngineOptions } from './engine.js';

export {
  createSandboxSession,
  StubSandboxSession,
  DEFAULT_LIMITS,
} from './sandbox.js';
export type {
  SandboxSession,
  SandboxStatus,
  SandboxRunResult,
  SandboxRunner,
  SandboxSummary,
  SandboxLogLine,
  ResourceLimits,
} from './sandbox.js';

export { ToolRegistry, DEFAULT_TOOLS } from './tools.js';
export type { Tool, ToolContext, ToolResult } from './tools.js';
