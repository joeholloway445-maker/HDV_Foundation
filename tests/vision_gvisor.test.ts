/**
 * tests/vision_gvisor.test.ts — Phase 5 real gVisor sandbox adapter.
 *
 * Covers vision/sandbox_gvisor.ts WITHOUT requiring the gVisor runtime for the default suite:
 *   - `isGvisorAvailable()` reports a stable boolean (cached).
 *   - `createSandboxSession('gvisor')` transparently FALLS BACK to the stub when `runsc` is not
 *     installed — so the offline suite and any host without gVisor behave identically.
 *   - The real `GvisorSandboxSession` (which shells out to Docker `--runtime=runsc`) is only
 *     exercised when `runsc` + `docker` are present; those cases SKIP otherwise.
 *
 * Run: npm run test:vision-gvisor   (or the full suite: npm test)
 * Real gVisor: install gVisor (`runsc`) + Docker, then `npm run test:vision-gvisor`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSandboxSession,
  StubSandboxSession,
  GvisorSandboxSession,
  isGvisorAvailable,
  GVISOR_RUNTIME_BIN,
  DEFAULT_GVISOR_IMAGE,
} from '../vision/index.js';

const GVISOR = isGvisorAvailable();

test('isGvisorAvailable() returns a stable boolean (cached)', () => {
  assert.equal(typeof isGvisorAvailable(), 'boolean');
  assert.equal(isGvisorAvailable(), GVISOR, 'availability is cached and stable within a run');
});

test('gVisor adapter constants are exported', () => {
  assert.equal(GVISOR_RUNTIME_BIN, 'runsc');
  assert.equal(typeof DEFAULT_GVISOR_IMAGE, 'string');
  assert.ok(DEFAULT_GVISOR_IMAGE.length > 0);
});

test(
  'createSandboxSession("gvisor") falls back to the stub when runsc is unavailable',
  { skip: GVISOR ? 'runsc is present — the real gVisor adapter is used instead' : false },
  () => {
    const session = createSandboxSession('gvisor', { cpu: 1, memMb: 128, timeoutMs: 5000 });
    assert.ok(session instanceof StubSandboxSession, 'no runsc ⇒ stub fallback');
    assert.equal(session.kind, 'gvisor', 'fallback preserves the requested kind label');
    session.start();
    const run = session.run('probe', () => ({ exitCode: 0, durationMs: 10, memMb: 16 }));
    assert.equal(run.exitCode, 0);
    assert.equal(run.timedOut, false);
    const summary = session.stop();
    assert.equal(summary.runs, 1);
  },
);

test(
  'createSandboxSession("gvisor") returns the real adapter when runsc is available',
  { skip: GVISOR ? false : `requires the '${GVISOR_RUNTIME_BIN}' runtime + docker` },
  () => {
    const session = createSandboxSession('gvisor');
    assert.ok(session instanceof GvisorSandboxSession, 'runsc present ⇒ real gVisor adapter');
    session.stop();
  },
);

test(
  'real GvisorSandboxSession executes a command inside a gVisor container',
  { skip: GVISOR ? false : `requires the '${GVISOR_RUNTIME_BIN}' runtime + docker` },
  () => {
    const session = new GvisorSandboxSession({ cpu: 1, memMb: 128, timeoutMs: 5000 });
    assert.equal(session.kind, 'gvisor');
    session.start();
    try {
      const run = session.run('echo', () => ({ exitCode: 0, output: { command: 'echo hello-gvisor' } }));
      assert.equal(run.exitCode, 0);
      assert.match(run.stdout, /hello-gvisor/);
      assert.equal((run.output as { ran?: string }).ran, 'gvisor', 'a real command ran in the sandbox');
    } finally {
      session.stop();
    }
  },
);
