/**
 * tests/hope_ui.test.ts — HOPE forward-facing console (hope/ui).
 *
 * Verifies the console's transcript behavior, the interpretation-only default (no routing),
 * optional APEX routing via an injected callback, and the rendered HTML (brand present, no
 * execution claims, input escaped). HOPE must never execute or create here.
 *
 * Run: node --import tsx --test tests/hope_ui.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentRole } from '../config/routing_schema.js';
import type { CreatePacketInput, DispatchResult } from '../apex/index.js';
import {
  HopeConsole,
  renderTranscriptToHtml,
  escapeHtml,
  type Turn,
} from '../hope/ui/index.js';

// ---------------------------------------------------------------------------
// Console transcript + interpretation-only default
// ---------------------------------------------------------------------------

test('console records user and hope turns in order', () => {
  const console_ = new HopeConsole();
  const turn = console_.say('Simulate how "Project Atlas" could launch to reach 1000 users');

  const transcript = console_.transcript();
  assert.equal(transcript.length, 2);
  assert.equal(transcript[0].role, 'user');
  assert.equal(transcript[1].role, 'hope');
  assert.equal(transcript[0].text, 'Simulate how "Project Atlas" could launch to reach 1000 users');
  assert.equal(turn.user.role, 'user');
  assert.equal(turn.hope.role, 'hope');
  assert.ok(turn.hope.text.length > 0);
});

test('console documents every intent it interprets', () => {
  const console_ = new HopeConsole();
  console_.say('simulate three outcomes for launching "Beta" early');
  console_.say('run the deployment for "Gamma"');

  assert.equal(console_.documentCount(), 2);
  assert.equal(console_.documents().length, 2);
  assert.ok(console_.documents()[0].id.startsWith('intent_'));
});

test('console is interpretation-only by default: it never routes', () => {
  const console_ = new HopeConsole();
  assert.equal(console_.canRoute, false);

  const turn = console_.say('run the deployment for "Gamma" now');
  assert.equal(turn.dispatch, undefined, 'no dispatch without an injected transport');
  assert.equal(turn.clarificationRequested, false);
});

test('console requests clarification on low-confidence input and never routes', () => {
  let calls = 0;
  const sendViaApex = (_input: CreatePacketInput): DispatchResult => {
    calls += 1;
    return okResult();
  };
  const console_ = new HopeConsole({ sendViaApex });

  const turn = console_.say('hmm');
  assert.equal(turn.clarificationRequested, true);
  assert.equal(turn.dispatch, undefined, 'clarification must not dispatch');
  assert.equal(calls, 0, 'callback must not fire when clarifying');
});

// ---------------------------------------------------------------------------
// Optional APEX routing (only when injected AND confident)
// ---------------------------------------------------------------------------

test('console routes HOPE -> APEX only when a transport is injected', () => {
  const seen: CreatePacketInput[] = [];
  const sendViaApex = (input: CreatePacketInput): DispatchResult => {
    seen.push(input);
    return okResult();
  };
  const console_ = new HopeConsole({ sendViaApex });
  assert.equal(console_.canRoute, true);

  const turn = console_.say('Simulate how "Project Atlas" could launch to reach 1000 users');
  assert.ok(turn.dispatch, 'a confident intent should dispatch when a transport exists');
  assert.equal(turn.dispatch?.status, 'SUCCESS');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].source, AgentRole.HOPE);
  assert.equal(seen[0].destination, AgentRole.APEX, 'HOPE always addresses APEX, never a peer');
});

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

test('rendered HTML is self-contained and brand-forward for HOPE', () => {
  const console_ = new HopeConsole();
  console_.say('explain how the routing works');
  const html = renderTranscriptToHtml(console_.transcript(), { canRoute: false });

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<\/html>\s*$/i);
  assert.ok(html.includes('HOPE'), 'brand mark present');
  // The full name carries an apostrophe, which is HTML-escaped in the rendered output.
  assert.ok(html.includes('Holloway'), 'full brand name present');
  assert.ok(html.includes('Providential Enterprise'), 'full brand name present');
  assert.ok(html.includes('fonts.googleapis.com'), 'distinctive typography via Google Fonts');
  assert.ok(html.includes('@keyframes breathe'), 'brand breathe motion present');
  assert.ok(html.includes('@keyframes rise'), 'fade-in turn motion present');
  assert.ok(html.includes('interpretation-only'), 'session status reflects no routing');
});

test('rendered HTML makes no first-person execution/creation claims', () => {
  const console_ = new HopeConsole();
  console_.say('run and deploy the whole pipeline immediately');
  console_.say('build me a brand new database and create the tables');
  const html = renderTranscriptToHtml(console_.transcript());

  // HOPE may say it will *ask the system to* act, but must never claim it acted itself.
  assert.doesNotMatch(html, /\bI (executed|created|built|ran|deployed|made|implemented)\b/i);
  assert.ok(
    html.includes('does not execute or create'),
    'HTML states HOPE cannot execute or create',
  );
});

test('rendered HTML escapes user-provided content', () => {
  const transcript: Turn[] = [
    { role: 'user', text: '<script>alert("xss")</script>', at: Date.now() },
    { role: 'hope', text: 'Got it.', at: Date.now() },
  ];
  const html = renderTranscriptToHtml(transcript);
  assert.ok(!html.includes('<script>alert'), 'raw script tag must not survive');
  assert.ok(html.includes('&lt;script&gt;'), 'user angle brackets are escaped');
});

test('escapeHtml escapes the five sensitive characters', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

function okResult(): DispatchResult {
  return {
    status: 'SUCCESS',
    packetId: 'pkt_test_0001',
    knoll: { isAllowed: true },
    cost_usd: 0.02,
  };
}
