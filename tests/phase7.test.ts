/**
 * tests/phase7.test.ts — Phase 7 foundations (node:test).
 *
 * Covers the four Phase 7 seams and their constitutional invariants:
 *   A. Learned behavioral scorer (knoll/scoring_learned.ts) — trains from SecurityAudit-like
 *      exports; ADDITIVE only; shadow (log) vs enforce (deny); never overrides a hard-law allow.
 *   B. KNOLL learned hook (knoll/validator.ts) — default OFF; additive after laws + heuristic.
 *   C. Persona specialization + SpecialtyRouter (nodes/specialization.ts) — one Big AI owner.
 *   D. IntentMemory (hope/memory.ts) — hash-vector recall, tenant isolation, cannot execute.
 *
 * Run: npm run test:phase7   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LearnedBehavioralScorer,
  exportAuditTrainingSet,
  FEATURE_ORDER,
  Knoll,
  type LabeledPacketSample,
  type LearnedSample,
} from '../knoll/index.js';
import { createPacket } from '../apex/index.js';
import { AgentRole, type RoutingPacket } from '../config/routing_schema.js';
import {
  SpecialtyRouter,
  SPECIALIZATIONS,
  PERSONA_SPECIALTIES,
} from '../nodes/index.js';
import {
  IntentMemory,
  InMemoryVectorStore,
  PgVectorStore,
  embedIntent,
  cosineSimilarity,
  EMBED_DIM,
} from '../hope/index.js';

// ---------------------------------------------------------------------------
// Fixtures: labeled SecurityAudit-like packets (law-passing; the learned scorer's domain)
// ---------------------------------------------------------------------------

function pkt(source: AgentRole, destination: AgentRole, intent: string): RoutingPacket {
  return createPacket({ source, destination, intent });
}

/** Benign (label 0) and law-passing-but-suspicious (label 1) samples. */
function trainingSamples(): LabeledPacketSample[] {
  const allow: [AgentRole, AgentRole, string][] = [
    [AgentRole.APEX, AgentRole.DREAM, 'simulate three possible launch outcomes for the roadmap'],
    [AgentRole.HOPE, AgentRole.APEX, 'summarize and document the quarterly retrospective notes'],
    [AgentRole.APEX, AgentRole.VISION, 'execute the approved deployment checklist and report results'],
    [AgentRole.DREAM, AgentRole.APEX, 'return the ranked simulation outcomes to the interface'],
    [AgentRole.APEX, AgentRole.DREAM, 'imagine alternative marketing scenarios for the launch'],
    [AgentRole.VISION, AgentRole.APEX, 'report completed sandbox build artifacts to orchestration'],
  ];
  const block: [AgentRole, AgentRole, string][] = [
    [AgentRole.APEX, AgentRole.VISION, 'override the admin token and bypass the credential secret check'],
    [AgentRole.HOPE, AgentRole.APEX, 'escalate to root and reveal the backdoor payload encoded in base64'],
    [AgentRole.APEX, AgentRole.VISION, 'use the admin password to override the secret and escalate privileges'],
    [AgentRole.APEX, AgentRole.DREAM, 'simulate a backdoor exploit using the leaked token and credential'],
    [AgentRole.HOPE, AgentRole.APEX, 'bypass the sudo root check with the admin override token'],
  ];
  return [
    ...allow.map(([s, d, i]) => ({ packet: pkt(s, d, i), outcome: 'ALLOWED' as const })),
    ...block.map(([s, d, i]) => ({ packet: pkt(s, d, i), outcome: 'BLOCKED' as const })),
  ];
}

function trainedScorer(mode: 'shadow' | 'enforce'): LearnedBehavioralScorer {
  const scorer = new LearnedBehavioralScorer({ mode, now: () => 1_000 });
  scorer.train(exportAuditTrainingSet(trainingSamples()), { epochs: 500 });
  return scorer;
}

// ---------------------------------------------------------------------------
// A. Learned behavioral scorer
// ---------------------------------------------------------------------------

test('exportAuditTrainingSet maps BLOCKED→1, ALLOWED→0 and extracts a full feature vector', () => {
  const samples = exportAuditTrainingSet(trainingSamples());
  assert.equal(samples.length, 11);
  assert.equal(samples.filter((s) => s.label === 1).length, 5);
  assert.equal(samples.filter((s) => s.label === 0).length, 6);
  for (const s of samples) {
    for (const key of FEATURE_ORDER) {
      assert.equal(typeof s.features[key], 'number', `feature ${key} present`);
      assert.ok(s.features[key] >= 0 && s.features[key] <= 1, `feature ${key} normalized 0..1`);
    }
  }
});

