/**
 * tests/workflow_integration.test.ts — HDV workflow integration unit tests.
 *
 * Tests the WorkflowGuard (KNOLL gating) and ApexMoERouter (model routing)
 * without any network calls or database connections.
 *
 * Run: node --import tsx --test tests/workflow_integration.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowGuard } from '../workflow/knoll_guard.js';
import { ApexMoERouter, heuristicRoute } from '../workflow/apex_router.js';
import { createVisionWorkflowNode, routeVisionTask } from '../workflow/vision_bridge.js';

// ────────────────────────────────────────────────────────────────────────────
// WorkflowGuard (KNOLL) tests
// ────────────────────────────────────────────────────────────────────────────

describe('WorkflowGuard — KNOLL workflow validation', () => {
  const guard = new WorkflowGuard();

  test('allows clean workflow and trigger data', () => {
    const result = guard.validate(
      { nodes: [{ id: 'n1', type: 'set', data: { nodeType: 'set' } }] },
      { userId: 'user1', action: 'run' },
    );
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.violations.length, 0);
    assert.ok(result.knollAuditId, 'should have audit ID');
  });

  test('blocks trigger data with password key', () => {
    const result = guard.validate(
      { nodes: [] },
      { password: 'hunter2', userId: 'u1' },
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.violations.some((v) => v.includes('Forbidden keys')));
  });

  test('blocks trigger data with secret key (nested)', () => {
    const result = guard.validate(
      { nodes: [] },
      { config: { secret: 'abc123' } },
    );
    assert.strictEqual(result.allowed, false);
  });

  test('blocks SSRF URL in trigger data', () => {
    const result = guard.validate(
      { nodes: [] },
      { callback: 'http://localhost:8080/admin' },
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.violations.some((v) => v.includes('SSRF')));
  });

  test('blocks 10.x.x.x SSRF in nested trigger data', () => {
    const result = guard.validate(
      { nodes: [] },
      { step: { url: 'http://10.0.0.1/api/secret' } },
    );
    assert.strictEqual(result.allowed, false);
  });

  test('allows external URL (not SSRF)', () => {
    const result = guard.validate(
      { nodes: [] },
      { url: 'https://api.anthropic.com/v1/messages' },
    );
    assert.strictEqual(result.allowed, true);
  });

  test('blocks oversized payload', () => {
    const smallGuard = new WorkflowGuard({ maxPayloadKb: 1 });
    const bigData = { data: 'x'.repeat(2000) };
    const result = smallGuard.validate({ nodes: [] }, bigData);
    assert.strictEqual(result.allowed, false);
    assert.ok(result.violations.some((v) => v.includes('KB')));
  });

  test('blocks too many nodes', () => {
    const smallGuard = new WorkflowGuard({ maxNodes: 3 });
    const nodes = [1, 2, 3, 4].map((i) => ({ id: `n${i}`, type: 'set', data: { nodeType: 'set' } }));
    const result = smallGuard.validate({ nodes }, {});
    assert.strictEqual(result.allowed, false);
    assert.ok(result.violations.some((v) => v.includes('nodes')));
  });

  test('blocks unknown node types by default', () => {
    const result = guard.validate(
      { nodes: [{ id: 'n1', type: 'dangerousHack', data: { nodeType: 'dangerousHack' } }] },
      {},
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.violations.some((v) => v.includes('Unknown node types')));
  });

  test('allows unknown node types when opted in', () => {
    const permissiveGuard = new WorkflowGuard({ allowUnknownNodeTypes: true });
    const result = permissiveGuard.validate(
      { nodes: [{ id: 'n1', type: 'customNode', data: { nodeType: 'customNode' } }] },
      {},
    );
    assert.strictEqual(result.allowed, true);
  });

  test('blocks cross-tenant data mismatch', () => {
    const result = guard.validate(
      { nodes: [] },
      { tenantId: 'tenant-B', data: 'payload' },
      'tenant-A',
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.violations.some((v) => v.includes('Cross-tenant')));
  });

  test('allows matching tenantId', () => {
    const result = guard.validate(
      { nodes: [] },
      { tenantId: 'tenant-A', data: 'payload' },
      'tenant-A',
    );
    assert.strictEqual(result.allowed, true);
  });

  test('allows HDV Big Five node types (apex, knoll, dream)', () => {
    const nodes = [
      { id: 'n1', type: 'knoll', data: { nodeType: 'knoll' } },
      { id: 'n2', type: 'apex', data: { nodeType: 'apex' } },
      { id: 'n3', type: 'dream', data: { nodeType: 'dream' } },
    ];
    const result = guard.validate({ nodes }, {});
    assert.strictEqual(result.allowed, true);
  });

  test('audit result always has knollAuditId and timestamp', () => {
    const result = guard.validate({ nodes: [] }, {});
    assert.ok(typeof result.knollAuditId === 'string' && result.knollAuditId.length > 0);
    assert.ok(typeof result.timestamp === 'string' && result.timestamp.length > 0);
  });

  test('multiple violations accumulate', () => {
    const result = guard.validate(
      { nodes: [] },
      { password: 'x', callback: 'http://127.0.0.1/admin' },
    );
    assert.ok(result.violations.length >= 2, `expected 2+ violations, got ${result.violations.length}`);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ApexMoERouter — heuristic routing tests
// ────────────────────────────────────────────────────────────────────────────

describe('ApexMoERouter — heuristic routing', () => {
  const router = new ApexMoERouter(); // no remote endpoint → pure heuristic

  test('security/high → opus', async () => {
    const decision = await router.route('audit this config', 'security', 'high');
    assert.strictEqual(decision.model, 'claude-opus-5');
    assert.strictEqual(decision.routedByApex, false);
  });

  test('code/low → haiku', async () => {
    const decision = await router.route('fix this bug', 'code', 'low');
    assert.strictEqual(decision.model, 'claude-haiku-4-5-20251001');
  });

  test('creative/high → fable', async () => {
    const decision = await router.route('write a story', 'creative', 'high');
    assert.strictEqual(decision.model, 'claude-fable-5');
  });

  test('vision/any → sonnet', async () => {
    const decision = await router.route('describe this image', 'vision', 'low');
    assert.strictEqual(decision.model, 'claude-sonnet-5');
  });

  test('chat/low → haiku', async () => {
    const decision = await router.route('hello', 'chat', 'low');
    assert.strictEqual(decision.model, 'claude-haiku-4-5-20251001');
  });

  test('intent keyword "audit" → opus', async () => {
    const decision = await router.route('audit all security policies', 'general', 'medium');
    assert.strictEqual(decision.model, 'claude-opus-5');
  });

  test('intent keyword "dream" → fable', async () => {
    const decision = await router.route('dream up a scenario', 'general', 'medium');
    assert.strictEqual(decision.model, 'claude-fable-5');
  });

  test('intent keyword "debug" → sonnet', async () => {
    const decision = await router.route('debug this code path', 'general', 'medium');
    assert.strictEqual(decision.model, 'claude-sonnet-5');
  });

  test('heuristicRoute pure function matches router', async () => {
    const direct = heuristicRoute('fix bug', 'code', 'medium');
    const routed = await router.route('fix bug', 'code', 'medium');
    assert.strictEqual(direct, routed.model);
  });

  test('decision always has reasoning string', async () => {
    const decision = await router.route('something', 'general', 'medium');
    assert.ok(typeof decision.reasoning === 'string' && decision.reasoning.length > 0);
  });

  test('analysis/medium → sonnet', async () => {
    const decision = await router.route('analyze trends', 'analysis', 'medium');
    assert.strictEqual(decision.model, 'claude-sonnet-5');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// VisionBridge — createVisionWorkflowNode and routeVisionTask
// ────────────────────────────────────────────────────────────────────────────

describe('VisionBridge — node factory and route helper', () => {
  test('createVisionWorkflowNode returns correct structure', () => {
    const node = createVisionWorkflowNode('n1', {
      intent: 'scan logs for anomalies',
      tool: 'bash',
      category: 'security',
      budgetTier: 'high',
    });
    assert.strictEqual(node.id, 'n1');
    assert.strictEqual(node.type, 'vision');
    assert.strictEqual(node.data.nodeType, 'vision');
    assert.strictEqual(node.data.intent, 'scan logs for anomalies');
    assert.strictEqual(node.data.tool, 'bash');
    assert.strictEqual(node.data.category, 'security');
    assert.strictEqual(node.data.budgetTier, 'high');
    assert.strictEqual(node.data.moeModel, 'claude-opus-5');
  });

  test('createVisionWorkflowNode defaults tool to bash and sandbox to gvisor', () => {
    const node = createVisionWorkflowNode('n2', { intent: 'hello world' });
    assert.strictEqual(node.data.tool, 'bash');
    assert.strictEqual(node.data.sandbox, 'gvisor');
    assert.strictEqual(node.data.category, 'general');
    assert.strictEqual(node.data.budgetTier, 'medium');
  });

  test('createVisionWorkflowNode truncates label to 60 chars', () => {
    const longIntent = 'a'.repeat(100);
    const node = createVisionWorkflowNode('n3', { intent: longIntent });
    assert.strictEqual(node.data.label.length, 60);
  });

  test('createVisionWorkflowNode label matches short intent verbatim', () => {
    const node = createVisionWorkflowNode('n4', { intent: 'short intent' });
    assert.strictEqual(node.data.label, 'short intent');
  });

  test('createVisionWorkflowNode stores params', () => {
    const params = { threshold: 0.9, maxRetries: 3 };
    const node = createVisionWorkflowNode('n5', { intent: 'run check', params });
    assert.deepStrictEqual(node.data.params, params);
  });

  test('createVisionWorkflowNode creative/high → fable', () => {
    const node = createVisionWorkflowNode('n6', {
      intent: 'write a story',
      category: 'creative',
      budgetTier: 'high',
    });
    assert.strictEqual(node.data.moeModel, 'claude-fable-5');
  });

  test('routeVisionTask returns RouteDecision with correct fields', () => {
    const decision = routeVisionTask('audit this', 'security', 'high');
    assert.strictEqual(decision.model, 'claude-opus-5');
    assert.strictEqual(decision.category, 'security');
    assert.strictEqual(decision.budgetTier, 'high');
    assert.strictEqual(decision.routedByApex, false);
    assert.ok(typeof decision.reasoning === 'string' && decision.reasoning.length > 0);
  });

  test('routeVisionTask reasoning includes VISION bridge prefix', () => {
    const decision = routeVisionTask('write a story', 'creative', 'high');
    assert.ok(decision.reasoning.startsWith('VISION bridge'));
  });

  test('routeVisionTask defaults to general/medium', () => {
    const decision = routeVisionTask('do something');
    assert.strictEqual(decision.category, 'general');
    assert.strictEqual(decision.budgetTier, 'medium');
  });

  test('routeVisionTask creative/high → fable', () => {
    const decision = routeVisionTask('dream up a world', 'creative', 'high');
    assert.strictEqual(decision.model, 'claude-fable-5');
  });

  test('routeVisionTask vision/low → sonnet', () => {
    const decision = routeVisionTask('describe this image', 'vision', 'low');
    assert.strictEqual(decision.model, 'claude-sonnet-5');
  });

  test('routeVisionTask code/low → haiku', () => {
    const decision = routeVisionTask('fix this bug', 'code', 'low');
    assert.strictEqual(decision.model, 'claude-haiku-4-5-20251001');
  });
});
