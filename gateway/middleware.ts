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
 *     POST /v1/auth/{signup,login} carry a SECOND, stricter per-IP limiter on top of the
 *     generic one (HDV_AUTH_RATE_LIMIT, default 10/min) — a shared VPS is a realistic
 *     credential-stuffing target and the generic limit is sized for normal traffic, not that.
 *   - Per-TENANT in-memory rate limiting (HDV_TENANT_RATE_LIMIT, default 20/min), ADDITIVE to
 *     the per-IP limiter above and scoped to the companion + billing/checkout product routes
 *     (see TENANT_RATE_LIMITED_PATHS). A shared VPS/NAT means many distinct users can share one
 *     IP, so the per-IP bucket alone can unfairly starve one tenant's traffic on another's
 *     behalf; keying a SECOND bucket by X-HDV-Tenant fixes that without weakening the per-IP
 *     check (which still guards against one client hammering many fake tenant ids).
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
/** Default per-tenant requests-per-window when HDV_TENANT_RATE_LIMIT is unset/invalid. */
export const DEFAULT_TENANT_RATE_LIMIT = 20;
/** Rate-limit window length. Phase 4.1 uses a fixed one-minute window (shared by both limiters). */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** Default CORS origin when HDV_CORS_ORIGIN is unset. */
export const DEFAULT_CORS_ORIGIN = '*';
/**
 * Default requests-per-window for POST /v1/auth/signup and /v1/auth/login specifically, when
 * HDV_AUTH_RATE_LIMIT is unset/invalid. Deliberately much stricter than DEFAULT_RATE_LIMIT: the
 * generic per-IP limiter is shared across every route and sized for normal traffic, not
 * credential-stuffing — a shared VPS is a realistic target for exactly that. This is a SECOND,
 * additive limiter (same RateLimiter mechanism, its own bucket set) checked only for those two
 * paths; the generic limiter still applies to them too.
 */
export const DEFAULT_AUTH_RATE_LIMIT = 10;

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
  // Streaming (SSE) twin of /v1/companion/chat — same public-but-rate-limited posture; see
  // gateway/server.ts's COMPANION_CHAT_STREAM_PATH and serveCompanionChatStream.
  '/v1/companion/chat/stream',
  '/v1/companion/portrait',
  '/v1/companion/scene',
  '/v1/companion/memory',
  '/v1/companion/speak',
  // Checkout is public because FuckLike/web has no user-account/API-key system yet — it sends
  // a per-browser anonymous tenant id via X-HDV-Tenant instead (see web/app.js). Safe today
  // because billing/stripe_stub.ts is a stub with no real STRIPE_SECRET_KEY (no money moves).
  // MUST be revisited before going live with a real Stripe key: checkout/settle in particular
  // needs to move to a real, signature-verified Stripe webhook rather than staying
  // client-callable — see the handler's doc comment in gateway/server.ts.
  '/v1/billing/checkout',
  '/v1/billing/checkout/settle',
  // Auth (auth/) — these four routes ARE the auth system, so they can't require the HDV_API_KEY
  // gate themselves (a client has no session/key yet when calling signup/login, and logout/me
  // authenticate via their OWN X-HDV-Session bearer token, not the operator's HDV_API_KEY). All
  // four stay rate-limited (see AUTH_RATE_LIMITED_PATHS below for signup/login's tighter cap).
  // NOT wired into billing/checkout's X-HDV-Tenant resolution yet — see the TODO in
  // gateway/server.ts by handleBillingCheckout.
  '/v1/auth/signup',
  '/v1/auth/login',
  '/v1/auth/logout',
  '/v1/auth/me',
  // *** '/v1/creator/webhooks/stripe' — READ THIS BEFORE ADDING ANOTHER ENTRY BELOW IT ***
  //
  // Stripe calls this route directly, server-to-server, with NO X-HDV-Session and NO
  // HDV_API_KEY — it cannot present either. This is exempt from THIS app's auth ONLY because
  // the handler (creator/stripe_webhook.ts's handleStripeWebhook) verifies the `stripe-signature`
  // header via the Stripe SDK's own `stripe.webhooks.constructEvent()` BEFORE trusting a single
  // field of the request body; an invalid/missing/forged signature is rejected with 400 and
  // nothing in the payload is ever read. That cryptographic signature check IS this route's
  // auth — it is simply a DIFFERENT auth mechanism than the rest of this file, not an absence
  // of one.
  //
  // Every OTHER entry in this set is exempt because it is genuinely a public surface (a form
  // anonymous visitors submit, a product endpoint with no account system yet). This one is NOT
  // that — do not treat it as precedent for adding another route here "because it's convenient".
  // If you're adding a new unauthenticated route, ask: does it independently verify who's
  // calling it (like this one does), or is it just... open? Only the former belongs here for
  // that reason.
  '/v1/creator/webhooks/stripe',
]);