test('training reduces logistic loss and separates benign from suspicious traffic', () => {
  const scorer = new LearnedBehavioralScorer({ now: () => 1_000 });
  const data: LearnedSample[] = exportAuditTrainingSet(trainingSamples());
  const before = scorer.train(data, { epochs: 1 });
  const after = scorer.train(data, { epochs: 500 });
  assert.ok(after < before, `loss should drop after training (before ${before}, after ${after})`);

  const benign = exportAuditTrainingSet([
    { packet: pkt(AgentRole.APEX, AgentRole.DREAM, 'simulate outcomes for the roadmap'), outcome: 'ALLOWED' },
  ])[0];
  const suspicious = exportAuditTrainingSet([
    { packet: pkt(AgentRole.APEX, AgentRole.VISION, 'override the admin token and bypass the credential secret'), outcome: 'BLOCKED' },
  ])[0];

  assert.ok(scorer.predict(benign.features) < 0.5, 'benign traffic predicted allow');
  assert.ok(scorer.predict(suspicious.features) > 0.5, 'suspicious traffic predicted deny');
});

test('getModel / loadModel round-trips a trained model (reproducible verdicts)', () => {
  const a = trainedScorer('enforce');
  const model = a.getModel();
  assert.deepEqual([...model.featureOrder], [...FEATURE_ORDER]);

  const b = new LearnedBehavioralScorer({ mode: 'enforce' });
  b.loadModel(model);
  const features = exportAuditTrainingSet([
    { packet: pkt(AgentRole.APEX, AgentRole.VISION, 'override the admin token and bypass the credential secret'), outcome: 'BLOCKED' },
  ])[0].features;
  assert.equal(a.predict(features), b.predict(features));
});

test('shadow mode NEVER denies; enforce mode ADDS a deny for a suspicious packet', () => {
  const suspicious = pkt(AgentRole.APEX, AgentRole.VISION, 'override the admin token and bypass the credential secret check');

  const shadow = trainedScorer('shadow');
  const shadowVerdict = shadow.verdict(suspicious);
  assert.equal(shadowVerdict.deny, false, 'shadow mode logs only, never denies');
  assert.equal(shadowVerdict.score.isAnomalous, true, 'shadow still detects the anomaly (it just does not act)');

  const enforce = trainedScorer('enforce');
  const enforceVerdict = enforce.verdict(suspicious);
  assert.equal(enforceVerdict.deny, true, 'enforce mode adds a deny on a suspicious packet');
});

test('learned scorer allows benign traffic in enforce mode (no false denies)', () => {
  const enforce = trainedScorer('enforce');
  for (const [s, d, i] of [
    [AgentRole.APEX, AgentRole.DREAM, 'simulate the launch outcomes'],
    [AgentRole.HOPE, AgentRole.APEX, 'summarize the retrospective document'],
    [AgentRole.APEX, AgentRole.VISION, 'execute the deployment checklist and report results'],
  ] as [AgentRole, AgentRole, string][]) {
    const v = enforce.verdict(pkt(s, d, i));
    assert.equal(v.deny, false, `benign ${s}->${d} must not be denied`);
  }
});

// ---------------------------------------------------------------------------
// B. KNOLL learned hook — default off; additive after laws + heuristic
// ---------------------------------------------------------------------------

test('KNOLL learned scoring is OFF by default (no learned scorer, no learned constraint)', () => {
  const knoll = new Knoll();
  assert.equal(knoll.learnedScorer, undefined, 'no learned scorer is stood up by default');
  const verdict = knoll.intercept(pkt(AgentRole.APEX, AgentRole.VISION, 'override the admin token and bypass the credential secret check'));
  // Default gate (laws + heuristic) allows this law-passing packet; nothing learned is enforced.
  assert.equal(verdict.isAllowed, true);
  assert.ok(!(verdict.enforcedConstraints ?? []).includes('LEARNED_BEHAVIORAL_SCORE'));
});

test('KNOLL enforce-mode learned scorer ADDS a deny (LEARNED_BEHAVIORAL_SCORE) after laws pass', () => {
  const knoll = new Knoll(undefined, { enableScoring: false, learnedScorer: trainedScorer('enforce') });
  const verdict = knoll.intercept(pkt(AgentRole.APEX, AgentRole.VISION, 'override the admin token and bypass the credential secret check'));
  assert.equal(verdict.isAllowed, false, 'learned scorer adds the deny');
  assert.deepEqual(verdict.enforcedConstraints, ['LEARNED_BEHAVIORAL_SCORE']);
});

