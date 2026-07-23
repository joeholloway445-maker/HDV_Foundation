/**
 * vision/index.ts — public surface of the VISION action layer.
 * VISION executes; it never creates or governs, and never talks to DREAM directly.
 */
export { ExecutionEngine } from './engine.js';
export type { ExecutionReport, SandboxKind, SendViaApex, ExecutionEngineOptions } from './engine.js';

export {
  createSandboxSession,
  StubSandboxSession,
  SandboxManager,
  DEFAULT_LIMITS,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
} from './sandbox.js';
export type {
  SandboxSession,
  SandboxStatus,
  SandboxRunResult,
  SandboxRunner,
  SandboxSummary,
  SandboxLogLine,
  SandboxInvocation,
  SandboxHooks,
  SandboxManagerOptions,
  ResourceLimits,
} from './sandbox.js';

export { ToolRegistry, DEFAULT_TOOLS, DEFAULT_HTTP_ALLOWLIST } from './tools.js';
export type { Tool, ToolContext, ToolResult } from './tools.js';

export { ResourceMonitor, estimateCpuSeconds } from './resource_monitor.js';
export type {
  ResourceSample,
  ToolInvocationRecord,
  SessionResourceUsage,
  ResourceTotals,
} from './resource_monitor.js';