/**
 * The brute-force-sensitive subset of AUTH_EXEMPT_PATHS: signup and login accept a password
 * guess directly, so they get their OWN, stricter per-IP limiter in addition to the generic one
 * (see DEFAULT_AUTH_RATE_LIMIT). logout/me don't guess credentials, so the generic limiter alone
 * covers them.
 */
const AUTH_RATE_LIMITED_PATHS = new Set<string>(['/v1/auth/signup', '/v1/auth/login']);

/**
 * Paths that get a SECOND, per-tenant rate-limit check (keyed by X-HDV-Tenant), additive to
 * the always-on per-IP limiter. These are the companion product surfaces and the checkout
 * surface — the routes a single shared VPS IP (many tenants behind one NAT) could otherwise
 * unfairly ration between tenants, or a single bad tenant could hammer regardless of how many
 * IPs it rotates through. Deliberately narrower than AUTH_EXEMPT_PATHS: /v1/waitlist is a
 * one-shot signup form, not a per-tenant metered surface, so it stays IP-limited only.
 */
const TENANT_RATE_LIMITED_PATHS = new Set<string>([
  '/v1/companion/chat',
  '/v1/companion/portrait',
  '/v1/companion/scene',
  '/v1/billing/checkout',
  '/v1/billing/checkout/settle',
]);

export interface GatewaySecurityConfig {
  /** API key required on protected routes. Empty/undefined ⇒ dev mode (auth disabled). */
  apiKey?: string;
  /** Max requests per window per client IP. */
  rateLimit: number;
  /** Max requests per window per tenant (X-HDV-Tenant), additive on TENANT_RATE_LIMITED_PATHS. */
  tenantRateLimit: number;
  /** Window length in ms for both rate limiters. */
  windowMs: number;
  /** Value for the Access-Control-Allow-Origin header. */
  corsOrigin: string;
  /** Max requests per window per client IP, specifically for POST /v1/auth/{signup,login}. */
  authRateLimit: number;
}

export interface SecurityOverrides {
  apiKey?: string;
  rateLimit?: number;
  tenantRateLimit?: number;
  windowMs?: number;
  corsOrigin?: string;
  authRateLimit?: number;
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
  const tenantRateLimit =
    overrides.tenantRateLimit ?? parsePositiveInt(env.HDV_TENANT_RATE_LIMIT) ?? DEFAULT_TENANT_RATE_LIMIT;
  const windowMs = overrides.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const corsOrigin =
    overrides.corsOrigin ?? (env.HDV_CORS_ORIGIN && env.HDV_CORS_ORIGIN.trim().length > 0
      ? env.HDV_CORS_ORIGIN.trim()
      : DEFAULT_CORS_ORIGIN);
  const authRateLimit =
    overrides.authRateLimit ?? parsePositiveInt(env.HDV_AUTH_RATE_LIMIT) ?? DEFAULT_AUTH_RATE_LIMIT;

  return { apiKey, rateLimit, tenantRateLimit, windowMs, corsOrigin, authRateLimit };
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
  /** ISO-8601 timestamp of when the request finished, e.g. "2026-08-10T14:03:21.045Z". Greppable
   *  by day/hour prefix (`grep '"timestamp":"2026-08-10T14'`) without parsing epoch millis. */
  timestamp: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ip: string;
  authState: 'disabled' | 'authorized' | 'rejected' | 'public';
  /** X-HDV-Tenant, when the caller actually sent one (billing/companion routes). Omitted
   *  entirely (not "demo") for requests that carried no tenant header, so a `grep tenant`
   *  only surfaces genuinely tenant-scoped traffic. */
  tenant?: string;
}

export type GatewayLogger = (entry: LogEntry) => void;