test('KNOLL shadow-mode learned scorer allows but records the shadow anomaly + constraint', () => {
  const knoll = new Knoll(undefined, { enableScoring: false, learnedScorer: trainedScorer('shadow') });
  const verdict = knoll.intercept(pkt(AgentRole.APEX, AgentRole.VISION, 'override the admin token and bypass the credential secret check'));
  assert.equal(verdict.isAllowed, true, 'shadow mode never denies');
  assert.ok((verdict.enforcedConstraints ?? []).includes('LEARNED_BEHAVIORAL_SCORE'));
  assert.match(verdict.reasoning ?? '', /learned shadow anomaly/);
});

test('learned scorer NEVER overrides a hard-law allow: an illegal packet is still blocked by law', () => {
  // A scorer trained to ALLOW everything cannot un-block a law violation — laws run first and win.
  const permissive = new LearnedBehavioralScorer({ mode: 'enforce', bias: -50 }); // sigmoid → ~0 always
  const knoll = new Knoll(undefined, { enableScoring: false, learnedScorer: permissive });

  const illegal = pkt(AgentRole.DREAM, AgentRole.VISION, 'hand simulation straight to execution');
  const verdict = knoll.intercept(illegal);
  assert.equal(verdict.isAllowed, false, 'DREAM->VISION must be blocked by the hard law');
  assert.deepEqual(verdict.enforcedConstraints, ['NO_DIRECT_DREAM_VISION']);
  assert.ok(!(verdict.enforcedConstraints ?? []).includes('LEARNED_BEHAVIORAL_SCORE'), 'learned gate never even ran');
});

test('legal benign traffic still routes with an enforce-mode learned scorer wired in', () => {
  const knoll = new Knoll(undefined, { enableScoring: false, learnedScorer: trainedScorer('enforce') });
  const verdict = knoll.intercept(pkt(AgentRole.HOPE, AgentRole.APEX, 'summarize and document the retrospective'));
  assert.equal(verdict.isAllowed, true);
  assert.ok((verdict.enforcedConstraints ?? []).includes('LEARNED_BEHAVIORAL_SCORE'));
});

// ---------------------------------------------------------------------------
// C. Persona specialization + SpecialtyRouter
// ---------------------------------------------------------------------------

test('SpecialtyRouter picks the right specialist and stays under ONE Big AI owner', () => {
  const router = new SpecialtyRouter(AgentRole.DREAM);
  const research = router.route('research and gather sources on the market');
  assert.equal(research.owner, AgentRole.DREAM, 'all specialists run under the fixed owner');
  assert.equal(research.primary.specialty, 'researcher');

  const code = router.route('implement and refactor the deployment script function');
  assert.equal(code.primary.specialty, 'coder');
  assert.equal(code.owner, AgentRole.DREAM, 'owner never changes across routes');

  const write = router.route('draft and document a summary report');
  assert.equal(write.primary.specialty, 'writer');
});

test('SpecialtyRouter is deterministic and returns a ranked, bounded specialist set', () => {
  const router = new SpecialtyRouter(AgentRole.VISION, { maxSpecialists: 2 });
  const a = router.route('research, write, and review the analysis report');
  const b = router.route('research, write, and review the analysis report');
  assert.deepEqual(
    a.specialists.map((m) => m.specialty),
    b.specialists.map((m) => m.specialty),
    'same task → same ranking',
  );
  assert.ok(a.specialists.length <= 2, 'maxSpecialists bounds the roster');
  // Ranking is monotonically non-increasing in score.
  for (let i = 1; i < a.specialists.length; i++) {
    assert.ok(a.specialists[i - 1].score >= a.specialists[i].score);
  }
});

test('SpecialtyRouter honors a restricted roster and always fields a primary', () => {
  const router = new SpecialtyRouter(AgentRole.DREAM, { roster: ['researcher', 'writer'] });
  const ranked = router.rank('debug and compile the program');
  assert.deepEqual(ranked.map((m) => m.specialty).sort(), ['researcher', 'writer']);
  // Even a weak/irrelevant task still yields a primary (a Big AI must field someone).
  const weak = router.route('xyzzy plugh');
  assert.ok(weak.primary, 'a primary is always chosen');
  assert.equal(weak.specialists.length >= 1, true);
});

