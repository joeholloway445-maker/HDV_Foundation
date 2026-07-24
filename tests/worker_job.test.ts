/**
 * tests/worker_job.test.ts — Phase 5 production worker (colab/worker_job.py) contract.
 *
 * Proves the REAL worker entrypoint produces a payload the gateway accepts, end-to-end, WITHOUT
 * any infra (no GPU, no gateway process, no network): it runs `worker_job.py --offline`, parses
 * the printed re-ingestion payload, then feeds it straight into the gateway's worker-report
 * handler (APEX → KNOLL → HOPE). Skips cleanly when python3 is unavailable.
 *
 * Run: npm run test:worker-job   (or the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { HopeGateway } from '../gateway/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findPython(): string | undefined {
  for (const bin of ['python3', 'python']) {
    const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return bin;
  }
  return undefined;
}
const PY = findPython();
const SKIP = PY ? false : 'python3 is required to run the worker';

function runWorkerOffline(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(PY as string, ['colab/worker_job.py', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function extractPayload(stdout: string): Record<string, unknown> {
  // The offline worker prints log lines then a single pretty-printed JSON object.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, `worker did not print a JSON payload:\n${stdout}`);
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
}

test('worker_job.py --offline emits a valid DREAM re-ingestion payload', { skip: SKIP }, () => {
  const { code, stdout } = runWorkerOffline(['--role', 'DREAM', '--batch', '4', '--offline']);
  assert.equal(code, 0, 'offline worker exits 0');
  const payload = extractPayload(stdout);
  assert.equal(payload.source, 'DREAM');
  assert.equal(payload.destination, 'HOPE');
  assert.match(String(payload.intent), /^worker-result:/);
  const data = payload.data as Record<string, unknown>;
  assert.equal(data.kind, 'WORKER_RESULT');
  assert.equal(data.agentRole, 'DREAM');
  assert.equal(data.personaCount, 4);
  assert.equal(data.ephemeral, true);
  assert.equal(data.selfTerminated, true);
  assert.equal(data.activeParameters, 4 * 7_000_000_000);
});

test('a worker_job.py payload is accepted by the gateway (APEX → KNOLL → HOPE)', { skip: SKIP }, () => {
  const { stdout } = runWorkerOffline(['--role', 'DREAM', '--batch', '3', '--offline']);
  const payload = extractPayload(stdout);

  const gw = new HopeGateway({ logger: false });
  const before = (gw.handleMatrixStats().body.recentHopeResults as number) ?? 0;
  const res = gw.handleWorkerReport(payload);

  assert.equal(res.status, 200, 'the real worker payload is a legal, KNOLL-allowed report');
  assert.equal(res.body.ingested, true);
  assert.equal(res.body.routingStatus, 'SUCCESS');
  assert.equal(res.body.source, 'DREAM');
  const after = gw.handleMatrixStats().body.recentHopeResults as number;
  assert.equal(after, before + 1, 'the worker result reached HOPE via APEX');
});

test('worker_job.py --offline works for a VISION worker too', { skip: SKIP }, () => {
  const { code, stdout } = runWorkerOffline(['--role', 'VISION', '--batch', '2', '--gpu-hint', 'A100', '--offline']);
  assert.equal(code, 0);
  const payload = extractPayload(stdout);
  assert.equal(payload.source, 'VISION');
  const data = payload.data as Record<string, unknown>;
  assert.equal(data.agentRole, 'VISION');
  assert.equal(data.gpuHint, 'A100');

  const gw = new HopeGateway({ logger: false });
  const res = gw.handleWorkerReport(payload);
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'VISION');
});
