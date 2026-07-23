/**
 * demo/run_phase2_demo.ts — Phase 2/3 end-to-end demonstration.
 *
 * Uses the APEX orchestrator composition root (thin demo) and shows:
 *   1. HOPE interprets + documents an intent, and speaks with its voice.
 *   2. APEX orchestrates the intent to DREAM; ranked outcome trees return via APEX.
 *   3. APEX orchestrates a task to VISION's sandboxed tool registry; report returns via APEX.
 *   4. HOPE requests clarification on a low-confidence utterance (no dispatch).
 *   5. DREAM scheduler schedules a speculative sim on a stream ENERGY_SPIKE (via APEX).
 *   6. KNOLL BLOCKS an illegal direct DREAM -> VISION packet.
 *   7. KNOLL BLOCKS a high behavioral-anomaly packet (scoring gate, additive to the laws).
 *   8. Persistence repositories mirror the ledger + audit rows.
 *
 * Run: npm run demo:phase2
 */
import { ApexOrchestrator, createPacket } from '../apex/index.js';
import { IntentInterpreter, HopeDocumenter, HopeVoice } from '../hope/index.js';
import { SimulationEngine, DreamScheduler } from '../dream/index.js';
import { ExecutionEngine } from '../vision/index.js';
import { AgentRole } from '../config/routing_schema.js';
import {
  InMemoryRequestLogRepository,
  InMemorySecurityAuditRepository,
  InMemoryIntentArchiveRepository,
} from '../persistence/index.js';
import { TOTAL_NODES, PERSONAS_PER_NODE, TOTAL_CONCEPTUAL_PARAMETERS } from '../nodes/index.js';

function hr(title: string): void {
  console.log('\n' + '='.repeat(74));
  console.log(title);
  console.log('='.repeat(74));
}

