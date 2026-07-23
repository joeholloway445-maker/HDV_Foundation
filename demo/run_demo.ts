/**
 * demo/run_demo.ts — end-to-end Big 5 backbone demonstration.
 *
 * Shows, in order:
 *   1. HOPE parses a natural-language request into a structured intent.
 *   2. HOPE hands intent to APEX; APEX (after KNOLL) orchestrates it to DREAM.
 *   3. DREAM simulates outcomes; results return to HOPE VIA APEX (never directly).
 *   4. The APEX ledger records cost_usd for the ephemeral execution.
 *   5. KNOLL BLOCKS an illegal direct DREAM -> VISION packet.
 *   6. KNOLL BLOCKS a packet with a tampered SHA-256 hash.
 *
 * Run: npm run demo
 */
import {
  ApexRouter,
  createPacket,
  type CreatePacketInput,
  type DispatchResult,
} from '../apex/index.js';
import { Knoll } from '../knoll/index.js';
import { IntentInterpreter } from '../hope/index.js';
import { SimulationEngine } from '../dream/index.js';
import { ExecutionEngine } from '../vision/index.js';
import { AgentRole } from '../config/routing_schema.js';
import { TOTAL_NODES, PERSONAS_PER_NODE, TOTAL_CONCEPTUAL_PARAMETERS } from '../nodes/index.js';

function hr(title: string): void {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

function main(): void {
  hr('BIG 5 MATRIX — PHASE 1 BACKBONE DEMO');
  console.log(
    `Fleet: ${TOTAL_NODES.toLocaleString()} nodes x ${PERSONAS_PER_NODE} personas ` +
      `-> ${TOTAL_CONCEPTUAL_PARAMETERS.toExponential(4)} conceptual params (~14.3 quadrillion)`,
  );

  // Always-on core: KNOLL (auditor) + APEX (router). APEX cannot route without KNOLL.
  const knoll = new Knoll();
  const router = new ApexRouter({ knoll, defaultCostUsd: 0.02 });

  // The single legal transport primitive every agent is handed: send-via-APEX.
  const sendViaApex = (input: CreatePacketInput): DispatchResult =>
    router.dispatch(createPacket(input));

  // Ephemeral agents. They return their results THROUGH APEX (never peer-to-peer).
  const dream = new SimulationEngine(sendViaApex);
  const vision = new ExecutionEngine('gvisor', sendViaApex);
  const hope = new IntentInterpreter();

  // Register inbound handlers. Agents ONLY ever receive packets from APEX.
  router.register(AgentRole.DREAM, dream.asHandler());
  router.register(AgentRole.VISION, vision.asHandler());
  router.register(AgentRole.HOPE, (packet) => {
    console.log(`   [HOPE] received result via APEX: "${packet.payload.intent}"`);
    return { acknowledged: true };
  });
  // APEX orchestration handler: takes HOPE's intent and forwards to the suggested agent.
  router.register(AgentRole.APEX, (packet) => {
    const dest = packet.payload.data.suggestedDestination;
    const destination =
      dest === AgentRole.DREAM || dest === AgentRole.VISION ? dest : AgentRole.DREAM;
    console.log(`   [APEX] orchestrating HOPE intent -> ${destination}`);
    const forwarded = sendViaApex({
      source: AgentRole.APEX,
      destination,
      intent: packet.payload.intent,
      data: packet.payload.data,
      priority: packet.header.priority,
    });
    return { forwardedTo: destination, forwardStatus: forwarded.status };
  });

  // ---------------------------------------------------------------------------
  // FLOW 1: happy path — HOPE -> APEX -> KNOLL -> DREAM -> (APEX) -> HOPE
  // ---------------------------------------------------------------------------
  hr('FLOW 1 — HOPE intent routed to DREAM (legal, via APEX + KNOLL)');
  const utterance = 'Imagine and simulate three possible outcomes for launching the product early';
  const parsed = hope.interpret(utterance);
  console.log(`[HOPE] utterance: "${utterance}"`);
  console.log(`[HOPE] parsed kind=${parsed.kind} suggestedDestination=${parsed.suggestedDestination}`);

  const submission = hope.submit(utterance, sendViaApex);
  console.log(`[APEX] HOPE->APEX dispatch status: ${submission.result.status}`);
  console.log(`[KNOLL] verdict: ${submission.result.knoll.reasoning}`);

  // ---------------------------------------------------------------------------
  // FLOW 2: illegal direct DREAM -> VISION (must be BLOCKED by KNOLL)
  // ---------------------------------------------------------------------------
  hr('FLOW 2 — illegal direct DREAM -> VISION packet (must be BLOCKED)');
  const illegal = createPacket({
    source: AgentRole.DREAM,
    destination: AgentRole.VISION,
    intent: 'hand simulation straight to execution without APEX mediation',
  });
  const illegalResult = router.dispatch(illegal);
  console.log(`[APEX] dispatch status: ${illegalResult.status}`);
  console.log(`[KNOLL] verdict: ${illegalResult.knoll.reasoning}`);
  console.log(`[KNOLL] enforced: ${illegalResult.knoll.enforcedConstraints?.join(', ')}`);
  if (illegalResult.status !== 'BLOCKED') {
    throw new Error('SECURITY FAILURE: direct DREAM->VISION was not blocked');
  }

  // ---------------------------------------------------------------------------
  // FLOW 3: tampered hash (must be BLOCKED by KNOLL)
  // ---------------------------------------------------------------------------
  hr('FLOW 3 — tampered SHA-256 hash (must be BLOCKED)');
  const tampered = createPacket({
    source: AgentRole.HOPE,
    destination: AgentRole.APEX,
    intent: 'legitimate-looking request',
  });
  // Attacker mutates the payload AFTER the hash was computed.
  (tampered.payload.data as Record<string, unknown>).injected = 'malicious-override';
  const tamperedResult = router.dispatch(tampered);
  console.log(`[APEX] dispatch status: ${tamperedResult.status}`);
  console.log(`[KNOLL] verdict: ${tamperedResult.knoll.reasoning}`);
  if (tamperedResult.status !== 'BLOCKED') {
    throw new Error('SECURITY FAILURE: tampered packet was not blocked');
  }

  // ---------------------------------------------------------------------------
  // Ledger + audit summary
  // ---------------------------------------------------------------------------
  hr('LEDGER & AUDIT SUMMARY');
  const ledger = router.ledger;
  console.log(`Ledger entries: ${ledger.entries().length}`);
  for (const e of ledger.entries()) {
    console.log(
      `  ${e.status.padEnd(7)} ${e.source} -> ${e.destination}  ` +
        `$${e.cost_usd.toFixed(6)}  [${e.knollSignature}]`,
    );
  }
  console.log(`Total billed: $${router.ledger.totalCost().toFixed(6)}`);
  const audit = router.auditTrail();
  console.log(`\nKNOLL audit entries: ${audit.length}`);
  console.log(`  ALLOWED: ${audit.filter((a) => a.outcome === 'ALLOWED').length}`);
  console.log(`  BLOCKED: ${audit.filter((a) => a.outcome === 'BLOCKED').length}`);

  hr('DEMO COMPLETE — APEX+KNOLL gate enforced; DREAM<->VISION direct blocked.');
}

main();
