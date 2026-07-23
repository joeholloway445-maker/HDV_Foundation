/**
 * demo/run_phase4_demo.ts — Phase 4 system-composition demo.
 *
 * Boots the whole Phase 4 surface and shows it cooperating:
 *   1. PARAMETER REPORT — the 14.3Q accounting, computed (not asserted).
 *   2. ASYNC INTAKE — an intent is PUBLISHED to the partitioned task queue and drained by a
 *      consumer that dispatches it through the SAME KNOLL gate (APEX never bypassed).
 *   3. WORKER RE-INGESTION — a simulated ephemeral DREAM worker's result is re-ingested via
 *      APEX (DREAM → HOPE, legal), and an illegal DREAM → VISION re-ingestion is BLOCKED.
 *   4. HEALTH SNAPSHOT — always-on (HOPE/KNOLL/APEX) vs ephemeral (DREAM/VISION) status.
 *
 * Everything routes through APEX + KNOLL. No peer agent is imported by another peer; DREAM
 * and VISION are wired as injected handlers (composition root).
 *
 * Run: npm run demo:phase4
 */
import { ApexOrchestrator, createPacket, type DispatchResult } from '../apex/index.js';
import { IntentInterpreter, HopeVoice } from '../hope/index.js';
import { SimulationEngine } from '../dream/index.js';
import { ExecutionEngine } from '../vision/index.js';
import { AgentRole } from '../config/routing_schema.js';
import { InMemoryKafkaStub, type DeliveredMessage } from '../persistence/index.js';
import {
  parameterReport,
  computeActiveParameters,
  ALWAYS_ON_AGENTS,
  EPHEMERAL_AGENTS,
} from '../nodes/index.js';

function hr(title: string): void {
  console.log('\n' + '='.repeat(76));
  console.log(title);
  console.log('='.repeat(76));
}

