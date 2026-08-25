/**
 * tests/production_seal.test.ts — Unit tests for gateway/production.ts.
 *
 * `sealProductionOrExplain` is the code-side enforcement of the "seal every back door"
 * requirement: it MUST refuse to boot unless HDV_API_KEY and HDV_CORS_ORIGIN are set to
 * safe values when HDV_PRODUCTION is enabled. These tests pin the exact acceptance/rejection
 * behaviour so a future refactor can't silently weaken the checks.
 *
 * All tests pass a synthetic `env` object so the real process.env is never mutated.
 *
 * Run: node --import tsx --test tests/production_seal.test.ts
 *      (or via the full suite: npm test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isProductionMode, sealProductionOrExplain } from '../gateway/production.js';

// ---------------------------------------------------------------------------
// A. isProductionMode
// ---------------------------------------------------------------------------

test('isProductionMode: absent → false', () => {
  assert.equal(isProductionMode({}), false);
});

test('isProductionMode: empty string → false', () => {
  assert.equal(isProductionMode({ HDV_PRODUCTION: '' }), false);
});

for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'ON', '  1  ']) {
  test(`isProductionMode: "${v}" → true`, () => {
    assert.equal(isProductionMode({ HDV_PRODUCTION: v }), true);
  });
}

for (const v of ['0', 'false', 'no', 'off', 'maybe']) {
  test(`isProductionMode: "${v}" → false`, () => {
    assert.equal(isProductionMode({ HDV_PRODUCTION: v }), false);
  });
}

// ---------------------------------------------------------------------------
// B. Dev mode (HDV_PRODUCTION unset / falsy)
// ---------------------------------------------------------------------------

test('dev mode: ok=true with no config required', () => {
  const result = sealProductionOrExplain({});
  assert.equal(result.ok, true);
  assert.equal(result.production, false);
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.some((w) => w.includes('DEV mode')));
});

test('dev mode: bindHost defaults to 0.0.0.0', () => {
  const result = sealProductionOrExplain({});
  assert.equal(result.bindHost, '0.0.0.0');
});

test('dev mode: HDV_BIND_HOST respected', () => {
  const result = sealProductionOrExplain({ HDV_BIND_HOST: '127.0.0.1' });
  assert.equal(result.bindHost, '127.0.0.1');
});

// ---------------------------------------------------------------------------
// C. Production mode — happy path
// ---------------------------------------------------------------------------

const VALID_PROD_ENV = {
  HDV_PRODUCTION: '1',
  HDV_API_KEY: 'a'.repeat(24),
  HDV_CORS_ORIGIN: 'https://periliminal.space',
  DATABASE_URL: 'postgresql://localhost/hdv',
};

test('production mode: valid config → ok=true, no errors', () => {
  const result = sealProductionOrExplain(VALID_PROD_ENV);
  assert.equal(result.ok, true);
  assert.equal(result.production, true);
  assert.equal(result.errors.length, 0);
});

test('production mode: bindHost defaults to 127.0.0.1', () => {
  const result = sealProductionOrExplain(VALID_PROD_ENV);
  assert.equal(result.bindHost, '127.0.0.1');
});

test('production mode: explicit HDV_BIND_HOST respected', () => {
  const result = sealProductionOrExplain({ ...VALID_PROD_ENV, HDV_BIND_HOST: '10.0.0.1' });
  assert.equal(result.bindHost, '10.0.0.1');
});

// ---------------------------------------------------------------------------
// D. Production mode — error cases
// ---------------------------------------------------------------------------

test('production mode: missing HDV_API_KEY → error', () => {
  const env = { ...VALID_PROD_ENV };
  delete (env as any).HDV_API_KEY;
  const result = sealProductionOrExplain(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('HDV_API_KEY')));
});

test('production mode: HDV_API_KEY too short → error', () => {
  const result = sealProductionOrExplain({ ...VALID_PROD_ENV, HDV_API_KEY: 'short' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('HDV_API_KEY')));
});

test('production mode: HDV_API_KEY exactly 24 chars → ok', () => {
  const result = sealProductionOrExplain({ ...VALID_PROD_ENV, HDV_API_KEY: 'x'.repeat(24) });
  assert.equal(result.ok, true);
});

test('production mode: HDV_CORS_ORIGIN missing → error', () => {
  const env = { ...VALID_PROD_ENV };
  delete (env as any).HDV_CORS_ORIGIN;
  const result = sealProductionOrExplain(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('HDV_CORS_ORIGIN')));
});

test('production mode: HDV_CORS_ORIGIN="*" → error', () => {
  const result = sealProductionOrExplain({ ...VALID_PROD_ENV, HDV_CORS_ORIGIN: '*' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('HDV_CORS_ORIGIN')));
});

test('production mode: both key and CORS missing → two errors', () => {
  const result = sealProductionOrExplain({ HDV_PRODUCTION: '1' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2);
});

// ---------------------------------------------------------------------------
// E. Production mode — warning cases (ok=true but non-empty warnings)
// ---------------------------------------------------------------------------

test('production mode: bindHost=0.0.0.0 → warning', () => {
  const result = sealProductionOrExplain({ ...VALID_PROD_ENV, HDV_BIND_HOST: '0.0.0.0' });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('0.0.0.0')));
});

test('production mode: bindHost=:: → warning', () => {
  const result = sealProductionOrExplain({ ...VALID_PROD_ENV, HDV_BIND_HOST: '::' });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('::')));
});

test('production mode: missing DATABASE_URL → warning', () => {
  const env = { ...VALID_PROD_ENV };
  delete (env as any).DATABASE_URL;
  const result = sealProductionOrExplain(env);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('DATABASE_URL')));
});

test('production mode: HDV_RATE_LIMIT=5 → warning', () => {
  const result = sealProductionOrExplain({ ...VALID_PROD_ENV, HDV_RATE_LIMIT: '5' });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('HDV_RATE_LIMIT')));
});

test('production mode: HDV_RATE_LIMIT=NaN → warning', () => {
  const result = sealProductionOrExplain({ ...VALID_PROD_ENV, HDV_RATE_LIMIT: 'notanumber' });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('HDV_RATE_LIMIT')));
});
