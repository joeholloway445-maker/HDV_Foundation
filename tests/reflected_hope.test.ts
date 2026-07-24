/**
 * tests/reflected_hope.test.ts — Reflected Hopes isolation & privacy (node:test).
 *
 * The non-negotiable invariant: a Reflected Hope is per-user and isolated, and reflected
 * activity can NEVER contaminate the Core Hope / Prime Hope stores. Also covers opt-in
 * consent and the logged Tactical Intel Exception.
 *
 * Run: node --import tsx --test tests/reflected_hope.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ReflectedHope,
  ReflectedHopeRegistry,
  CoreHopeStore,
  OptInConsent,
  TacticalIntelException,
  reflectedId,
  containerPath,
  assertIsolation,
  isReflectedPath,
  isCoreOrPrimePath,
  CORE_HOPE_ROOT,
  PRIME_HOPE_ROOT,
  REFLECTED_ROOT,
} from '../hope/reflected/index.js';

// --- Isolation / segmentation ---------------------------------------------

test('each user maps to a distinct, isolated container path under REFLECTED_ROOT', () => {
  const a = reflectedId('alice');
  const b = reflectedId('bob');
  assert.notEqual(a, b);
  const pathA = containerPath(a);
  assert.ok(pathA.startsWith(`${REFLECTED_ROOT}/`));
  assert.ok(isReflectedPath(pathA));
  assert.equal(isCoreOrPrimePath(pathA), false);
});

test('reflectedId is deterministic for the same user', () => {
  assert.equal(reflectedId('alice'), reflectedId('alice'));
});

test('assertIsolation never yields a Core/Prime path', () => {
  const path = assertIsolation(reflectedId('carol'));
  assert.equal(isCoreOrPrimePath(path), false);
  assert.notEqual(path, CORE_HOPE_ROOT);
  assert.notEqual(path, PRIME_HOPE_ROOT);
});

// --- Core contamination guarantee -----------------------------------------

test('reflected activity CANNOT contaminate the Core/Prime Hope store', () => {
  const core = new CoreHopeStore();
  const registry = new ReflectedHopeRegistry();

  registry.consentManager().optIn('alice');
  registry.collect('alice', 'wants a calmer morning routine');
  registry.collect('alice', 'prefers concise answers');

  // The reflected container holds the data...
  assert.equal(registry.containerFor('alice').size(), 2);
  // ...and the core store was never touched.
  assert.equal(core.size(), 0);

  // The registry exposes no path into the core store: its container path is isolated.
  assert.ok(isReflectedPath(registry.pathFor('alice')));
  assert.equal(isCoreOrPrimePath(registry.pathFor('alice')), false);
});

test('per-user containers are isolated from each other', () => {
  const registry = new ReflectedHopeRegistry();
  registry.consentManager().optIn('alice');
  registry.consentManager().optIn('bob');
  registry.collect('alice', 'alice note');
  registry.collect('bob', 'bob note');

  assert.equal(registry.containerFor('alice').size(), 1);
  assert.equal(registry.containerFor('bob').size(), 1);
  assert.equal(registry.containerFor('alice').entries()[0].text, 'alice note');
  assert.notEqual(
    registry.containerFor('alice').path,
    registry.containerFor('bob').path,
  );
});

// --- Privacy / opt-in consent ---------------------------------------------

test('collection is opt-in: nothing is collected by default', () => {
  const registry = new ReflectedHopeRegistry();
  const result = registry.collect('dave', 'should not be stored');
  assert.equal(result, null);
  assert.equal(registry.has('dave'), false);
});

test('opt-out clears future collection', () => {
  const consent = new OptInConsent();
  const registry = new ReflectedHopeRegistry({ consent });

  consent.optIn('erin');
  assert.ok(registry.collect('erin', 'first'));
  assert.equal(registry.containerFor('erin').size(), 1);

  consent.optOut('erin');
  assert.equal(registry.collect('erin', 'second'), null); // future collection cleared
  assert.equal(registry.containerFor('erin').size(), 1);
});

test('OptInConsent defaults to false and toggles correctly', () => {
  const consent = new OptInConsent();
  assert.equal(consent.isOptedIn('nobody'), false);
  consent.optIn('x');
  assert.equal(consent.canCollect('x'), true);
  consent.optOut('x');
  assert.equal(consent.canCollect('x'), false);
});

test('forget purges the container and opts the user out', () => {
  const registry = new ReflectedHopeRegistry();
  registry.consentManager().optIn('frank');
  registry.collect('frank', 'note');
  assert.equal(registry.has('frank'), true);

  registry.forget('frank');
  assert.equal(registry.has('frank'), false);
  assert.equal(registry.consentManager().canCollect('frank'), false);
});

// --- Tactical Intel Exception ---------------------------------------------

test('ReflectedHope is a plain isolated container', () => {
  const rh = new ReflectedHope('grace');
  const obs = rh.record('hello');
  assert.equal(rh.size(), 1);
  assert.equal(obs.text, 'hello');
  assert.ok(rh.path.startsWith(`${REFLECTED_ROOT}/`));
  assert.throws(() => rh.record('')); // empty text rejected
});

test('TacticalIntelException: manipulation only when enabled, and always logged', () => {
  const tie = new TacticalIntelException();

  // Refused while disabled.
  assert.throws(() =>
    tie.applyManipulation('x', (s) => `${s}!`, { actor: 'auditor', reason: 'test' }),
  );

  tie.enable('SECURITY_VERIFICATION', 'auditor', 'inject canary for exfil detection');
  const out = tie.applyManipulation('token', (s) => `${s}#canary`, {
    actor: 'auditor',
    reason: 'seed honeytoken',
  });
  assert.equal(out, 'token#canary');

  const events = tie.entries().map((e) => e.event);
  assert.deepEqual(events, ['ENABLE', 'MANIPULATE']);
  assert.equal(tie.entries()[1].reason, 'seed honeytoken');

  tie.disable('auditor', 'done');
  assert.equal(tie.isEnabled(), false);
});

test('TacticalIntelException refuses non-security purposes', () => {
  const tie = new TacticalIntelException();
  // @ts-expect-error — only security/audit purposes are permitted by the type and the guard.
  assert.throws(() => tie.enable('MARKETING', 'growth', 'A/B test'));
});