function main(): void {
  hr('BIG 5 MATRIX — PHASE 4 DEMO (queue intake · worker re-ingestion · parameters · health)');

  // -------------------------------------------------------------------------
  // 1. PARAMETER REPORT — the conceptual 14.3Q, plus a small ACTIVE snapshot.
  // -------------------------------------------------------------------------
  hr('1 — PARAMETER ACCOUNTING');
  console.log(parameterReport(150));

  // -------------------------------------------------------------------------
  // Boot: always-on core (KNOLL + APEX via the orchestrator) + a Kafka-like queue.
  // -------------------------------------------------------------------------
  const queue = new InMemoryKafkaStub();
  const orch = new ApexOrchestrator({ defaultCostUsd: 0.02, queue });

  const dream = new SimulationEngine(orch.sendViaApex, { breadth: 2, depth: 1 });
  const vision = new ExecutionEngine('gvisor', orch.sendViaApex);
  const lastActive: Partial<Record<AgentRole, number>> = {};
  const hopeResults: string[] = [];
  orch.wire({
    dream: (packet) => {
      lastActive[AgentRole.DREAM] = Date.now();
      return dream.asHandler()(packet);
    },
    vision: (packet) => {
      lastActive[AgentRole.VISION] = Date.now();
      return vision.asHandler()(packet);
    },
    hope: (packet) => {
      hopeResults.push(packet.payload.intent);
      console.log(`   [HOPE] received via APEX: "${packet.payload.intent}"`);
      return { acknowledged: true };
    },
  });

  // -------------------------------------------------------------------------
  // 2. ASYNC INTAKE via the partitioned task queue (KNOLL still gates dispatch).
  // -------------------------------------------------------------------------
  hr('2 — ASYNC INTAKE THROUGH THE TASK QUEUE (Kafka-like, partitioned by AgentRole)');
  const drained: DispatchResult[] = [];
  orch.startQueueConsumer({
    group: 'apex-intake',
    onResult: (result: DispatchResult, message: DeliveredMessage) => {
      drained.push(result);
      console.log(
        `   [consumer] drained ${message.messageId.slice(0, 16)}… ` +
          `partition=${message.partition} → dispatch=${result.status}`,
      );
    },
  });

  const hope = new IntentInterpreter();
  const voice = new HopeVoice();
  const utterance = 'simulate three outcomes for launching the product early';
  const parsed = hope.interpret(utterance);
  console.log(`[HOPE] utterance: "${utterance}" (kind=${parsed.kind}, conf=${parsed.confidence})`);
  console.log(`[HOPE voice] ${voice.acknowledge(parsed)}`);
  // Publish onto the queue instead of dispatching inline. HOPE addresses APEX; the payload
  // carries the suggested destination for the orchestrator to forward (after KNOLL).
  const msg = orch.intake({
    source: AgentRole.HOPE,
    destination: AgentRole.APEX,
    intent: utterance,
    data: { kind: parsed.kind, suggestedDestination: parsed.suggestedDestination, breadth: 2, depth: 1 },
  });
  console.log(`[QUEUE] published ${msg.messageId.slice(0, 16)}… to partition ${msg.partition} (offset ${msg.offset})`);
  console.log(`[QUEUE] depth=${queue.depth()} inFlight=${queue.inFlight()} (drained synchronously by consumer)`);

  // -------------------------------------------------------------------------
  // 3. WORKER RE-INGESTION via APEX (simulated ephemeral DREAM worker result).
  // -------------------------------------------------------------------------
  hr('3 — EPHEMERAL WORKER RESULT RE-INGESTION (DREAM → APEX → HOPE, legal)');
  // Mirrors colab/05_horizontal_worker.py → WorkerReport.to_apex_payload().
  const workerActive = computeActiveParameters({ activePersonas: 100 });
  const workerPayload = {
    source: AgentRole.DREAM,
    destination: AgentRole.HOPE,
    intent: 'worker-result:simulate surge-response outcomes',
    data: {
      kind: 'WORKER_RESULT',
      agentRole: 'DREAM',
      gpuHint: 'T4',
      personaCount: 100,
      avgScore: 0.51,
      activeParameters: workerActive.activeParameters,
      ephemeral: true,
      selfTerminated: true,
    },
  };
  const reingest = orch.sendViaApex(workerPayload);
  console.log(`[APEX] worker re-ingestion status: ${reingest.status} (KNOLL: ${reingest.knoll.reasoning})`);
  if (reingest.status !== 'SUCCESS') throw new Error('worker re-ingestion (DREAM→HOPE) should be allowed');

  // The forbidden variant: a worker must NEVER hand DREAM output straight to VISION.
  const illegalWorker = createPacket({
    source: AgentRole.DREAM,
    destination: AgentRole.VISION,
    intent: 'worker-result handed straight to execution',
    data: { kind: 'WORKER_RESULT' },
  });
  const illegal = orch.router.dispatch(illegalWorker);
  console.log(`[APEX] illegal DREAM→VISION worker route status: ${illegal.status} (enforced: ${illegal.knoll.enforcedConstraints?.join(', ')})`);
  if (illegal.status !== 'BLOCKED') throw new Error('SECURITY FAILURE: DREAM→VISION worker route not blocked');

  // -------------------------------------------------------------------------
  // 4. HEALTH SNAPSHOT — always-on vs ephemeral.
  // -------------------------------------------------------------------------
  hr('4 — HEALTH SNAPSHOT');
  const now = Date.now();
  console.log('Always-on (standby):');
  for (const role of ALWAYS_ON_AGENTS) console.log(`  ${role.padEnd(6)} online`);
  console.log('Ephemeral (spun up on demand, idle between requests):');
  for (const role of EPHEMERAL_AGENTS) {
    const last = lastActive[role];
    console.log(`  ${role.padEnd(6)} idle${last ? ` (last active ${now - last}ms ago)` : ' (never run this session)'}`);
  }

  // -------------------------------------------------------------------------
  // Ledger + audit + queue summary.
  // -------------------------------------------------------------------------
  hr('LEDGER · AUDIT · QUEUE SUMMARY');
  const ledger = orch.ledger;
  const audit = orch.auditTrail();
  console.log(`Queue drained: ${drained.length} · results delivered to HOPE: ${hopeResults.length}`);
  console.log(`Ledger entries: ${ledger.entries().length} · total billed: $${ledger.totalCost().toFixed(6)}`);
  console.log(
    `KNOLL audit: ${audit.length} (ALLOWED ${audit.filter((a) => a.outcome === 'ALLOWED').length}, ` +
      `BLOCKED ${audit.filter((a) => a.outcome === 'BLOCKED').length})`,
  );
  console.log(`Queue high-water APEX partition: ${queue.highWaterMark(AgentRole.APEX)}`);

  hr('PHASE 4 DEMO COMPLETE — queue intake gated by KNOLL; DREAM↔VISION blocked; ephemeral workers re-ingested via APEX.');
}

main();