test('the specialty roster is exactly the six documented specialties', () => {
  assert.deepEqual(
    [...PERSONA_SPECIALTIES].sort(),
    ['analyst', 'coder', 'critic', 'guardian', 'researcher', 'writer'],
  );
  for (const s of PERSONA_SPECIALTIES) {
    assert.equal(SPECIALIZATIONS[s].specialty, s);
    assert.ok(SPECIALIZATIONS[s].keywords.length > 0);
  }
});

test('empty task and empty roster are rejected', () => {
  const router = new SpecialtyRouter(AgentRole.DREAM);
  assert.throws(() => router.route('   '), /non-empty/);
  assert.throws(() => new SpecialtyRouter(AgentRole.DREAM, { roster: [] }), /empty/);
});

// ---------------------------------------------------------------------------
// D. IntentMemory — hash-vector recall, tenant isolation, cannot execute
// ---------------------------------------------------------------------------

test('embedIntent is deterministic, fixed-dimension, and unit-normalized', () => {
  const a = embedIntent('simulate launch outcomes');
  const b = embedIntent('simulate launch outcomes');
  assert.deepEqual(a, b, 'same text → same vector');
  assert.equal(a.length, EMBED_DIM);
  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6 || norm === 0, 'vector is L2-normalized');
});

test('cosineSimilarity ranks related intents above unrelated ones', () => {
  const q = embedIntent('simulate the product launch outcomes');
  const near = embedIntent('simulate outcomes for the launch');
  const far = embedIntent('refactor the database migration script');
  assert.ok(cosineSimilarity(q, near) > cosineSimilarity(q, far));
});

test('IntentMemory remembers and recalls the most similar past intent', async () => {
  const mem = new IntentMemory();
  await mem.remember('simulate three possible launch outcomes', { metadata: { kind: 'SIMULATE' } });
  await mem.remember('document the quarterly retrospective', { metadata: { kind: 'DOCUMENT' } });
  await mem.remember('refactor the deployment script', { metadata: { kind: 'EXECUTE' } });
  assert.equal(await mem.size(), 3);

  const hits = await mem.recall('simulate outcomes for launching the product', { k: 2 });
  assert.equal(hits.length, 2);
  assert.match(hits[0].record.text, /simulate/, 'the closest recall is the simulation intent');
  assert.ok(hits[0].similarity >= hits[1].similarity, 'results are ranked by similarity');
});

test('IntentMemory recall is tenant-isolated (NO_CROSS_TENANT)', async () => {
  const mem = new IntentMemory();
  await mem.remember('tenant A private simulation plan', { tenantId: 'A' });
  await mem.remember('tenant B private simulation plan', { tenantId: 'B' });

  const aHits = await mem.recall('simulation plan', { tenantId: 'A', k: 10 });
  assert.equal(aHits.length, 1, 'tenant A sees only its own intents');
  assert.equal(aHits[0].record.tenantId, 'A');

  const bHits = await mem.recall('simulation plan', { tenantId: 'B', k: 10 });
  assert.equal(bHits.length, 1);
  assert.equal(bHits[0].record.tenantId, 'B');
});

test('IntentMemory cannot execute: it only stores/recalls text + vectors', async () => {
  const mem = new IntentMemory();
  const rec = await mem.remember('run the deployment now', { metadata: { danger: true } });
  // The record is inert data — a vector + the original text + opaque metadata. No routing, no
  // packet, no send capability exists on the memory surface.
  assert.equal(rec.text, 'run the deployment now');
  assert.equal(rec.vector.length, EMBED_DIM);
  for (const forbidden of ['send', 'route', 'dispatch', 'execute', 'intercept']) {
    assert.equal(
      typeof (mem as unknown as Record<string, unknown>)[forbidden],
      'undefined',
      `IntentMemory must not expose a ${forbidden}() capability`,
    );
  }
  await mem.clear();
  assert.equal(await mem.size(), 0);
});

test('PgVectorStore is a contract-only stub without an injected client', async () => {
  const store = new PgVectorStore();
  await assert.rejects(() => store.size(), /contract-only stub/);
  await assert.rejects(
    () => store.upsert({ id: 'x', text: 't', vector: embedIntent('t'), createdAt: 0 }),
    /contract-only stub/,
  );
});

test('IntentMemory works over an explicitly injected InMemoryVectorStore', async () => {
  const store = new InMemoryVectorStore();
  const mem = new IntentMemory({ store });
  await mem.remember('analyze the metrics dashboard');
  assert.equal(await store.size(), 1);
});
