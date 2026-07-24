/**
 * gateway/production.ts — PRODUCTION seal mode.
 *
 * When HDV_PRODUCTION=1 (or true/yes), the gateway refuses to boot unless every
 * operational back-door is closed EXCEPT the constitutional public surface and
 * the Big 5 virtual laws (KNOLL). This is the code-side half of "seal every
 * back door other than our laws."
 *
 * Required in production:
 *   - HDV_API_KEY must be set (no open protected routes)
 *   - HDV_CORS_ORIGIN must NOT be "*" (explicit origin(s) only)
 *   - Gateway bind host defaults to 127.0.0.1 (Caddy/nginx terminates TLS)
 *   - HDV_RATE_LIMIT enforced (minimum floor)
 *
 * Still public (by constitution / ops necessity):
 *   - GET /v1/health
 *   - GET /v1/billing/pricing (read-only marketing table)
 *   - POST /v1/waitlist (rate-limited signup)
 *
 * Everything else requires the API key. KNOLL laws remain the only packet gate.
 */
export interface ProductionSealResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  bindHost: string;
  production: boolean;
}

export function isProductionMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.HDV_PRODUCTION ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Validate env for a sealed production boot. Call before listen().
 * Returns errors that MUST stop boot; warnings that should be logged.
 */
export function sealProductionOrExplain(
  env: NodeJS.ProcessEnv = process.env,
): ProductionSealResult {
  const production = isProductionMode(env);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!production) {
    return {
      ok: true,
      errors: [],
      warnings: ['HDV_PRODUCTION unset — running in DEV mode (auth may be off).'],
      bindHost: env.HDV_BIND_HOST?.trim() || '0.0.0.0',
      production: false,
    };
  }

  const key = env.HDV_API_KEY?.trim() ?? '';
  if (key.length < 24) {
    errors.push(
      'HDV_PRODUCTION=1 requires HDV_API_KEY (≥24 chars). Refusing to boot with open protected routes.',
    );
  }

  const cors = env.HDV_CORS_ORIGIN?.trim() ?? '';
  if (!cors || cors === '*') {
    errors.push(
      'HDV_PRODUCTION=1 requires HDV_CORS_ORIGIN set to an explicit origin (not "*").',
    );
  }

  const bindHost = env.HDV_BIND_HOST?.trim() || '127.0.0.1';
  if (bindHost === '0.0.0.0' || bindHost === '::') {
    warnings.push(
      `Gateway binding ${bindHost} in production — prefer HDV_BIND_HOST=127.0.0.1 behind Caddy/TLS.`,
    );
  }

  const rate = Number(env.HDV_RATE_LIMIT ?? '60');
  if (!Number.isFinite(rate) || rate < 10) {
    warnings.push('HDV_RATE_LIMIT is very low or invalid; using a safe floor of 10/min.');
  }

  if (!env.DATABASE_URL?.trim()) {
    warnings.push(
      'DATABASE_URL unset in production — ledger/audit will be in-memory only (lost on restart).',
    );
  }

  return { ok: errors.length === 0, errors, warnings, bindHost, production };
}