function main(): void {
  hr('BIG 5 MATRIX — PHASE 2/3 DEMO (HOPE docs · DREAM trees · VISION tools · KNOLL scoring)');
  console.log(
    `Fleet capacity: ${TOTAL_NODES.toLocaleString()} nodes x ${PERSONAS_PER_NODE} personas ` +
      `-> ${TOTAL_CONCEPTUAL_PARAMETERS.toExponential(4)} conceptual params (~14.3 quadrillion)`,
  );

  // Persistence mirrors (in-memory; DB-ready via the persistence repository interfaces).
  const requestLog = new InMemoryRequestLogRepository();
  const securityAudit = new InMemorySecurityAuditRepository();
  const intentArchive = new InMemoryIntentArchiveRepository();

  // Composition root: the orchestrator wires KNOLL + router and owns forwarding.
  const orch = new ApexOrchestrator({ defaultCostUsd: 0.02, requestLog, securityAudit });

  // Ephemeral agents return results THROUGH APEX (never peer-to-peer). Injected as
  // handlers so the orchestrator (in apex/) never imports a peer agent module.
  const dream = new SimulationEngine(orch.sendViaApex, { breadth: 3, depth: 2, topK: 3 });
  const vision = new ExecutionEngine('gvisor', orch.sendViaApex);
  orch.wire({
    dream: dream.asHandler(),
    vision: vision.asHandler(),
    hope: (packet) => {
      console.log(`   [HOPE] received result via APEX: "${packet.payload.intent}"`);
      return { acknowledged: true };
    },
  });

  const hope = new IntentInterpreter();
  const documenter = new HopeDocumenter({ archive: intentArchive });
  const voice = new HopeVoice();

  // -------------------------------------------------------------------------
  // FLOW 1: HOPE interprets + documents + speaks, then routes SIMULATE to DREAM.
  // -------------------------------------------------------------------------
  hr('FLOW 1 — HOPE interpret + document + voice, then APEX -> DREAM');
  const utterance = 'Simulate how "Project Atlas" could launch early; I want to reach 1000 users without spending over $500';
  const intent = hope.interpret(utterance);
  const doc = documenter.document(intent);
  console.log(`[HOPE] utterance: "${utterance}"`);
  console.log(`[HOPE] kind=${intent.kind} secondary=${intent.secondaryKind ?? '-'} urgency=${intent.urgency} conf=${intent.confidence}`);
  console.log(`[HOPE] entities=${JSON.stringify(intent.entities)}`);
  console.log(`[HOPE] goals=${JSON.stringify(intent.goals)}`);
  console.log(`[HOPE] constraints=${JSON.stringify(intent.constraints)}`);
  console.log(`[HOPE] documented as ${doc.id} (archive size=${documenter.count()})`);
  console.log(`[HOPE voice] ${voice.acknowledge(intent)}`);

  const sim = hope.submit(utterance, orch.sendViaApex);
  console.log(`[APEX] HOPE->APEX status: ${sim.result?.status}`);
  console.log(`[APEX] forwarded: ${JSON.stringify(sim.result?.response)}`);

  // -------------------------------------------------------------------------
  // FLOW 2: HOPE routes an EXECUTE intent to VISION's sandboxed tool registry.
  // -------------------------------------------------------------------------
  hr('FLOW 2 — HOPE EXECUTE intent -> APEX -> VISION sandboxed tool');
  console.log(`[VISION] available tools: ${vision.availableTools().join(', ')}`);
  const execUtterance = 'run and process the data ingest now';
  const execIntent = hope.interpret(execUtterance);
  console.log(`[HOPE] kind=${execIntent.kind} -> suggestedDestination=${execIntent.suggestedDestination}`);
  // Address APEX; ride the tool + args in the payload for the orchestrator to forward.
  const execResult = orch.sendViaApex({
    source: AgentRole.HOPE,
    destination: AgentRole.APEX,
    intent: execUtterance,
    data: {
      kind: execIntent.kind,
      suggestedDestination: AgentRole.VISION,
      tool: 'data_ingest',
      args: { records: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], schema: { id: 'number', name: 'string' } },
    },
  });
  console.log(`[APEX] execute dispatch status: ${execResult.status}`);

  // -------------------------------------------------------------------------
  // FLOW 3: low-confidence utterance -> clarification (no dispatch).
  // -------------------------------------------------------------------------
  hr('FLOW 3 — low-confidence utterance triggers clarification (no execution)');
  const vague = 'hmm maybe';
  const vagueIntent = hope.interpret(vague);
  documenter.document(vagueIntent);
  const held = hope.submit(vague, orch.sendViaApex);
  console.log(`[HOPE] "${vague}" -> confidence=${vagueIntent.confidence} clarificationNeeded=${vagueIntent.clarificationNeeded}`);
  console.log(`[HOPE] dispatched? ${held.result ? 'yes' : 'no (held)'}`);
  console.log(`[HOPE voice] ${voice.clarify(vagueIntent)}`);
  console.log(`[HOPE] intents needing clarification: ${documenter.needingClarification().length}`);

  // -------------------------------------------------------------------------
  // FLOW 4: DREAM scheduler reacts to a stream ENERGY_SPIKE (via APEX only).
  // -------------------------------------------------------------------------
  hr('FLOW 4 — DREAM scheduler schedules a sim on an ENERGY_SPIKE (APEX -> DREAM)');
  const scheduler = new DreamScheduler({ spikeThreshold: 0.7 });
  const scheduled = scheduler.schedule({ type: 'ENERGY_SPIKE', energy: 0.92, intent: 'simulate surge response' }, orch.sendViaApex);
  console.log(`[SCHED] decision: ${scheduled.decision.reason} (priority=${scheduled.decision.priority}, breadth=${scheduled.decision.breadth}, depth=${scheduled.decision.depth})`);
  console.log(`[SCHED] dispatch status: ${scheduled.result?.status}`);

  // -------------------------------------------------------------------------
  // FLOW 5: illegal direct DREAM -> VISION (must be BLOCKED by KNOLL).
  // -------------------------------------------------------------------------
  hr('FLOW 5 — illegal direct DREAM -> VISION (must be BLOCKED)');
  const illegal = createPacket({ source: AgentRole.DREAM, destination: AgentRole.VISION, intent: 'hand sim straight to execution' });
  const illegalResult = orch.router.dispatch(illegal);
  console.log(`[APEX] status: ${illegalResult.status}  [KNOLL] ${illegalResult.knoll.reasoning}`);
  if (illegalResult.status !== 'BLOCKED') throw new Error('SECURITY FAILURE: DREAM->VISION not blocked');

  // -------------------------------------------------------------------------
  // FLOW 6: high behavioral-anomaly packet (scoring gate, additive to laws).
  // -------------------------------------------------------------------------
  hr('FLOW 6 — high behavioral-anomaly packet (BEHAVIORAL_SCORE gate)');
  const anomalous = createPacket({
    source: AgentRole.APEX,
    destination: AgentRole.VISION,
    intent: 'what password credential token sudo admin override bypass secret root exploit',
    priority: 'CRITICAL',
    data: { blob: 'lorem ipsum dolor sit amet '.repeat(400) },
  });
  const anomalousResult = orch.router.dispatch(anomalous);
  console.log(`[APEX] status: ${anomalousResult.status}  [KNOLL] ${anomalousResult.knoll.reasoning}`);
  console.log(`[KNOLL] enforced: ${anomalousResult.knoll.enforcedConstraints?.join(', ')}`);
  if (anomalousResult.status !== 'BLOCKED') throw new Error('SECURITY FAILURE: high-anomaly packet not blocked');

  // -------------------------------------------------------------------------
  // Ledger + audit + persistence summary
  // -------------------------------------------------------------------------
  hr('LEDGER · AUDIT · PERSISTENCE SUMMARY');
  const ledger = orch.ledger;
  console.log(`Ledger entries: ${ledger.entries().length}  total billed: $${ledger.totalCost().toFixed(6)}`);
  const audit = orch.auditTrail();
  console.log(`KNOLL audit: ${audit.length} (ALLOWED ${audit.filter((a) => a.outcome === 'ALLOWED').length}, BLOCKED ${audit.filter((a) => a.outcome === 'BLOCKED').length})`);
  console.log(`Persistence — RequestLog rows: ${requestLog.all().length}, SecurityAudit rows: ${securityAudit.all().length}, IntentDocuments: ${intentArchive.all().length}`);

  hr('PHASE 2/3 DEMO COMPLETE — APEX+KNOLL enforced; DREAM<->VISION blocked; anomalies scored.');
}

main();
