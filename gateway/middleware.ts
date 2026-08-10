/**
 * gateway/middleware.ts — Phase 4.1 hardening for the HOPE HTTP gateway.
 *
 * Cross-cutting HTTP concerns that sit IN FRONT of the route handlers without touching
 * HOPE, APEX, KNOLL, or any peer logic. The gateway stays a thin composition root; this
 * module only guards and observes the transport:
 *
 *   - Optional API-key auth (X-HDV-Key or Authorization: Bearer <key>) against HDV_API_KEY.
 *     When HDV_API_KEY is unset the gateway runs in DEV MODE (auth disabled).
 *   - Per-IP in-memory rate limiting (HDV_RATE_LIMIT, default 60/min) → 429 when exceeded.
 *   - CORS headers (HDV_CORS_ORIGIN, default "*").
 *   - Structured request logging (method, path, status, duration) that NEVER logs secrets.
 *
 * INVARIANTS: /v1/health is always public (auth- and rate-limit-exempt) so liveness/readiness
 * probes keep working regardless of key config or traffic bursts. Zero third-party deps.
 */
import { timingSafeEqual } from 'node:crypto';
import type { GatewayResponse } from './server.js';

/** Default requests-per-window when HDV_RATE_LIMIT is unset/invalid. */
export const DEFAULT_RATE_LIMIT = 60;
/** Rate-limit window length. Phase 4.1 uses a fixed one-minute window. */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** Default CORS origin when HDV_CORS_ORIGIN is unset. */
export const DEFAULT_CORS_ORIGIN = '*';

/**
 * Paths that must always stay reachable (auth- and rate-limit-exempt): health probes and the
 * public marketing pricing table (non-tenant, read-only — safe to expose without a key).
 */
const ALWAYS_PUBLIC_PATHS = new Set<string>(['/v1/health', '/v1/billing/pricing']);

/**
 * Paths that skip AUTH but are still RATE-LIMITED. Public write surfaces that anonymous visitors
 * must reach (the marketing waitlist signup, companion chat/portrait) live here: no key is
 * required so the form/client works with auth enabled, but the per-IP limiter still applies so
 * the open endpoint can't be flooded. GET /v1/waitlist/stats is deliberately NOT listed — it
 * stays protected by the API key.
 */
const AUTH_EXEMPT_PATHS = new Set<string>([
  '/v1/waitlist',
  '/v1/companion/chat',
  '/v1/companion/portrait',
  '/v1/companion/scene',
  '/v1/companion/speak',
  // Checkout is public because FuckLike/web has no user-account/API-key system yet — it sends
  // a per-browser anonymous tenant id via X-HDV-Tenant instead (see web/app.js). Safe today
  // because billing/stripe_stub.ts is a stub with no real STRIPE_SECRET_KEY (no money moves).
  // MUST be revisited before going live with a real Stripe key: checkout/settle in particular
  // needs to move to a real, signature-verified Stripe webhook rather than staying
  // client-callable — see the handler's doc comment in gateway/server.ts.
  '/v1/billing/checkout',
  '/v1/billing/checkout/settle',
]);

export interface GatewaySecurityConfig {
  /** API key required on protected routes. Empty/undefined ⇒ dev mode (auth disabled). */
  apiKey?: string;
  /** Max requests per window per client IP. */
  rateLimit: number;
  /** Window length in ms for the rate limiter. */
  windowMs: number;
  /** Value for the Access-Control-Allow-Origin header. */
  corsOrigin: string;
}

export interface SecurityOverrides {
  apiKey?: string;
  rateLimit?: number;
  windowMs?: number;
  corsOrigin?: string;
}

/**
 * Resolve the effective security config from env with explicit overrides taking precedence.
 * Env is read lazily here (not at import time) so tests can drive it deterministically.
 */
export function resolveSecurityConfig(
  overrides: SecurityOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): GatewaySecurityConfig {
  const rawKey = overrides.apiKey ?? env.HDV_API_KEY;
  const apiKey = rawKey && rawKey.trim().length > 0 ? rawKey.trim() : undefined;

  const rateLimit = overrides.rateLimit ?? parsePositiveInt(env.HDV_RATE_LIMIT) ?? DEFAULT_RATE_LIMIT;
  const windowMs = overrides.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const corsOrigin =
    overrides.corsOrigin ?? (env.HDV_CORS_ORIGIN && env.HDV_CORS_ORIGIN.trim().length > 0
      ? env.HDV_CORS_ORIGIN.trim()
      : DEFAULT_CORS_ORIGIN);

  return { apiKey, rateLimit, windowMs, corsOrigin };
}

/** A single request's cross-cutting inputs, decoupled from node:http for testability. */
export interface GuardRequest {
  method: string;
  pathname: string;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}

export interface GuardOutcome {
  /** Headers to merge onto every response (CORS, rate-limit metadata). */
  headers: Record<string, string>;
  /** When set, short-circuit the request with this response (401 / 429 / 204 preflight). */
  response?: GatewayResponse;
}

export interface LogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ip: string;
  authState: 'disabled' | 'authorized' | 'rejected' | 'public';
}

export type GatewayLogger = (entry: LogEntry) => void;

/** Default logger: single-line JSON to stdout. Secrets are never included in LogEntry. */
export const defaultLogger: GatewayLogger = (entry) => {
  console.log(JSON.stringify({ gateway: 'hope', ...entry }));
};

