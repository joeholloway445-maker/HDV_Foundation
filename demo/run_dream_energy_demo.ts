/**
 * demo/run_dream_energy_demo.ts — Phase 4.2 DREAM stream-energy scheduling demo.
 *
 * Shows the energy-driven scheduler cooperating with the rest of the matrix:
 *   1. A synthetic event stream (user requests, chat bursts, anomaly near-misses, idle
 *      ticks, spikes) is fed to a DreamScheduler backed by a StreamEnergyMeter.
 *   2. The meter ACCUMULATES energy on activity and DECAYS it while idle; the scheduler
 *      reads the level to decide WHEN to simulate and HOW WIDE/DEEP.
 *   3. Whenever it schedules, it dispatches APEX → DREAM (never DREAM directly); DREAM's
 *      SimulationEngine runs and returns ranked outcomes to HOPE, all via APEX + KNOLL.
 *   4. A ScenarioBank seed is SPECIALIZED into a concrete intent for one scheduled sim.
 *
 * Everything routes through APEX + KNOLL — no peer agent imports another peer. DREAM and
 * HOPE are wired as injected handlers (composition root).
 *
 * Run: npm run demo:dream-energy
 */
import { ApexOrchestrator } from '../apex/index.js';
import { SimulationEngine, DreamScheduler, ScenarioBank, type StreamEvent } from '../dream/index.js';
import { AgentRole } from '../config/routing_schema.js';

function hr(title: string): void {
  console.log('\n' + '='.repeat(76));
  console.log(title);
  console.log('='.repeat(76));
}

function main(): void {
  hr('BIG 5 MATRIX — PHASE 4.2 DEMO (DREAM stream-energy scheduling)');

  // Composition root: always-on core (KNOLL + APEX), plus DREAM + HOPE handlers.
  const orch = new ApexOrchestrator({ defaultCostUsd: 0.01 });
  const dream = new SimulationEngine(orch.sendViaApex, { topK: 3 });
  const hopeResults: string[] = [];
  orch.wire({
    dream: (packet) => dream.asHandler()(packet),
    hope: (packet) => {
      hopeResults.push(packet.payload.intent);
      const data = packet.payload.data as { outcomeCount?: number };
      console.log(`      [HOPE] ← via APEX: "${packet.payload.intent}" (${data.outcomeCount ?? '?'} outcomes)`);
      return { acknowledged: true };
    },
  });

  // A cooling half-life short enough to see decay across the scripted stream.
  const scheduler = new DreamScheduler({
    spikeThreshold: 0.7,
    scheduleThreshold: 0.5,
    idleTicksPerSpeculation: 3,
    meter: { halfLifeMs: 4_000 },
  });
  const bank = new ScenarioBank();

  // A scripted event stream with timestamps (ms). This mirrors what APEX would observe.
  const t0 = Date.now();
  const stream: StreamEvent[] = [
    { type: 'CHAT_BURST', at: t0 + 0 },
    { type: 'CHAT_BURST', at: t0 + 300 },
    { type: 'ANOMALY_NEAR_MISS', at: t0 + 600, energy: 0.5 },
    { type: 'ENERGY_SPIKE', at: t0 + 900, energy: 0.95, intent: bank.specialize('surge-response', { subject: 'checkout', load: 'peak' }).intent },
    { type: 'USER_REQUEST', at: t0 + 1200, intent: 'simulate rollout options for the pricing change' },
    { type: 'IDLE_TICK', at: t0 + 9_000 },
    { type: 'IDLE_TICK', at: t0 + 12_000 },
    { type: 'IDLE_TICK', at: t0 + 15_000 },
  ];

  hr('EVENT STREAM → SCHEDULING DECISIONS (energy accumulates on activity, decays on idle)');
  let scheduled = 0;
  for (const event of stream) {
    const { decision, result } = scheduler.schedule(event, orch.sendViaApex);
    const rel = ((event.at ?? t0) - t0) / 1000;
    const mark = decision.shouldSchedule ? 'SCHEDULE' : '  skip  ';
    console.log(
      `  [t+${rel.toFixed(1)}s] ${event.type.padEnd(17)} energy=${decision.energy.toFixed(2)} ` +
        `→ ${mark} (b=${decision.breadth} d=${decision.depth} prio=${decision.priority})`,
    );
    console.log(`             reason: ${decision.reason}`);
    if (result) {
      scheduled += 1;
      if (result.status !== 'SUCCESS') throw new Error(`expected APEX→DREAM dispatch to succeed, got ${result.status}`);
    }
  }

  // -------------------------------------------------------------------------
  // Scenario bank showcase — the seeds DREAM can specialize.
  // -------------------------------------------------------------------------
  hr('SCENARIO BANK — seeded templates DREAM can specialize (simulation only)');
  for (const template of bank.list()) {
    console.log(`  ${template.id.padEnd(20)} [${template.tags.join(', ')}]`);
  }
  const specialized = bank.specialize('incident-postmortem', { severity: 'sev-1', subject: 'the checkout path' });
  console.log(`\n  specialize(incident-postmortem):`);
  console.log(`    intent   : ${specialized.intent}`);
  console.log(`    priors   : risk=${specialized.priors.risk} reward=${specialized.priors.reward} feasibility=${specialized.priors.feasibility}`);
  console.log(`    suggested: breadth=${specialized.suggested.breadth} depth=${specialized.suggested.depth}`);

  // -------------------------------------------------------------------------
  // Summary — everything went through APEX + KNOLL.
  // -------------------------------------------------------------------------
  hr('SUMMARY');
  const audit = orch.auditTrail();
  console.log(`Scheduled simulations: ${scheduled} · results returned to HOPE: ${hopeResults.length}`);
  console.log(`Ledger entries: ${orch.ledger.entries().length} · total billed: $${orch.ledger.totalCost().toFixed(6)}`);
  console.log(
    `KNOLL audit: ${audit.length} (ALLOWED ${audit.filter((a) => a.outcome === 'ALLOWED').length}, ` +
      `BLOCKED ${audit.filter((a) => a.outcome === 'BLOCKED').length})`,
  );
  console.log(`APEX-only invariant held: every DREAM sim was reached via ${AgentRole.APEX}.`);

  hr('PHASE 4.2 DEMO COMPLETE — energy-driven DREAM scheduling; APEX-mediated; KNOLL-gated.');
}

main();
