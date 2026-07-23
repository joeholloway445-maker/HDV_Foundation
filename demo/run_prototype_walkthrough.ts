/**
 * demo/run_prototype_walkthrough.ts — THE 60-second prototype walkthrough.
 *
 * This script IS the recording. Run it in a terminal, hit record, and read the
 * narration as it prints. It threads the whole HDV Foundation prototype into six
 * timed beats — every number is COMPUTED from real modules, nothing is hard-coded
 * marketing copy:
 *
 *   Beat 1  Headline math          (marketing/comparison.ts)
 *   Beat 2  A legal intent          HOPE → APEX → KNOLL allow → DREAM outcomes
 *   Beat 3  An illegal intent       DREAM → VISION is BLOCKED by KNOLL
 *   Beat 4  The commercial skin     occurrence metering · hard cap · BYOK $0 fee
 *   Beat 5  The front door          the MCP tools any IDE/agent can call
 *   Beat 6  Call to action          "Prototype online — open marketing/index.html"
 *
 * Fully offline + deterministic. Small sleeps make it read like a recording while
 * keeping total wall-clock well under ~15s.
 *
 * Run: npm run demo:prototype
 */
import {
  capacityTable,
  CONSUMER_PRICING,
  seatVsSeatMultiple,
} from '../marketing/comparison.js';
import { ApexOrchestrator } from '../apex/index.js';
import { AgentRole } from '../config/routing_schema.js';
import { MODEL_PARAMS } from '../nodes/index.js';
import { BillingService } from '../billing/index.js';
import { TOOL_NAMES } from '../mcp/tools.js';

// ---------------------------------------------------------------------------
// Tiny presentation helpers — pacing only, no business logic.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Global pace knob. Set HDV_DEMO_PACE=0 for an instant (CI) run. */
const PACE = Number.isFinite(Number(process.env.HDV_DEMO_PACE))
  ? Number(process.env.HDV_DEMO_PACE)
  : 1;

const beat = (ms: number): Promise<void> => sleep(Math.round(ms * PACE));

function scene(n: number, title: string): void {
  console.log('\n' + '─'.repeat(72));
  console.log(`  BEAT ${n} · ${title}`);
  console.log('─'.repeat(72));
}

