/**
 * gateway/cli.ts — start the HOPE HTTP API gateway (Phase 5 composition root).
 *
 * Usage:
 *   npm run gateway            # binds PORT env or 8787
 *   PORT=9090 npm run gateway  # custom port
 *
 * Endpoints (all JSON):
 *   POST /v1/intent        { "utterance": "..." }  → HOPE interpret+document+submit (via APEX+KNOLL)
 *   POST /v1/worker/report { source, destination?, intent?, data? } → re-ingest a DREAM/VISION
 *                          worker result via APEX (→ KNOLL → HOPE); rejects DREAM↔VISION direct
 *   GET  /v1/health        always-on + ephemeral idle flags
 *   GET  /v1/ledger        recent APEX billing entries (read-only)
 *   GET  /v1/audit         recent KNOLL verdicts (read-only)
 *   GET  /v1/matrix/stats  node/persona topology + parameter accounting
 *   POST /v1/waitlist      { "email": "..." }  → launch waitlist signup (public, rate-limited)
 *   GET  /v1/waitlist/stats aggregate signup stats (protected)
 *
 * KNOLL gates every routed packet; the gateway never bypasses APEX.
 *
 * Phase 4.1 hardening (env-configurable):
 *   HDV_API_KEY      require X-HDV-Key or Authorization: Bearer <key> (unset ⇒ dev mode, auth off)
 *   HDV_RATE_LIMIT   per-IP requests/min (default 60) → 429 when exceeded
 *   HDV_CORS_ORIGIN  Access-Control-Allow-Origin (default *)
 *   /v1/health is always public (auth- and rate-limit-exempt) for probes.
 *
 * Phase 5 durability + async intake (OFFLINE-FIRST — both default to OFF):
 *   DATABASE_URL     when set, the APEX ledger + KNOLL audit are mirrored into Postgres via
 *                    Prisma (createRepositories('prisma')). Rows are HYDRATED on boot and
 *                    FLUSHED + closed on SIGTERM/SIGINT. Unset ⇒ pure in-memory (the default).
 *   HDV_QUEUE=kafka  wires a Kafka-backed TaskQueue (persistence/kafka_real.ts) into the
 *                    ApexOrchestrator and starts a consumer that drains async `intake()` through
 *                    the SAME KNOLL-gated dispatch path. Requires the `kafkajs` package and a
 *                    reachable broker (KAFKA_BROKERS). Anything else ⇒ the in-memory queue.
 */
import { HopeGateway } from './server.js';
import {
  createRepositories,
  createTaskQueue,
  resolveQueueMode,
  brokersFromEnv,
  type RepositoryBundle,
  type TaskQueue,
} from '../persistence/index.js';