/**
 * Default logger: single-line JSON to stdout, one line per request. Deliberately dependency-free
 * (`console.log(JSON.stringify(...))`) so it needs no logging library and stays trivially
 * greppable via `docker logs <container> | grep ...` — e.g. `grep '"status":429'` for rate-limit
 * hits, `grep '"tenant":"<id>"'` for one tenant's traffic, or `grep '"timestamp":"2026-08-10T14'`
 * for one hour. Secrets are never included in LogEntry.
 */
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
  /** Second, stricter limiter for POST /v1/auth/{signup,login} — see AUTH_RATE_LIMITED_PATHS. */
  private readonly authLimiter: RateLimiter;
  private readonly tenantLimiter: RateLimiter;

  constructor(config: GatewaySecurityConfig) {
    this.config = config;
    this.limiter = new RateLimiter(config.rateLimit, config.windowMs);
    this.authLimiter = new RateLimiter(config.authRateLimit, config.windowMs);
    this.tenantLimiter = new RateLimiter(config.tenantRateLimit, config.windowMs);
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

  /** Whether a path gets the SECOND, per-tenant rate-limit check (additive to per-IP). */
  isTenantRateLimitedPath(pathname: string): boolean {
    return TENANT_RATE_LIMITED_PATHS.has(pathname);
  }

  /** Base CORS headers applied to every response. */
  corsHeaders(): Record<string, string> {
    return {
      'access-control-allow-origin': this.config.corsOrigin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization, X-HDV-Key, X-HDV-Tenant, X-HDV-Session',
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

      // Extra-strict, additive limiter for the credential-guessing surface (signup/login).
      if (AUTH_RATE_LIMITED_PATHS.has(req.pathname)) {
        const authRl = this.authLimiter.hit(req.ip, now);
        if (Number.isFinite(authRl.remaining)) {
          headers['x-ratelimit-auth-limit'] = String(authRl.limit);
          headers['x-ratelimit-auth-remaining'] = String(authRl.remaining);
        }
        if (!authRl.allowed) {
          const retryAfter = Math.max(1, Math.ceil((authRl.resetAt - now) / 1000));
          headers['retry-after'] = String(retryAfter);
          return {
            headers,
            response: {
              status: 429,
              body: {
                error: 'rate limit exceeded for authentication endpoints',
                limit: authRl.limit,
                retryAfterSeconds: retryAfter,
              },
            },
          };
        }
      }
    }

    // ...then the SECOND, additive per-tenant check on the narrower set of product/checkout
    // routes (still after the per-IP check above, which stays the first line of defense against
    // one client rotating through many fake tenant ids). Keyed by X-HDV-Tenant so many distinct
    // tenants sharing one shared-VPS/NAT IP each get their own budget instead of splitting one.
    if (!isPublic && this.isTenantRateLimitedPath(req.pathname)) {
      const tenantId = tenantFromHeaders(req.headers);
      const rl = this.tenantLimiter.hit(`tenant:${tenantId}`, now);
      if (Number.isFinite(rl.remaining)) {
        headers['x-ratelimit-tenant-limit'] = String(rl.limit);
        headers['x-ratelimit-tenant-remaining'] = String(rl.remaining);
        headers['x-ratelimit-tenant-reset'] = String(Math.ceil(rl.resetAt / 1000));
      }
      if (!rl.allowed) {
        const retryAfter = Math.max(1, Math.ceil((rl.resetAt - now) / 1000));
        headers['retry-after'] = String(retryAfter);
        return {
          headers,
          response: {
            status: 429,
            body: {
              error: 'tenant rate limit exceeded',
              tenantId,
              limit: rl.limit,
              retryAfterSeconds: retryAfter,
            },
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
    this.authLimiter.reset();
    this.tenantLimiter.reset();
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

/**
 * Raw X-HDV-Tenant header value (trimmed), or undefined when absent/blank. Unlike
 * `tenantFromHeaders` below this does NOT default to "demo" — it's used for logging so a log
 * entry only carries a `tenant` field when the caller actually sent one.
 */
export function rawTenantId(headers: Record<string, string | string[] | undefined>): string | undefined {
  const trimmed = firstHeader(headers['x-hdv-tenant'])?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the tenant id from the X-HDV-Tenant header (default "demo"). Shared by the billing
 * routes (gateway/server.ts) and the per-tenant rate limiter above so both agree on identity.
 */
export function tenantFromHeaders(headers?: Record<string, string | string[] | undefined>): string {
  if (!headers) return 'demo';
  return rawTenantId(headers) ?? 'demo';
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const floored = Math.floor(n);
  return floored >= 0 ? floored : undefined;
}
