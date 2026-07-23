/**
 * tests/mcp.test.ts — the MCP tool-provider front door (mcp/).
 *
 * These tests exercise the tool HANDLERS directly (HdvToolProvider + the estimate/model
 * helpers), which is where all the behavior lives. The SDK wiring in mcp/server.ts is a thin
 * transport shim over these same handlers, so it needs no separate wire test here.
 *
 * Coverage:
 *   - tools/list: exactly the five HDV tools, each with a JSON-Schema inputSchema.
 *   - hdv_intent: interpret + route through APEX→KNOLL (ledger + audit populated), leaks no
 *     secrets, and HOLDS low-confidence intents instead of dispatching.
 *   - hdv_estimate_cost: deterministic offline math, model scaling, input validation.
 *   - hdv_health: always-on + ephemeral + matrix stats, KNOLL gate enforced.
 *   - hdv_models: offline fallback catalog (no config/models.json in the repo).
 *   - hdv_usage: read-only projection reflecting traffic this provider routed.
 *   - callTool: unknown tool + handler errors returned as isError, never thrown.
 *
 * Run: node --import tsx --test tests/mcp.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HdvToolProvider, TOOL_NAMES } from '../mcp/tools.js';
import { estimateCost, modelMultiplier } from '../mcp/estimate.js';
import { loadModelCatalog, BUILTIN_MODELS } from '../mcp/models.js';
import { MODEL_PARAMS } from '../nodes/constants.js';

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

test('listTools exposes exactly the five HDV tools with JSON-Schema inputs', () => {
  const provider = new HdvToolProvider();
  const tools = provider.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...TOOL_NAMES].sort(),
  );
  for (const t of tools) {
    assert.ok(t.description.length > 0, `${t.name} has a description`);
    assert.equal((t.inputSchema as { type: string }).type, 'object');
    assert.ok('properties' in t.inputSchema, `${t.name} inputSchema has properties`);
  }
  // hdv_intent requires an utterance.
  const intent = tools.find((t) => t.name === 'hdv_intent');
  assert.deepEqual((intent?.inputSchema as { required: string[] }).required, ['utterance']);
});

// ---------------------------------------------------------------------------
// hdv_intent — still Hope → APEX → KNOLL, no secrets
// ---------------------------------------------------------------------------

test('hdv_intent routes a confident EXECUTE intent through APEX + KNOLL', async () => {
  const provider = new HdvToolProvider();
  const res = await provider.callTool('hdv_intent', {
    utterance: 'Please run the deployment for "Gamma" now',
  });
  assert.equal(res.isError, false);
  const body = res.data;
  assert.equal(body.accepted, true);
  assert.equal(body.dispatched, true);
  assert.equal(body.routingStatus, 'SUCCESS');
  assert.equal((body.intent as { kind: string }).kind, 'EXECUTE');
  assert.equal((body.intent as { suggestedDestination: string }).suggestedDestination, 'VISION');
  // Routed via APEX → forwarded onward to VISION.
  assert.equal(body.forwardedTo, 'VISION');
  assert.ok(typeof body.voice === 'string' && (body.voice as string).length > 0);

  // KNOLL verdict summary present, and it leaks NO secrets.
  const knoll = body.knoll as Record<string, unknown>;
  assert.equal(knoll.isAllowed, true);
  assert.ok('enforcedConstraints' in knoll);
  assert.ok(!('knoll_token' in knoll) && !('hash' in knoll));

  // The route was actually gated + billed (APEX ledger + KNOLL audit populated).
  assert.ok(provider.orchestrator.ledger.entries().length >= 1);
  assert.ok(provider.orchestrator.auditTrail().length >= 1);
});

test('hdv_intent holds a low-confidence intent instead of dispatching', async () => {
  const provider = new HdvToolProvider();
  const res = await provider.callTool('hdv_intent', { utterance: 'hmm' });
  assert.equal(res.isError, false);
  assert.equal(res.data.dispatched, false);
  assert.equal(res.data.clarificationNeeded, true);
  assert.equal(res.data.knoll, null);
  assert.ok(typeof res.data.voice === 'string');
});

test('hdv_intent rejects an empty utterance as an error result (never throws)', async () => {
  const provider = new HdvToolProvider();
  const res = await provider.callTool('hdv_intent', { utterance: '   ' });
  assert.equal(res.isError, true);
  assert.match(String(res.data.error), /utterance/);
});

// ---------------------------------------------------------------------------
// hdv_estimate_cost — deterministic, offline
// ---------------------------------------------------------------------------

test('estimateCost is deterministic and uses the documented formula', () => {
  // 7B active params for 1 hour at the default local rate (×1).
  const r = estimateCost({ activeParams: 7e9, durationSec: 3600, model: 'llama-3-8b' });
  assert.equal(r.activeParams, 7e9);
  assert.equal(r.activePersonas, 1); // 7e9 / MODEL_PARAMS
  assert.equal(r.modelMultiplier, 1);
  // 7 (B) × 1 (h) × 0.0005 = 0.0035
  assert.equal(r.estimatedUsd, 0.0035);
  assert.ok(r.breakdown.includes('$0.0035'));
});

test('estimateCost scales with the model hint', () => {
  const base = estimateCost({ activeParams: 7e9, durationSec: 3600, model: 'mistral-7b' });
  const frontier = estimateCost({ activeParams: 7e9, durationSec: 3600, model: 'gpt-4o' });
  assert.ok(frontier.estimatedUsd > base.estimatedUsd);
  assert.equal(modelMultiplier('gpt-4o'), 12);
  assert.equal(modelMultiplier('stub-1'), 0.1);
  assert.equal(modelMultiplier('something-unknown'), 1);
});

test('estimateCost floors negative / non-finite inputs to zero', () => {
  const r = estimateCost({ activeParams: -5, durationSec: -1 });
  assert.equal(r.activeParams, 0);
  assert.equal(r.durationSec, 0);
  assert.equal(r.estimatedUsd, 0);
});

test('hdv_estimate_cost validates numeric inputs', async () => {
  const provider = new HdvToolProvider();
  const good = await provider.callTool('hdv_estimate_cost', { activeParams: MODEL_PARAMS, durationSec: 60 });
  assert.equal(good.isError, false);
  assert.equal(good.data.activePersonas, 1);

  const bad = await provider.callTool('hdv_estimate_cost', { activeParams: 'lots', durationSec: 60 });
  assert.equal(bad.isError, true);
  assert.match(String(bad.data.error), /numeric/);
});

// ---------------------------------------------------------------------------
// hdv_health — read-only topology + gate state
// ---------------------------------------------------------------------------

test('hdv_health reports always-on agents, ephemeral idle flags, and the KNOLL gate', async () => {
  const provider = new HdvToolProvider();
  const res = await provider.callTool('hdv_health', {});
  assert.equal(res.isError, false);
  const body = res.data;
  assert.equal(body.ok, true);
  assert.equal(body.knollGate, 'enforced');
  const alwaysOn = (body.alwaysOn as Array<{ role: string }>).map((a) => a.role).sort();
  assert.deepEqual(alwaysOn, ['APEX', 'HOPE', 'KNOLL']);
  const ephemeral = (body.ephemeral as Array<{ role: string; idle: boolean }>);
  assert.deepEqual(ephemeral.map((e) => e.role).sort(), ['DREAM', 'VISION']);
  assert.ok(ephemeral.every((e) => e.idle === true));
  const matrix = body.matrix as { totalNodes: number; totalPersonas: number };
  assert.equal(matrix.totalNodes, 20480);
  assert.equal(matrix.totalPersonas, 2_048_000);
});

// ---------------------------------------------------------------------------
// hdv_models — offline fallback catalog
// ---------------------------------------------------------------------------

test('hdv_models returns a non-empty catalog (config file when present, else offline builtins)', async () => {
  const provider = new HdvToolProvider();
  const res = await provider.callTool('hdv_models', {});
  assert.equal(res.isError, false);
  // source is 'config' when config/models.json exists, otherwise the offline 'builtin' list.
  assert.ok(res.data.source === 'config' || res.data.source === 'builtin');
  const models = res.data.models as Array<{ id: string }>;
  assert.ok(Array.isArray(models) && models.length > 0);
  assert.equal(res.data.count, models.length);
  assert.ok(models.every((m) => typeof m.id === 'string' && m.id.length > 0));
});

test('loadModelCatalog falls back to the offline builtins when the file is missing', () => {
  // Point at a file that does not exist → offline fallback, never throws.
  const catalog = loadModelCatalog('/nonexistent/models.json');
  assert.equal(catalog.source, 'builtin');
  assert.equal(catalog.models.length, BUILTIN_MODELS.length);
  assert.ok(catalog.models.some((m) => m.id === 'hdv-stub-1'));
  // Every built-in option is local / offline (no paid API required).
  assert.ok(catalog.models.every((m) => m.local === true));
});

// ---------------------------------------------------------------------------
// hdv_usage — read-only projection of routed traffic
// ---------------------------------------------------------------------------

test('hdv_usage reflects traffic routed through the same provider', async () => {
  const provider = new HdvToolProvider();
  // No traffic yet.
  const before = await provider.callTool('hdv_usage', {});
  assert.equal((before.data.ledger as { totalEntries: number }).totalEntries, 0);

  await provider.callTool('hdv_intent', { utterance: 'run the deployment for "Gamma"' });
  await provider.callTool('hdv_intent', { utterance: 'simulate three outcomes for launching "Beta"' });

  const after = await provider.callTool('hdv_usage', { limit: 5 });
  assert.equal(after.isError, false);
  const ledger = after.data.ledger as { totalEntries: number; totalBilledUsd: number; recent: unknown[] };
  assert.ok(ledger.totalEntries >= 2);
  assert.ok(ledger.totalBilledUsd > 0);
  assert.ok(Array.isArray(ledger.recent));
  const audit = after.data.audit as { total: number; allowed: number };
  assert.ok(audit.total >= 2);
  const metrics = after.data.metrics as { packets: { total: number } };
  assert.ok(metrics.packets.total >= 2);
});

// ---------------------------------------------------------------------------
// callTool dispatcher — robust to bad input
// ---------------------------------------------------------------------------

test('callTool returns an error result for an unknown tool (never throws)', async () => {
  const provider = new HdvToolProvider();
  const res = await provider.callTool('does_not_exist', {});
  assert.equal(res.isError, true);
  assert.match(String(res.data.error), /unknown tool/);
  assert.ok(Array.isArray(res.data.availableTools));
});