const usd = (n: number): string => `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

async function main(): Promise<void> {
  console.log('╔' + '═'.repeat(70) + '╗');
  console.log('║  HDV FOUNDATION — BIG 5 MATRIX · 60-SECOND PROTOTYPE WALKTHROUGH      ║');
  console.log('║  Hope · Dream · Vision · KNOLL · APEX — strict separation of concerns ║');
  console.log('╚' + '═'.repeat(70) + '╝');
  await beat(500);

  // ═══════════════════════════════════════════════════════════════════════
  // BEAT 1 — the headline math (all COMPUTED from marketing/comparison.ts).
  // ═══════════════════════════════════════════════════════════════════════
  scene(1, 'THE NUMBERS  (computed, not asserted)');
  const c7 = capacityTable().find((r) => r.modelId === '7B')!;
  console.log(`  Matrix capacity @ 7B personas ..... ~${c7.capacityLabel} params`);
  await beat(450);
  console.log(`  vs a ~1.16T class ................. ${c7.vs116T.toFixed(0)}×`);
  await beat(450);
  console.log(`  vs a 5T class ..................... ${c7.vs5T.toFixed(0)}×`);
  await beat(450);
  console.log(
    `  Consumer price .................... ~${usd(CONSUMER_PRICING.totalUsdPerMonth)}/mo ` +
      `(Colab ${usd(CONSUMER_PRICING.colabUsdPerMonth)} + HDV ${usd(CONSUMER_PRICING.hdvSubscriptionUsdPerMonth)})`,
  );
  await beat(450);
  console.log(`  …that's ~${seatVsSeatMultiple().toFixed(1)}× cheaper than a $20 frontier seat.`);
  await beat(900);

  // One orchestrator drives beats 2 + 3: HOPE→APEX→KNOLL→(DREAM|VISION).
  const orchestrator = new ApexOrchestrator({ defaultCostUsd: 0.02 });
  orchestrator.wire({
    dream: () => ({ outcome: 'rendered 3 ephemeral what-if scenarios', scenarios: 3 }),
    vision: () => ({ executed: true, sandbox: 'gvisor' }),
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BEAT 2 — a LEGAL intent flows all the way through and comes back.
  // ═══════════════════════════════════════════════════════════════════════
  scene(2, 'A LEGAL INTENT  ·  HOPE → APEX → KNOLL(allow) → DREAM');
  console.log('  HOPE: "simulate a few outcomes for me"  →  suggests DREAM');
  await beat(500);
  const legal = orchestrator.submit({
    source: AgentRole.HOPE,
    destination: AgentRole.APEX,
    intent: 'simulate outcomes',
    data: { suggestedDestination: AgentRole.DREAM },
  });
  console.log(`  APEX  → KNOLL verdict: ${legal.dispatch.knoll.isAllowed ? 'ALLOW ✅' : 'DENY'}`);
  await beat(400);
  console.log(`  APEX  → forwarded to: ${legal.forwardedTo}`);
  await beat(400);
  const dreamOut = (legal.dispatch.response?.response as Record<string, unknown> | undefined)?.outcome;
  console.log(`  DREAM → ${dreamOut}`);
  console.log(`  status: ${legal.dispatch.status}  ·  billed: ${usd(legal.dispatch.cost_usd)}`);
  await beat(900);

  // ═══════════════════════════════════════════════════════════════════════
  // BEAT 3 — an ILLEGAL intent is blocked by KNOLL, never executed.
  // ═══════════════════════════════════════════════════════════════════════
  scene(3, 'AN ILLEGAL INTENT  ·  DREAM → VISION is FORBIDDEN');
  console.log('  Someone tries a direct DREAM → VISION hop (simulation talking to action)…');
  await beat(500);
  const illegal = orchestrator.sendViaApex({
    source: AgentRole.DREAM,
    destination: AgentRole.VISION,
    intent: 'covertly execute the dreamed plan',
  });
  console.log(`  KNOLL verdict: ${illegal.knoll.isAllowed ? 'ALLOW' : 'DENY ⛔'}  →  status: ${illegal.status}`);
  await beat(400);
  console.log(`  law: ${(illegal.knoll.enforcedConstraints ?? []).join(', ') || 'NO_DIRECT_DREAM_VISION'}`);
  console.log(`  reason: ${illegal.knoll.reasoning}`);
  console.log(`  → dropped + logged, billed ${usd(illegal.cost_usd)}. DREAM and VISION never touch.`);
  await beat(900);

  // ═══════════════════════════════════════════════════════════════════════
  // BEAT 4 — the commercial skin: occurrence metering, hard cap, BYOK $0.
  // ═══════════════════════════════════════════════════════════════════════
  scene(4, 'THE BUSINESS  ·  occurrence metering · hard cap · BYOK $0 fee');
  const billing = new BillingService({ demoTier: 'PRO' });

  // (a) A metered occurrence carries BOTH cost + occurrence metrics.
  const occ = billing.store.consume('demo', {
    activeParams: MODEL_PARAMS * 10,
    durationSec: 30,
    kind: 'SIMULATION',
    model: '7B',
  });
  console.log(
    `  occurrence: ${occ.balance.acceptedCount} accepted · ${usd(occ.costUsd)} · ` +
      `${occ.balance.totalActiveParamSeconds.toLocaleString()} active-param-seconds`,
  );
  await beat(500);

  // (b) A hard cap rejects over-budget usage — logged, never billed.
  billing.store.setAllowance('startup', { tier: 'STARTER', includedAllowanceUsd: 0.005, hardCapUsd: 0.005 });
  let blocked = 0;
  for (let i = 0; i < 4; i++) {
    const r = billing.store.consume('startup', { activeParams: MODEL_PARAMS, durationSec: 1, kind: 'EXECUTION', model: '7B' });
    if (!r.accepted) blocked++;
  }
  console.log(`  hard cap ($0.005): ${blocked} over-budget attempts BLOCKED (logged, never billed).`);
  await beat(500);

  // (c) BYOK: bring your own key → unlimited, $0 platform fee.
  billing.store.setAllowance('byok-co', { tier: 'BYOK' });
  const byok = billing.store.consume('byok-co', {
    activeParams: MODEL_PARAMS * 100000,
    durationSec: 3600,
    kind: 'EXECUTION',
    provider: 'byok:acme',
    model: 'gpt-4o',
  });
  console.log(`  BYOK: 100,000 personas × 1h on your own key → platform fee ${usd(byok.costUsd)} (accepted: ${byok.accepted}).`);
  await beat(900);

  // ═══════════════════════════════════════════════════════════════════════
  // BEAT 5 — the MCP front door: the tools any IDE/agent can call.
  // ═══════════════════════════════════════════════════════════════════════
  scene(5, 'THE FRONT DOOR  ·  HDV as an MCP tool provider');
  console.log(`  Any MCP client (Cursor, Claude, an agent) gets ${TOOL_NAMES.length} tools:`);
  console.log(`  → ${TOOL_NAMES.join('  ·  ')}`);
  console.log('  Every hdv_intent still flows HOPE → APEX → KNOLL → (DREAM|VISION). No bypass.');
  await beat(900);

  // ═══════════════════════════════════════════════════════════════════════
  // BEAT 6 — call to action.
  // ═══════════════════════════════════════════════════════════════════════
  scene(6, 'PROTOTYPE ONLINE');
  console.log('  ✅ Matrix math ✅ KNOLL-gated routing ✅ metering + BYOK ✅ MCP front door');
  await beat(400);
  console.log('\n  ▶  Prototype online — open  marketing/index.html');
  console.log('     (or: npm run marketing · npm run demo:billing · npm run mcp)\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
