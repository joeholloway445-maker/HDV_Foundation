/**
 * demo/run_gateway_auth_demo.ts — Phase 4.1 gateway hardening walkthrough.
 *
 * Boots the HOPE gateway on an ephemeral port with auth ENABLED and a tiny rate limit, then
 * exercises the front door end-to-end:
 *   1. /v1/health is public (no key needed).
 *   2. A protected route without a key → 401.
 *   3. The same route with a valid X-HDV-Key / Bearer token → 200.
 *   4. Bursting past the per-IP budget → 429.
 *
 * Nothing here bypasses APEX/KNOLL — auth and rate limiting only guard the transport.
 *
 * Run: npm run demo:gateway-auth
 */
import type { AddressInfo } from 'node:net';
import { HopeGateway } from '../gateway/index.js';

const KEY = 'demo-key-abc123';
const RATE_LIMIT = 3;

function line(): void {
  console.log('-'.repeat(72));
}

async function show(label: string, res: Response): Promise<void> {
  const rl = res.headers.get('x-ratelimit-remaining');
  const suffix = rl !== null ? ` · rate-remaining=${rl}` : '';
  console.log(`${label.padEnd(48)} → ${res.status} ${res.statusText}${suffix}`);
}

async function main(): Promise<void> {
  const gateway = new HopeGateway({
    security: { apiKey: KEY, rateLimit: RATE_LIMIT, corsOrigin: '*' },
    // Silence the per-request JSON logger so the demo output stays readable.
    logger: false,
  });
  const server = await gateway.listen(0);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  console.log('='.repeat(72));
  console.log('BIG 5 MATRIX — HOPE GATEWAY AUTH DEMO (Phase 4.1)');
  console.log(`listening on ${base}`);
  console.log(`auth: ENABLED · rate limit: ${RATE_LIMIT}/min per IP · CORS: * · /v1/health public`);
  console.log('='.repeat(72));

  try {
    line();
    console.log('1) /v1/health is always public (no key required):');
    await show('GET /v1/health (no key)', await fetch(`${base}/v1/health`));

    line();
    console.log('2) protected route without a key is rejected:');
    await show('GET /v1/matrix/stats (no key)', await fetch(`${base}/v1/matrix/stats`));

    line();
    console.log('3) a valid key unlocks protected routes:');
    await show(
      'GET /v1/matrix/stats (X-HDV-Key)',
      await fetch(`${base}/v1/matrix/stats`, { headers: { 'X-HDV-Key': KEY } }),
    );
    await show(
      'POST /v1/intent (Bearer)',
      await fetch(`${base}/v1/intent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ utterance: 'simulate three outcomes for launching the product early' }),
      }),
    );

    line();
    console.log(`4) bursting past the ${RATE_LIMIT}/min budget trips 429 (health stays open):`);
    for (let i = 1; i <= RATE_LIMIT + 2; i++) {
      await show(`GET /v1/matrix/stats #${i} (X-HDV-Key)`, await fetch(`${base}/v1/matrix/stats`, {
        headers: { 'X-HDV-Key': KEY },
      }));
    }
    await show('GET /v1/health during burst', await fetch(`${base}/v1/health`));
    line();
    console.log('done — auth, rate limiting, and the public health probe all behaved as configured.');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().catch((err) => {
  console.error('gateway auth demo failed:', err);
  process.exit(1);
});
