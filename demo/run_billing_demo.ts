/**
 * demo/run_billing_demo.ts — PRODUCT metering walkthrough (HDV Foundation).
 *
 * Shows the billing layer end-to-end WITHOUT touching routing, KNOLL, or the ledger's gating:
 *   1. The public pricing table (per-tier rates + included persona-hours).
 *   2. A cost estimate for a unit of work, priced across every tier.
 *   3. Live APEX traffic metered onto the `demo` tenant via the read-only dispatch observer.
 *   4. A hard-cap BLOCK: usage past the cap is rejected (logged, never billed).
 *   5. BYOK: unlimited usage with a $0 platform fee (pass-through only).
 *
 * Everything still flows SOURCE → APEX → KNOLL → DEST. Billing only prices + accounts.
 *
 * Run: npm run demo:billing
 */
import { ApexOrchestrator } from '../apex/index.js';
import { AgentRole } from '../config/routing_schema.js';
import { MODEL_PARAMS } from '../nodes/index.js';
import { BillingService } from '../billing/index.js';

function hr(title: string): void {
  console.log('\n' + '='.repeat(76));
  console.log(title);
  console.log('='.repeat(76));
}

const usd = (n: number): string => `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

function main(): void {
  hr('BIG 5 MATRIX — PRODUCT METERING DEMO (allowance · cost + occurrence metrics)');

  // One-line composition: pricing (config/pricing.json) + per-tenant store + meter.
  const billing = new BillingService({ demoTier: 'PRO' });

  // -------------------------------------------------------------------------
  hr('1) PUBLIC PRICING TABLE  (GET /v1/billing/pricing)');
  const table = billing.pricing.publicTable();
  console.log(`currency: ${table.currency} · unit: ${table.meteringUnit} · 1 persona = ${MODEL_PARAMS.toLocaleString()} params\n`);
  for (const t of table.tiers) {
    const cap = t.hardCapUsd === null ? 'uncapped' : usd(t.hardCapUsd);
    const hours = t.includedPersonaHours === null ? 'n/a' : `${t.includedPersonaHours.toFixed(1)} persona-h`;
    console.log(`  ${t.displayName.padEnd(20)} $${t.pricePerMillionActiveParamSeconds}/M param-sec · included ${usd(t.includedAllowanceUsd)} (~${hours}) · cap ${cap}`);
    console.log(`  ${''.padEnd(20)} ${t.tagline}`);
  }

  // -------------------------------------------------------------------------
  hr('2) COST ESTIMATE  (GET /v1/billing/estimate)');
  const activeParams = MODEL_PARAMS * 10; // 10 personas lit up
  const durationSec = 30;
  console.log(`Work: ${activeParams.toLocaleString()} active params (10 personas) for ${durationSec}s\n`);
  for (const t of billing.pricing.tiers()) {
    const est = billing.pricing.estimate({ tier: t.tier, activeParams, durationSec });
    console.log(`  ${t.displayName.padEnd(20)} ${usd(est.costUsd).padStart(10)}   ${est.breakdown}`);
  }

  // -------------------------------------------------------------------------
  hr('3) LIVE APEX TRAFFIC → METERED ONTO THE "demo" TENANT');
  const orchestrator = new ApexOrchestrator({ defaultCostUsd: 0.02, observer: billing.meter.observer() });
  orchestrator.wire({
    dream: () => ({ outcome: 'rendered 3 ephemeral scenarios' }),
    vision: () => ({ executed: true, sandbox: 'gvisor' }),
  });

  for (let i = 0; i < 3; i++) {
    orchestrator.submit({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'simulate outcomes', data: { suggestedDestination: AgentRole.DREAM, run: i } });
  }
  for (let i = 0; i < 2; i++) {
    orchestrator.submit({ source: AgentRole.HOPE, destination: AgentRole.APEX, intent: 'execute task', data: { suggestedDestination: AgentRole.VISION, run: i } });
  }

  const demo = billing.store.balance('demo');
  const meter = billing.meter.stats();
  console.log(`meter: ${meter.metered} dispatches metered (${meter.estimated} via persona estimate · ${meter.fallback} via ledger fallback)`);
  console.log(`tenant "demo" [${demo.displayName}]: spent ${usd(demo.spentUsd)} of cap ${demo.hardCapUsd === null ? 'uncapped' : usd(demo.hardCapUsd)}`);
  console.log(`  occurrences: ${demo.acceptedCount} accepted · by kind ${JSON.stringify(demo.occurrencesByKind)}`);
  console.log(`  active-param-seconds: ${demo.totalActiveParamSeconds.toLocaleString()} (${demo.activePersonaSeconds.toFixed(3)} persona-seconds)`);
  console.log('\n  recent occurrences (newest first):');
  for (const occ of billing.store.recentOccurrences('demo', 5)) {
    console.log(`    ${new Date(occ.at).toISOString()}  ${occ.kind.padEnd(10)} ${usd(occ.costUsd).padStart(10)}  ${occ.activeParams.toLocaleString()} params × ${occ.durationSec.toFixed(3)}s  [${occ.provider}/${occ.model}]`);
  }

  // -------------------------------------------------------------------------
  hr('4) HARD-CAP BLOCK  (over-cap usage is rejected, logged, never billed)');
  billing.store.setAllowance('startup', { tier: 'STARTER', includedAllowanceUsd: 0.005, hardCapUsd: 0.005 });
  console.log('tenant "startup" [Starter] hard cap set to $0.005\n');
  for (let i = 1; i <= 4; i++) {
    const res = billing.store.consume('startup', { activeParams: MODEL_PARAMS, durationSec: 1, kind: 'EXECUTION', model: '7B' });
    const tag = res.accepted ? 'BILLED  ' : 'BLOCKED ';
    console.log(`  attempt ${i}: ${tag} ${usd(res.costUsd)}  → spent ${usd(res.balance.spentUsd)} / cap $0.005${res.accepted ? '' : '  (' + res.reason + ')'}`);
  }
  const startup = billing.store.balance('startup');
  console.log(`\n  result: ${startup.acceptedCount} billed · ${startup.rejectedCount} blocked · remaining ${usd(startup.remainingUsd ?? 0)}`);

  // -------------------------------------------------------------------------
  hr('5) BYOK — UNLIMITED, $0 PLATFORM FEE (pass-through only)');
  billing.store.setAllowance('byok-co', { tier: 'BYOK' });
  const big = billing.store.consume('byok-co', { activeParams: MODEL_PARAMS * 100000, durationSec: 3600, kind: 'EXECUTION', provider: 'byok:acme', model: 'gpt-4o' });
  const byok = billing.store.balance('byok-co');
  console.log(`tenant "byok-co" ran 100,000 personas for 1h through their OWN provider:`);
  console.log(`  platform fee charged: ${usd(big.costUsd)}  · accepted: ${big.accepted} · cap: ${byok.hardCapUsd === null ? 'uncapped' : usd(byok.hardCapUsd)}`);
  console.log('  → You pay only your provider. HDV platform fee is $0 on BYOK.');

  hr('SUMMARY');
  console.log('Billing prices + accounts ONLY. It never routed, gated, or executed a packet:');
  console.log('  • pricing engine loads config/pricing.json (editable, no code change)');
  console.log('  • allowances enforce a hard cap; BYOK is unlimited at $0 platform fee');
  console.log('  • the meter attributes live APEX traffic via the read-only dispatch observer');
  console.log('  • every occurrence carries both COST (usd) and OCCURRENCE (param-seconds) metrics');
}

main();
