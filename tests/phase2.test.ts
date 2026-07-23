/**
 * tests/phase2.test.ts — Phase 2 tests (HOPE docs, DREAM sim, KNOLL scoring, persistence,
 * nodes scaling, APEX orchestration). Extends the Phase 1 backbone; never regresses it.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentRole } from '../config/routing_schema.js';
import {
  ApexRouter,
  ApexOrchestrator,
  InMemoryLedger,
  createPacket,
  type CreatePacketInput,
  type DispatchResult,
} from '../apex/index.js';
import { Knoll, SecurityAuditLog, BehavioralScorer } from '../knoll/index.js';
import { IntentInterpreter, HopeDocumenter, HopeVoice } from '../hope/index.js';
import { SimulationEngine, DreamScheduler } from '../dream/index.js';
import {
  SubManagerOrchestrator,
  NodeFleet,
  runPersonaPipeline,
} from '../nodes/index.js';
import {
  InMemoryRequestLogRepository,
  InMemorySecurityAuditRepository,
  InMemoryIntentArchiveRepository,
  InMemoryRedisRouterStub,
} from '../persistence/index.js';

// ---------------------------------------------------------------------------
// A. HOPE — richer parsing, documentation, clarification, voice
// ---------------------------------------------------------------------------

test('HOPE extracts entities, goals, and constraints from an utterance', () => {
  const hope = new IntentInterpreter();
  const intent = hope.interpret(
    'Simulate how "Project Atlas" could launch, I want to reach 1000 users without spending over $500',
  );
  assert.equal(intent.kind, 'SIMULATE');
  assert.ok(intent.entities.includes('Project Atlas'), 'quoted entity extracted');
  assert.ok(intent.goals.length > 0, 'at least one goal extracted');
  assert.ok(intent.constraints.length > 0, 'at least one constraint extracted');
  assert.equal(intent.clarificationNeeded, false);
});

test('HOPE detects urgency and multi-intent', () => {
  const hope = new IntentInterpreter();
  const intent = hope.interpret('urgently simulate the rollout and then run the deployment');
  assert.equal(intent.urgency, 'HIGH');
  assert.ok(intent.kind === 'SIMULATE' || intent.kind === 'EXECUTE');
  assert.ok(intent.secondaryKind, 'a secondary intent should be recognized');
});

test('HOPE documents intent into the archive and can retrieve it', () => {
  const archive = new InMemoryIntentArchiveRepository();
  const documenter = new HopeDocumenter({ archive });
  const hope = new IntentInterpreter();
  const intent = hope.interpret('simulate three outcomes for launching "Beta" early');
  const doc = documenter.document(intent);
  assert.ok(doc.id.startsWith('intent_'));
  assert.equal(documenter.count(), 1);
  assert.equal(documenter.get(doc.id)?.utterance, intent.intent);
  assert.equal(archive.all().length, 1, 'archive repository received the row');
});

test('HOPE requests clarification and holds dispatch when confidence is low', () => {
  const hope = new IntentInterpreter();
  const documenter = new HopeDocumenter();
  const voice = new HopeVoice();
  const intent = hope.interpret('hmm');
  assert.equal(intent.clarificationNeeded, true);
  const doc = documenter.document(intent);
  assert.equal(documenter.needingClarification().length, 1);
  assert.ok(doc.clarificationNeeded);

  // submit() must NOT dispatch a low-confidence intent (no execution/creation).
  let sent = 0;
  const send = (_input: CreatePacketInput): DispatchResult => {
    sent += 1;
    return { status: 'SUCCESS', packetId: 'x', knoll: { isAllowed: true }, cost_usd: 0 };
  };
  const { result } = hope.submit('hmm', send);
  assert.equal(result, undefined, 'clarification-needed intent is held, not dispatched');
  assert.equal(sent, 0);

  const ack = voice.clarify(intent);
  assert.ok(ack.length > 0 && /clarif|detail|rephrase|tell me/i.test(ack));
});

test('HOPE voice acknowledges and surfaces denials without executing', () => {
  const voice = new HopeVoice();
  const hope = new IntentInterpreter();
  const intent = hope.interpret('simulate the outcomes for the launch plan');
  assert.ok(voice.acknowledge(intent).length > 0);
  assert.match(voice.deny('blocked by policy X'), /blocked by policy/i);
});

// ---------------------------------------------------------------------------
// B. DREAM — multi-branch outcome trees + ranking
// ---------------------------------------------------------------------------

test('DREAM produces a ranked outcome tree with risk/reward/feasibility', () => {
  const dream = new SimulationEngine();
  const result = dream.simulate('launch the product early', {}, { breadth: 3, depth: 2, topK: 3 });
  // breadth 3, depth 2 → 3 + 9 = 12 outcomes; personaCount matches.
  assert.equal(result.outcomes.length, 12);
  assert.equal(result.personaCount, 12);
  assert.equal(result.tree.children.length, 3, 'root has breadth children');
  assert.equal(result.ranked.length, 3, 'topK ranked outcomes');
  assert.ok(result.pareto.length >= 1, 'a non-empty Pareto frontier');
  for (const o of result.outcomes) {
    assert.ok(o.risk >= 0 && o.risk <= 1);
    assert.ok(o.reward >= 0 && o.reward <= 1);
    assert.ok(o.feasibility >= 0 && o.feasibility <= 1);
  }
  // ranked is sorted by combined desirability (descending).
  for (let i = 1; i < result.ranked.length; i++) {
    const prev = result.ranked[i - 1];
    const cur = result.ranked[i];
    const s = (o: (typeof result.ranked)[number]) => o.reward * o.feasibility * (1 - o.risk);
    assert.ok(s(prev) >= s(cur), 'ranked outcomes are in descending score order');
  }
});

test('DREAM scheduler schedules via APEX only, honoring event energy', () => {
  const scheduler = new DreamScheduler({ spikeThreshold: 0.7 });
  assert.equal(scheduler.evaluate({ type: 'ENERGY_SPIKE', energy: 0.9 }).shouldSchedule, true);
  assert.equal(scheduler.evaluate({ type: 'ENERGY_SPIKE', energy: 0.2 }).shouldSchedule, false);
  assert.equal(scheduler.evaluate({ type: 'USER_REQUEST' }).shouldSchedule, true);

  const sent: CreatePacketInput[] = [];
  const send = (input: CreatePacketInput): DispatchResult => {
    sent.push(input);
    return { status: 'SUCCESS', packetId: 'x', knoll: { isAllowed: true }, cost_usd: 0 };
  };
  const { result } = scheduler.schedule({ type: 'USER_REQUEST', intent: 'sim' }, send);
  assert.ok(result);
  assert.equal(sent.length, 1);
  // The scheduler dispatches APEX -> DREAM; DREAM is never reached directly.
  assert.equal(sent[0].source, AgentRole.APEX);
  assert.equal(sent[0].destination, AgentRole.DREAM);
});

// ---------------------------------------------------------------------------
// E. KNOLL — behavioral scoring (additive to the six laws)
// ---------------------------------------------------------------------------

function craftAnomalousPacket() {
  return createPacket({
    source: AgentRole.APEX,
    destination: AgentRole.VISION,
    intent: 'what password credential token sudo admin override bypass secret root exploit',
    priority: 'CRITICAL',
    data: { blob: 'lorem ipsum dolor sit amet '.repeat(400) },
  });
}

test('BehavioralScorer flags a crafted high-anomaly packet as anomalous', () => {
  const scorer = new BehavioralScorer();
  const score = scorer.score(craftAnomalousPacket());
  assert.ok(score.score >= score.threshold, `expected anomalous score, got ${score.score}`);
  assert.equal(score.isAnomalous, true);
});

test('BehavioralScorer leaves benign traffic well below threshold', () => {
  const scorer = new BehavioralScorer();
  const benign = createPacket({
    source: AgentRole.APEX,
    destination: AgentRole.DREAM,
    intent: 'simulate outcomes for the plan',
  });
  const score = scorer.score(benign);
  assert.equal(score.isAnomalous, false);
  assert.ok(score.score < score.threshold);
});

test('KNOLL blocks a high-anomaly packet with BEHAVIORAL_SCORE (laws still first)', () => {
  const knoll = new Knoll();
  const verdict = knoll.intercept(craftAnomalousPacket());
  assert.equal(verdict.isAllowed, false);
  assert.deepEqual(verdict.enforcedConstraints, ['BEHAVIORAL_SCORE']);
});

test('KNOLL still allows benign traffic with scoring enabled', () => {
  const knoll = new Knoll();
  const benign = createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'simulate the plan' });
  const verdict = knoll.intercept(benign);
  assert.equal(verdict.isAllowed, true);
  assert.ok(verdict.enforcedConstraints?.includes('BEHAVIORAL_SCORE'));
});

test('KNOLL laws-only mode (enableScoring:false) matches Phase 1 behavior', () => {
  const knoll = new Knoll(undefined, { enableScoring: false });
  const verdict = knoll.intercept(craftAnomalousPacket());
  // With scoring off, the crafted packet passes (it breaks no hard law).
  assert.equal(verdict.isAllowed, true);
  assert.equal(knoll.scorer, undefined);
});

// ---------------------------------------------------------------------------
// D. Persistence — repos record RequestLog / SecurityAudit
// ---------------------------------------------------------------------------

test('persistence repositories record ledger and audit rows', () => {
  const requestLog = new InMemoryRequestLogRepository();
  const securityAudit = new InMemorySecurityAuditRepository();
  const ledger = new InMemoryLedger({ repository: requestLog });
  const knoll = new Knoll(new SecurityAuditLog({ repository: securityAudit }));
  const router = new ApexRouter({ knoll, ledger, defaultCostUsd: 0.03 });
  router.register(AgentRole.DREAM, () => ({ ok: true }));

  const pkt = createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'simulate the plan' });
  const result = router.dispatch(pkt);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(requestLog.countByStatus('SUCCESS'), 1, 'RequestLog repo recorded a SUCCESS row');
  assert.equal(requestLog.findByPacketId(pkt.header.packetId)?.destination, AgentRole.DREAM);
  assert.ok(securityAudit.all().length >= 1, 'SecurityAudit repo recorded a verdict');
});

test('DREAM->VISION and HOPE->DREAM/VISION are still blocked (invariants hold)', () => {
  const knoll = new Knoll();
  assert.equal(knoll.intercept(createPacket({ source: AgentRole.DREAM, destination: AgentRole.VISION, intent: 'x' })).isAllowed, false);
  assert.equal(knoll.intercept(createPacket({ source: AgentRole.VISION, destination: AgentRole.DREAM, intent: 'x' })).isAllowed, false);
  assert.equal(knoll.intercept(createPacket({ source: AgentRole.HOPE, destination: AgentRole.DREAM, intent: 'go' })).isAllowed, false);
  assert.equal(knoll.intercept(createPacket({ source: AgentRole.HOPE, destination: AgentRole.VISION, intent: 'go' })).isAllowed, false);
});

// ---------------------------------------------------------------------------
// G. Nodes — SubManager orchestration, fleet lifecycle, pipeline
// ---------------------------------------------------------------------------

test('SubManagerOrchestrator respects the 64/64 invariants and lifecycle', () => {
  const orch = new SubManagerOrchestrator(AgentRole.DREAM, true);
  const activated = orch.activateManagers(100); // clamp to 64
  assert.equal(activated.length, 64);
  assert.equal(orch.activeManagerCount(), 64);
  const node = orch.materializeNode(0, 0);
  assert.equal(node.status, 'ACTIVE');
  assert.equal(orch.activeNodeCount(), 1);
  assert.throws(() => orch.materializeNode(0, 64), /out of range/);
  orch.releaseManager(0);
  // ephemeral → manager terminated, its nodes released.
  assert.ok(orch.activeManagerCount() <= 63);
});

test('NodeFleet keeps idle cost near zero and releases ephemeral identities', () => {
  const fleet = new NodeFleet();
  assert.equal(fleet.liveCount(), 0, 'empty fleet materializes nothing');
  assert.equal(fleet.capacity, 20480);
  const n = fleet.materialize(AgentRole.DREAM, 0, 0, true);
  assert.equal(fleet.activeCount(), 1);
  fleet.release(n.node_id);
  // ephemeral identity released back to the pool.
  assert.equal(fleet.liveCount(), 0);
});

test('runPersonaPipeline runs researcher -> writer -> critic within one Big AI', () => {
  const result = runPersonaPipeline(AgentRole.DREAM, 'draft a launch brief');
  assert.deepEqual(result.stages.map((s) => s.role), ['researcher', 'writer', 'critic']);
  assert.equal(result.personaCount, 3);
  assert.ok(result.finalScore >= 0 && result.finalScore <= 1);
});

// ---------------------------------------------------------------------------
// Persistence — Redis router stub (task queue)
// ---------------------------------------------------------------------------

test('Redis router stub enqueues, dequeues by priority, and acks', () => {
  const q = new InMemoryRedisRouterStub();
  const bg = createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'bg', priority: 'BACKGROUND' });
  const crit = createPacket({ source: AgentRole.APEX, destination: AgentRole.DREAM, intent: 'crit', priority: 'CRITICAL' });
  q.enqueue(bg);
  q.enqueue(crit);
  assert.equal(q.depth(), 2);
  const first = q.dequeue();
  assert.equal(first?.priority, 'CRITICAL', 'CRITICAL dequeues before BACKGROUND');
  assert.equal(q.inFlight(), 1);
  assert.equal(q.ack(first!.taskId), true);
  assert.equal(q.inFlight(), 0);
});

// ---------------------------------------------------------------------------
// F. APEX orchestrator — end-to-end SIMULATE + EXECUTE paths
// ---------------------------------------------------------------------------

test('ApexOrchestrator routes a SIMULATE intent HOPE -> APEX -> DREAM -> HOPE', () => {
  const orch = new ApexOrchestrator({ defaultCostUsd: 0.02 });
  const dream = new SimulationEngine(orch.sendViaApex, { breadth: 2, depth: 1 });
  const hopeResults: string[] = [];
  orch.wire({
    dream: dream.asHandler(),
    hope: (packet) => {
      hopeResults.push(packet.payload.intent);
      return { acknowledged: true };
    },
  });

  const hope = new IntentInterpreter();
  const { intent, result } = hope.submit('simulate three outcomes for the launch', orch.sendViaApex);
  assert.equal(intent.kind, 'SIMULATE');
  assert.ok(result, 'a confident intent dispatches');
  assert.equal(result!.status, 'SUCCESS');
  assert.ok(hopeResults.some((i) => i.startsWith('simulation-result:')), 'DREAM result returned to HOPE via APEX');
});

test('ApexOrchestrator routes an EXECUTE intent HOPE -> APEX -> VISION -> HOPE (DI, no peer imports)', () => {
  const orch = new ApexOrchestrator({ defaultCostUsd: 0.02 });
  // Inject a minimal VISION-like handler via DI (orchestrator never imports vision).
  const executed: string[] = [];
  orch.wire({
    vision: (packet) => {
      executed.push(packet.payload.intent);
      orch.sendViaApex({
        source: AgentRole.VISION,
        destination: AgentRole.HOPE,
        intent: `execution-result:${packet.payload.intent}`,
        data: { ok: true },
        priority: packet.header.priority,
      });
      return { ok: true };
    },
    hope: () => ({ acknowledged: true }),
  });

  const hope = new IntentInterpreter();
  const { intent, result } = hope.submit('run and deploy the build now', orch.sendViaApex);
  assert.equal(intent.kind, 'EXECUTE');
  assert.equal(result!.status, 'SUCCESS');
  assert.equal(executed.length, 1, 'VISION executed exactly once via APEX');
});

test('ApexOrchestrator pipeline helper runs a persona chain under one owner', () => {
  const orch = new ApexOrchestrator();
  const pipe = orch.runPipeline(AgentRole.VISION, 'implement the endpoint');
  assert.equal(pipe.owner, AgentRole.VISION);
  assert.equal(pipe.stages.length, 3);
});