function parsePort(): number {
  const fromEnv = Number(process.env.PORT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 8787;
}

/** True when a non-empty DATABASE_URL is configured (opts into Prisma-backed durability). */
function databaseUrl(): string | undefined {
  const raw = (process.env.DATABASE_URL ?? '').trim();
  return raw.length > 0 ? raw : undefined;
}

async function main(): Promise<void> {
  const port = parsePort();

  // --- Phase 5: optional durable persistence (Prisma/Postgres) -----------------------------
  // When DATABASE_URL is set we back the ledger + audit with Postgres, hydrating existing rows
  // before serving so read endpoints reflect prior runs. Otherwise the pure in-memory default.
  let repositories: RepositoryBundle | undefined;
  const dbUrl = databaseUrl();
  if (dbUrl) {
    repositories = createRepositories('prisma');
    console.log('Persistence: prisma (Postgres) — hydrating ledger + audit from the database…');
    try {
      await repositories.hydrate();
      console.log('Persistence: hydrate complete.');
    } catch (err) {
      console.error(
        'Persistence: hydrate failed — is DATABASE_URL reachable and `npm run db:push` applied?\n',
        err,
      );
      throw err;
    }
  } else {
    console.log('Persistence: in-memory (set DATABASE_URL to enable durable Postgres).');
  }

  // --- Phase 5: optional async intake queue (Kafka) ----------------------------------------
  // HDV_QUEUE=kafka wires a real broker-backed queue into APEX and starts a drain consumer.
  // The queue is PURE TRANSPORT — every drained packet still passes through KNOLL-gated dispatch.
  let queue: TaskQueue | undefined;
  const queueMode = resolveQueueMode();
  if (queueMode === 'kafka') {
    console.log(`Queue: kafka — connecting to brokers [${brokersFromEnv().join(', ')}]…`);
    try {
      queue = await createTaskQueue('kafka');
      console.log('Queue: connected.');
    } catch (err) {
      console.error(
        'Queue: kafka connect failed — install `kafkajs` and start a broker (docker compose up -d kafka).\n',
        err,
      );
      throw err;
    }
  } else {
    console.log('Queue: in-memory (set HDV_QUEUE=kafka to enable the Kafka intake queue).');
  }

  const gateway = new HopeGateway({
    requestLog: repositories?.requestLog,
    securityAudit: repositories?.securityAudit,
    queue,
  });

  // Start the APEX intake consumer once the queue is wired: async `intake()` now drains through
  // the same KNOLL-gated dispatch path as the synchronous submit path.
  const consumer = queue ? gateway.orchestrator.startQueueConsumer({ group: 'apex-intake' }) : undefined;
  if (consumer) console.log('Queue: APEX intake consumer started (group "apex-intake").');

  const server = await gateway.listen(port);

  const routes = [
    'POST /v1/intent',
    'POST /v1/worker/report    (DREAM|VISION worker result → APEX → HOPE)',
    'GET  /v1/health',
    'GET  /v1/ledger',
    'GET  /v1/audit',
    'GET  /v1/matrix/stats',
    'GET  /v1/metrics',
    'GET  /v1/billing/pricing   (public — no key)',
    'GET  /v1/billing/usage     (X-HDV-Tenant, default "demo")',
    'GET  /v1/billing/estimate  ({ activeParams, durationSec, model? } or query)',
    'POST /v1/billing/allowance ({ tier?, includedAllowanceUsd?, hardCapUsd? })',
    'POST /v1/waitlist          (public — { email, name?, company?, interestedTier?, useCase? })',
    'GET  /v1/waitlist/stats    (protected — privacy-safe aggregate signup stats)',
  ];
  const { config } = gateway.middleware;
  const authMode = config.apiKey ? 'ENABLED (X-HDV-Key / Bearer)' : 'DISABLED (dev mode — set HDV_API_KEY)';
  console.log('='.repeat(72));
  console.log(`BIG 5 MATRIX — HOPE GATEWAY listening on http://localhost:${port}`);
  console.log('KNOLL gate: enforced · APEX: sole router · no endpoint bypasses APEX');
  console.log(`Auth: ${authMode} · Rate limit: ${config.rateLimit}/min per IP · CORS: ${config.corsOrigin}`);
  console.log(`Persistence: ${repositories?.mode ?? 'memory'} · Queue: ${queueMode}`);
  console.log('/v1/health is always public (auth- and rate-limit-exempt) for probes');
  console.log('-'.repeat(72));
  for (const r of routes) console.log(`  ${r}`);
  console.log('='.repeat(72));
  console.log('Press Ctrl+C to stop.');

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal} — shutting down HOPE gateway…`);
    server.close(() => {
      // Best-effort graceful teardown: stop the consumer, flush durable writes, disconnect.
      void (async () => {
        try {
          consumer?.close();
          const closable = queue as unknown as { close?: () => Promise<void> } | undefined;
          if (closable && typeof closable.close === 'function') {
            await closable.close();
          }
          if (repositories) {
            await repositories.flush();
            await repositories.close();
            console.log('Persistence: flushed and closed.');
          }
        } catch (err) {
          console.error('Shutdown cleanup error:', err);
        } finally {
          process.exit(0);
        }
      })();
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('gateway failed to start:', err);
  process.exit(1);
});
