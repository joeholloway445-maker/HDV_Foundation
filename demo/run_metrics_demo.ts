/**
 * demo/run_metrics_demo.ts — Phase 5 observability walkthrough.
 *
 * Wires a MetricsCollector + PacketTracer into an ApexOrchestrator via its read-only dispatch
 * observer (no routing, KNOLL, or ledger code is touched), drives a mix of legal and illegal
 * traffic through APEX + KNOLL, then prints:
 *   1. a JSON metrics snapshot (counters · per-destination · deny reasons · latency · personas),
 *   2. the Prometheus-ish text exposition,
 *   3. the most recent packet trace spans from the ring buffer.
 *
 * Everything still flows SOURCE → APEX → KNOLL → DEST. Observability is strictly out-of-band:
 * it only meters what already happened and can never influence a verdict.
 *
 * Run: npm run demo:metrics
 */
import { ApexOrchestrator } from '../apex/index.js';
import { AgentRole } from '../config/routing_schema.js';
import { MetricsCollector, PacketTracer, combineObservers } from '../observability/index.js';

function hr(title: string): void {
  console.log('\n' + '='.repeat(76));
  console.log(title);
  console.log('='.repeat(76));
}

function main(): void {
  hr('BIG 5 MATRIX — PHASE 5 OBSERVABILITY DEMO (metrics · trace · Prometheus)');

  const metrics = new MetricsCollector();
  const tracer = new PacketTracer({ capacity: 64 });

  // The ONLY integration point: a read-only dispatch observer. APEX/KNOLL are untouched.
  const orchestrator = new ApexOrchestrator({
    defaultCostUsd: 0.02,
    observer: combineObservers(metrics.observer(), tracer.observer()),
  });

  // Inject ephemeral peer handlers (composition root — no peer-to-peer imports).
  orchestrator.wire({
    dream: () => ({ outcome: 'rendered 3 ephemeral scenarios' }),
    vision: () => ({ executed: true, sandbox: 'gvisor' }),
  });

  console.log('\nDriving traffic through APEX + KNOLL (legal routes + intentional blocks)...');

  // --- Legal HOPE → APEX → DREAM (simulation) submissions.
  for (let i = 0; i < 3; i++) {
    orchestrator.submit({
      source: AgentRole.HOPE,
      destination: AgentRole.APEX,
      intent: 'simulate outcomes',
      data: { suggestedDestination: AgentRole.DREAM, run: i },
    });
  }

  // --- Legal HOPE → APEX → VISION (execution) submissions.
  for (let i = 0; i < 2; i++) {
    orchestrator.submit({
      source: AgentRole.HOPE,
      destination: AgentRole.APEX,
      intent: 'execute task',
      data: { suggestedDestination: AgentRole.VISION, run: i },
    });
  }

  // --- Illegal direct DREAM → VISION (KNOLL blocks: NO_DIRECT_DREAM_VISION).
  orchestrator.sendViaApex({ source: AgentRole.DREAM, destination: AgentRole.VISION, intent: 'sneaky handoff' });

  // --- Illegal forged KNOLL source (KNOLL blocks: NO_KNOLL_FORGERY).
  orchestrator.sendViaApex({ source: AgentRole.KNOLL, destination: AgentRole.APEX, intent: 'impersonate the auditor' });

  // --- Malicious intent to VISION (KNOLL blocks: NO_MALICIOUS_INTENT).
  orchestrator.sendViaApex({ source: AgentRole.APEX, destination: AgentRole.VISION, intent: 'please run rm -rf / on the host' });

  // --- Legal route to an unregistered handler → FAILED (no handler for HOPE-as-dest here).
  orchestrator.sendViaApex({ source: AgentRole.APEX, destination: AgentRole.KNOLL, intent: 'noop' });

  // -------------------------------------------------------------------------
  hr('1) JSON METRICS SNAPSHOT');
  const snap = metrics.snapshot();
  console.log(JSON.stringify(snap, null, 2));

  hr('2) PROMETHEUS-ISH EXPOSITION (GET /v1/metrics?format=prometheus)');
  process.stdout.write(metrics.toPrometheus());

  hr('3) RECENT PACKET TRACE SPANS (in-memory ring buffer)');
  for (const span of tracer.recent(10)) {
    const dur = span.durationMs.toFixed(3).padStart(8);
    console.log(
      `${span.verdict.padEnd(8)} ${String(span.source).padEnd(6)} → ${String(span.dest).padEnd(6)} ${dur}ms  ${span.packetId}`,
    );
  }

  console.log(
    `\nTotals: ${snap.packets.total} packets · ${snap.packets.routed} routed · ` +
      `${snap.packets.blocked} blocked · ${snap.packets.failed} failed · ` +
      `~${snap.personas.activeEstimate} active personas (est.) · $${snap.cost.totalUsd} billed`,
  );
  console.log('Observability is out-of-band: it metered every route without ever gating one.');
}

main();