interface RateBucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window, per-IP in-memory rate limiter. Not distributed — one process, one map.
 * Buckets are lazily reset when their window elapses; stale buckets are swept opportunistically.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record a hit for `ip`. Returns whether it is allowed plus bucket metadata. */
  hit(ip: string, now: number = Date.now()): { allowed: boolean; remaining: number; resetAt: number; limit: number } {
    // Non-positive limits disable rate limiting entirely.
    if (this.limit <= 0) {
      return { allowed: true, remaining: Infinity, resetAt: now + this.windowMs, limit: this.limit };
    }

    let bucket = this.buckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(ip, bucket);
    }
    bucket.count += 1;

    if (this.buckets.size > 10_000) this.sweep(now);

    const allowed = bucket.count <= this.limit;
    const remaining = Math.max(0, this.limit - bucket.count);
    return { allowed, remaining, resetAt: bucket.resetAt, limit: this.limit };
  }

  /** Drop buckets whose window has fully elapsed to bound memory. */
  private sweep(now: number): void {
    for (const [ip, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(ip);
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * The gateway's HTTP front door. Applies CORS, auth, and rate limiting and knows which paths
 * are always public. Handlers remain untouched and unaware of any of this.
 */
export class GatewayMiddleware {
  readonly config: GatewaySecurityConfig;
  private readonly limiter: RateLimiter;

  constructor(config: GatewaySecurityConfig) {
    this.config = config;
    this.limiter = new RateLimiter(config.rateLimit, config.windowMs);
  }

  /** True when no API key is configured (dev mode — auth disabled). */
  get authDisabled(): boolean {
    return !this.config.apiKey;
  }

  /** Whether a path bypasses auth and rate limiting (health probes). */
  isPublicPath(pathname: string): boolean {
    return ALWAYS_PUBLIC_PATHS.has(pathname);
  }

  /** Whether a path bypasses AUTH but is still rate-limited (public write surfaces). */
  isAuthExemptPath(pathname: string): boolean {
    return ALWAYS_PUBLIC_PATHS.has(pathname) || AUTH_EXEMPT_PATHS.has(pathname);
  }

  /** Base CORS headers applied to every response. */
  corsHeaders(): Record<string, string> {
    return {
      'access-control-allow-origin': this.config.corsOrigin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization, X-HDV-Key, X-HDV-Tenant',
      'access-control-max-age': '600',
      vary: 'Origin',
    };
  }

  /**
   * Run all front-door guards for a request. Returns headers to merge and, if the request
   * should be short-circuited (preflight / 401 / 429), a ready-made response.
   */
  guard(req: GuardRequest, now: number = Date.now()): GuardOutcome {
    const headers = this.corsHeaders();

    // CORS preflight — answer before auth so browsers can negotiate.
    if (req.method.toUpperCase() === 'OPTIONS') {
      return { headers, response: { status: 204, body: {} } };
    }

    const isPublic = this.isPublicPath(req.pathname);

    // Rate limit first (health exempt) so a flood of bad keys can't exhaust resources...
    if (!isPublic) {
      const rl = this.limiter.hit(req.ip, now);
      if (Number.isFinite(rl.remaining)) {
        headers['x-ratelimit-limit'] = String(rl.limit);
        headers['x-ratelimit-remaining'] = String(rl.remaining);
        headers['x-ratelimit-reset'] = String(Math.ceil(rl.resetAt / 1000));
      }
      if (!rl.allowed) {
        const retryAfter = Math.max(1, Math.ceil((rl.resetAt - now) / 1000));
        headers['retry-after'] = String(retryAfter);
        return {
          headers,
          response: {
            status: 429,
            body: { error: 'rate limit exceeded', limit: rl.limit, retryAfterSeconds: retryAfter },
          },
        };
      }
    }

    // ...then auth (health + auth-exempt public writes exempt, dev mode exempt).
    if (!this.isAuthExemptPath(req.pathname) && !this.authDisabled) {
      const presented = extractKey(req.headers);
      if (!presented || !keysMatch(presented, this.config.apiKey as string)) {
        return {
          headers,
          response: {
            status: 401,
            body: {
              error: 'unauthorized',
              hint: 'provide a valid key via X-HDV-Key or Authorization: Bearer <key>',
            },
          },
        };
      }
    }

    return { headers };
  }

  /** Classify the auth state of a (non-short-circuited) request for logging. */
  authState(req: GuardRequest): LogEntry['authState'] {
    if (this.isAuthExemptPath(req.pathname)) return 'public';
    if (this.authDisabled) return 'disabled';
    const presented = extractKey(req.headers);
    return presented && keysMatch(presented, this.config.apiKey as string) ? 'authorized' : 'rejected';
  }

  resetRateLimiter(): void {
    this.limiter.reset();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Extract a presented API key from X-HDV-Key or a Bearer Authorization header. */
export function extractKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const direct = firstHeader(headers['x-hdv-key']);
  if (direct && direct.trim().length > 0) return direct.trim();

  const auth = firstHeader(headers['authorization']);
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match && match[1].trim().length > 0) return match[1].trim();
  }
  return undefined;
}

/** Constant-time-ish comparison to avoid leaking key length via early-exit timing. */
export function keysMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Best-effort client IP from an x-forwarded-for chain, falling back to the socket address. */
export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
): string {
  const fwd = firstHeader(headers['x-forwarded-for']);
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return socketAddress ?? 'unknown';
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const floored = Math.floor(n);
  return floored >= 0 ? floored : undefined;
}
