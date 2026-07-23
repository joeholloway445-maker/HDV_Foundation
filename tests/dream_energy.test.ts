/**
 * tests/dream_energy.test.ts — Phase 4.2 tests for DREAM stream-energy scheduling.
 *
 * Covers the new surface WITHOUT regressing any earlier invariant:
 *   - StreamEnergyMeter: weighted accumulation, exponential decay, floor/ceiling clamps.
 *   - DreamScheduler energy wiring: a spike triggers a schedule; building chat activity
 *     accumulates until it schedules; a quiet idle tick below threshold does NOT schedule;
 *     a warm stream defers idle speculation.
 *   - Scheduling still goes APEX → DREAM only (never DREAM directly).
 *   - ScenarioBank: seeded templates specialize with context + defaults (simulation only).
 *
 * Run: npm run test:dream-energy
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentRole } from '../config/routing_schema.js';
import type { CreatePacketInput, DispatchResult } from '../apex/index.js';
import {
  StreamEnergyMeter,
  DreamScheduler,
  ScenarioBank,
  DEFAULT_ENERGY_WEIGHTS,
} from '../dream/index.js';

const APPROX = 1e-6;

// ---------------------------------------------------------------------------
// A. StreamEnergyMeter — accumulation + decay
// ---------------------------------------------------------------------------

test('meter accumulates weighted event contributions', () => {
  const meter = new StreamEnergyMeter({ now: () => 0 });
  const after = meter.observe({ type: 'USER_REQUEST', at: 0 });
  assert.ok(Math.abs(after - DEFAULT_ENERGY_WEIGHTS.USER_REQUEST) < APPROX);
  // ENERGY_SPIKE contribution scales by the event's magnitude.
  const spike = meter.contribution({ type: 'ENERGY_SPIKE', energy: 0.5 });
  assert.ok(Math.abs(spike - DEFAULT_ENERGY_WEIGHTS.ENERGY_SPIKE * 0.5) < APPROX);
});

test('meter energy decays exponentially with elapsed time (half-life)', () => {
  let t = 1000;
  const meter = new StreamEnergyMeter({ halfLifeMs: 100, now: () => t });
  const e0 = meter.observe({ type: 'USER_REQUEST' }); // 0.5 at t=1000
  assert.ok(Math.abs(e0 - 0.5) < APPROX);

  t = 1100; // one half-life later
  assert.ok(Math.abs(meter.level() - 0.25) < APPROX, 'one half-life halves the energy');
  t = 1200; // two half-lives
  assert.ok(Math.abs(meter.level() - 0.125) < APPROX, 'two half-lives quarter the energy');

  // level() is read-only: querying does not mutate accumulated state.
  t = 1100;
  assert.ok(Math.abs(meter.level() - 0.25) < APPROX);
});

test('meter clamps to floor and ceiling', () => {
  const meter = new StreamEnergyMeter({ now: () => 0, ceiling: 1, floor: 0 });
  for (let i = 0; i < 10; i++) meter.observe({ type: 'USER_REQUEST', at: 0 });
  assert.ok(meter.level(0) <= 1, 'energy never exceeds the ceiling');
  assert.ok(Math.abs(meter.level(0) - 1) < APPROX, 'saturates at the ceiling');

  // IDLE_TICK drains but never below the floor.
  const cool = new StreamEnergyMeter({ now: () => 0, floor: 0, halfLifeMs: 1e9 });
  for (let i = 0; i < 10; i++) cool.observe({ type: 'IDLE_TICK', at: 0 });
  assert.ok(cool.level(0) >= 0, 'energy never falls below the floor');
});

// ---------------------------------------------------------------------------
// B. DreamScheduler — energy-driven scheduling decisions
// ---------------------------------------------------------------------------

test('an energy spike triggers a schedule with a wide/deep, high-priority shape', () => {
  const scheduler = new DreamScheduler({ spikeThreshold: 0.7 });
  const hot = scheduler.evaluate({ type: 'ENERGY_SPIKE', energy: 0.95, at: 1 });
  assert.equal(hot.shouldSchedule, true);
  assert.equal(hot.priority, 'CRITICAL');
  assert.ok(hot.breadth >= 4 && hot.depth >= 3, 'hot streams explore wider and deeper');

  // A weak spike stays below threshold and does not schedule.
  const cold = new DreamScheduler({ spikeThreshold: 0.7 });
  assert.equal(cold.evaluate({ type: 'ENERGY_SPIKE', energy: 0.2, at: 1 }).shouldSchedule, false);
});

test('building chat activity accumulates energy until it schedules', () => {
  const scheduler = new DreamScheduler({ scheduleThreshold: 0.5, meter: { halfLifeMs: 1e9 } });
  const decisions = [];
  for (let i = 0; i < 5; i++) decisions.push(scheduler.evaluate({ type: 'CHAT_BURST', at: i }));

  assert.equal(decisions[0].shouldSchedule, false, 'a single chat burst is not enough');
  assert.equal(decisions.at(-1)!.shouldSchedule, true, 'sustained chatter crosses the threshold');
  // Energy is monotonically non-decreasing across the burst (negligible decay).
  for (let i = 1; i < decisions.length; i++) {
    assert.ok(decisions[i].energy >= decisions[i - 1].energy - APPROX);
  }
});

test('a quiet idle tick below threshold does NOT schedule', () => {
  const scheduler = new DreamScheduler({ idleTicksPerSpeculation: 3, scheduleThreshold: 0.5 });
  // Not enough accumulated idle ticks yet.
  assert.equal(scheduler.evaluate({ type: 'IDLE_TICK', at: 0 }).shouldSchedule, false);
  assert.equal(scheduler.evaluate({ type: 'IDLE_TICK', at: 1 }).shouldSchedule, false);
  // Third quiet idle tick reaches the count at low energy → speculative background sim.
  const due = scheduler.evaluate({ type: 'IDLE_TICK', at: 2 });
  assert.equal(due.shouldSchedule, true);
  assert.equal(due.priority, 'BACKGROUND');
  assert.ok(due.energy < 0.5, 'the stream was quiet when it speculated');
});

test('idle speculation is deferred while the stream is still warm', () => {
  const scheduler = new DreamScheduler({
    idleTicksPerSpeculation: 1,
    scheduleThreshold: 0.4,
    meter: { halfLifeMs: 1e9 },
  });
  scheduler.evaluate({ type: 'USER_REQUEST', at: 0 }); // heat the stream to ~0.5
  const idle = scheduler.evaluate({ type: 'IDLE_TICK', at: 1 });
  assert.equal(idle.shouldSchedule, false, 'idle count met, but energy still above threshold');
  assert.ok(idle.energy >= 0.4);
});

test('scheduler dispatches APEX → DREAM only, never DREAM directly', () => {
  const scheduler = new DreamScheduler({ spikeThreshold: 0.7 });
  const sent: CreatePacketInput[] = [];
  const send = (input: CreatePacketInput): DispatchResult => {
    sent.push(input);
    return { status: 'SUCCESS', packetId: 'x', knoll: { isAllowed: true }, cost_usd: 0 };
  };

  const { decision, result } = scheduler.schedule(
    { type: 'ENERGY_SPIKE', energy: 0.95, intent: 'simulate surge response', at: 1 },
    send,
  );
  assert.equal(decision.shouldSchedule, true);
  assert.ok(result);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].source, AgentRole.APEX);
  assert.equal(sent[0].destination, AgentRole.DREAM);
  assert.equal(sent[0].data?.breadth, decision.breadth);
  assert.equal(sent[0].data?.eventType, 'ENERGY_SPIKE');
  assert.equal(typeof sent[0].data?.streamEnergy, 'number');

  // A below-threshold event never dispatches.
  const quiet = scheduler.schedule({ type: 'ENERGY_SPIKE', energy: 0.05, at: 2 }, send);
  assert.equal(quiet.decision.shouldSchedule, false);
  assert.equal(quiet.result, undefined);
  assert.equal(sent.length, 1, 'no extra packet sent for a quiet stream');
});

// ---------------------------------------------------------------------------
// C. ScenarioBank — seeded templates specialize (simulation only)
// ---------------------------------------------------------------------------

test('scenario bank seeds templates and specializes with context', () => {
  const bank = new ScenarioBank();
  assert.ok(bank.list().length >= 5, 'default seeds are registered');
  assert.ok(bank.has('surge-response'));

  const spec = bank.specialize('surge-response', { subject: 'checkout', load: 'peak' });
  assert.equal(spec.templateId, 'surge-response');
  assert.match(spec.intent, /checkout/);
  assert.match(spec.intent, /peak/);
  assert.ok(spec.suggested.breadth > 0 && spec.suggested.depth > 0);
  assert.ok(spec.priors.reward >= 0 && spec.priors.reward <= 1);
});

test('scenario bank falls back to template defaults for missing context', () => {
  const bank = new ScenarioBank();
  const spec = bank.specialize('surge-response', {});
  // The default subject ("the service") fills the unspecified placeholder.
  assert.match(spec.intent, /the service/);
  assert.ok(!spec.intent.includes('{'), 'no unfilled placeholders remain');
});

test('scenario bank supports tag lookup and rejects unknown ids', () => {
  const bank = new ScenarioBank();
  assert.ok(bank.byTag('ops').length >= 1);
  assert.throws(() => bank.specialize('does-not-exist', {}), /unknown scenario/);
});
