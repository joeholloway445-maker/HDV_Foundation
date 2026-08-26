/**
 * workflow/index.ts — HDV workflow integration entry point.
 *
 * Exports the WorkflowGuard (KNOLL-gated workflow validator) and
 * the ApexMoERouter (model selection for AI workflow nodes).
 * These are consumed by the hdv-orchestrator's DAG executor and
 * the THE-HDV-CORE API layer.
 */
export { WorkflowGuard } from './knoll_guard.js';
export { ApexMoERouter, heuristicRoute } from './apex_router.js';
export type { RouteDecision, WorkflowValidationResult } from './types.js';
export { runVisionTask, createVisionWorkflowNode, routeVisionTask } from './vision_bridge.js';
export type { VisionTaskInput, VisionTaskResult, VisionWorkflowNode } from './vision_bridge.js';
