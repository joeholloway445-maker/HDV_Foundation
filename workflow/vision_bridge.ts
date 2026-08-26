/**
 * workflow/vision_bridge.ts — VISION ExecutionEngine adapter for workflow DAG nodes.
 *
 * Bridges the VISION action layer (sandboxed tool execution) with the HDV workflow
 * orchestrator's node execution model. Workflow `vision` nodes call `runVisionTask()`
 * which wraps the ExecutionEngine lifecycle (start → run → stop) into a single
 * promise, returning a structured result the DAG engine can use as $output.
 *
 * The bridge also exposes `createVisionWorkflowNode()` — a factory that generates
 * a workflow node definition ready for inclusion in a ScenarioWorkflow DAG, with
 * APEX MoE routing metadata pre-populated.
 */

import { ExecutionEngine } from '../vision/index.js';
import type { ExecutionReport, SandboxKind } from '../vision/index.js';
import { heuristicRoute } from './apex_router.js';
import { WorkflowGuard } from './knoll_guard.js';
import type { RouteDecision, WorkflowValidationResult } from './types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VisionTaskInput {
  intent: string;
  tool?: string;
  params?: Record<string, unknown>;
  sandbox?: SandboxKind;
  category?: string;
  budgetTier?: 'low' | 'medium' | 'high';
  userId?: string;
}

export interface VisionTaskResult {
  ok: boolean;
  report?: ExecutionReport;
  moeModel: string;
  moeCategory: string;
  knollValidation: WorkflowValidationResult;
  error?: string;
}

export interface VisionWorkflowNode {
  id: string;
  type: 'vision';
  data: {
    nodeType: 'vision';
    label: string;
    intent: string;
    tool: string;
    category: string;
    budgetTier: string;
    moeModel: string;
    sandbox: SandboxKind;
    params: Record<string, unknown>;
  };
}

// ── KNOLL-gated VISION task runner ────────────────────────────────────────────

const _defaultEngine = new ExecutionEngine('gvisor');

/**
 * Run a VISION execution task inside a workflow node context.
 *
 * 1. KNOLL validates the payload first (forbidden keys, SSRF, size)
 * 2. APEX selects the model for logging / downstream billing
 * 3. VISION ExecutionEngine runs the sandboxed tool invocation
 */
export async function runVisionTask(
  input: VisionTaskInput,
  engine?: ExecutionEngine,
): Promise<VisionTaskResult> {
  const guard = new WorkflowGuard();

  // KNOLL gate
  const knollValidation = guard.validate(
    { nodes: [] },
    {
      intent: input.intent,
      tool: input.tool,
      params: input.params ?? {},
      userId: input.userId,
    },
  );

  if (!knollValidation.allowed) {
    return {
      ok: false,
      moeModel: '',
      moeCategory: input.category ?? 'general',
      knollValidation,
      error: `KNOLL blocked: ${knollValidation.violations.join('; ')}`,
    };
  }

  // APEX routing (for billing metadata)
  const moeModel = heuristicRoute(
    input.intent,
    input.category ?? 'general',
    input.budgetTier ?? 'medium',
  );

  // VISION execution
  const exec = engine ?? _defaultEngine;
  try {
    const report = exec.execute(input.intent, { tool: input.tool ?? 'bash', ...(input.params ?? {}) });
    return {
      ok: report.ok,
      report,
      moeModel,
      moeCategory: input.category ?? 'general',
      knollValidation,
      ...(report.ok ? {} : { error: `Exit code ${report.exitCode}` }),
    };
  } catch (err) {
    return {
      ok: false,
      moeModel,
      moeCategory: input.category ?? 'general',
      knollValidation,
      error: err instanceof Error ? err.message : 'Vision execution failed',
    };
  }
}

// ── Workflow node factory ─────────────────────────────────────────────────────

/**
 * Generate a VISION workflow node for insertion into a ScenarioWorkflow DAG.
 * Includes APEX MoE routing metadata for the orchestrator's billing layer.
 */
export function createVisionWorkflowNode(
  id: string,
  input: VisionTaskInput,
): VisionWorkflowNode {
  const moeModel = heuristicRoute(
    input.intent,
    input.category ?? 'general',
    input.budgetTier ?? 'medium',
  );

  return {
    id,
    type: 'vision',
    data: {
      nodeType: 'vision',
      label: input.intent.slice(0, 60),
      intent: input.intent,
      tool: input.tool ?? 'bash',
      category: input.category ?? 'general',
      budgetTier: input.budgetTier ?? 'medium',
      moeModel,
      sandbox: input.sandbox ?? 'gvisor',
      params: input.params ?? {},
    },
  };
}

// ── Route decision helper ─────────────────────────────────────────────────────

/** Get a full RouteDecision for a VISION task without running it. */
export function routeVisionTask(
  intent: string,
  category = 'general',
  budgetTier: 'low' | 'medium' | 'high' = 'medium',
): RouteDecision {
  const model = heuristicRoute(intent, category, budgetTier);
  return {
    model,
    category,
    budgetTier,
    routedByApex: false,
    reasoning: `VISION bridge: category=${category} budget=${budgetTier} → ${model}`,
  };
}
