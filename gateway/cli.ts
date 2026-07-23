/**
 * gateway/cli.ts — start the HOPE HTTP API gateway.
 *
 * Usage:
 *   npm run gateway            # binds PORT env or 8787
 *   PORT=9090 npm run gateway  # custom port
 *
 * Endpoints (all JSON):
 *   POST /v1/intent        { "utterance": "..." }  → HOPE interpret+document+submit (via APEX+KNOLL)
 *   GET  /v1/health        always-on + ephemeral idle flags
 *   GET  /v1/ledger        recent APEX billing entries (read-only)
 *   GET  /v1/audit         recent KNOLL verdicts (read-only)
 *   GET  /v1/matrix/stats  node/persona topology + parameter accounting
 *
 * KNOLL gates every routed packet; the gateway never bypasses APEX.
 */
import { HopeGateway } from './server.js';

function parsePort(): number {
  const fromEnv = Number(process.env.PORT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 8787;
}

async function main(): Promise<void> {
  const port = parsePort();
  const gateway = new HopeGateway();
  const server = await gateway.listen(port);

  const routes = [
    'POST /v1/intent',
    'GET  /v1/health',
    'GET  /v1/ledger',
    'GET  /v1/audit',
    'GET  /v1/matrix/stats',
  ];
  console.log('='.repeat(72));
  console.log(`BIG 5 MATRIX — HOPE GATEWAY listening on http://localhost:${port}`);
  console.log('KNOLL gate: enforced · APEX: sole router · no endpoint bypasses APEX');
  console.log('-'.repeat(72));
  for (const r of routes) console.log(`  ${r}`);
  console.log('='.repeat(72));
  console.log('Press Ctrl+C to stop.');

  const shutdown = (): void => {
    console.log('\nShutting down HOPE gateway…');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('gateway failed to start:', err);
  process.exit(1);
});
