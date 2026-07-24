/**
 * @big5-matrix/sdk — a typed, fetch-based client for the HDV (Big 5 Matrix) HOPE gateway.
 *
 * This is the OPEN, public client the platform's `/v1` surface is meant to be consumed through.
 * It talks ONLY to the gateway over HTTP — it imports NO agent internals (no APEX router, no
 * KNOLL engine, no node fleet). Every method maps to one `/v1` route and returns a typed
 * response. It is dependency-free: it uses the global `fetch` (Node >= 18 / all modern
 * browsers). Pass a custom `fetch` in options for older runtimes or testing.
 *
 * Covered routes:
 *   - POST /v1/intent               submit a natural-language intent (HOPE → APEX → KNOLL)
 *   - GET  /v1/health               always-on/ephemeral agent health + KNOLL gate state
 *   - GET  /v1/metrics              observability snapshot (JSON) or Prometheus text
 *   - GET  /v1/billing/usage        a tenant's balance + recent occurrences
 *   - GET  /v1/billing/pricing      the public pricing table
 *   - GET  /v1/billing/estimate     cost estimate for a hypothetical unit of work
 *   - POST /v1/billing/allowance    set/adjust a tenant's allowance
 *   - POST /v1/waitlist             public waitlist signup
 *   - GET  /v1/waitlist/stats       privacy-safe aggregate signup stats
 */

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

/** Minimal fetch signature the client depends on (a subset of the WHATWG fetch). */
export type FetchLike = (input: string, init?: FetchInit) => Promise<FetchResponse>;

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
}

export interface FetchResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}

export interface HdvClientOptions {
  /** Gateway base URL, e.g. "http://localhost:8787". Trailing slash is trimmed. */
  baseUrl: string;
  /** Bearer token / API key sent as `Authorization: Bearer <token>` when set. */
  apiKey?: string;
  /** Default tenant id sent as the `X-HDV-Tenant` header on tenant-scoped routes. */
  tenantId?: string;
  /** Override the fetch implementation (defaults to global `fetch`). */
  fetch?: FetchLike;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

/** Error thrown when the gateway returns a non-2xx status. Carries the parsed body. */
export class HdvApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly path: string;
  constructor(status: number, path: string, body: unknown) {
    const detail =
      body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${status}`;
    super(`HDV ${path} failed (${status}): ${detail}`);
    this.name = 'HdvApiError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Response types (mirror the gateway handlers; intentionally permissive at the edges)
// ---------------------------------------------------------------------------

export interface KnollVerdict {
  isAllowed: boolean;
  reasoning?: string | null;
  enforcedConstraints?: string[];
}

export interface IntentResponse {
  accepted: boolean;
  dispatched: boolean;
  clarificationNeeded?: boolean;
  routingStatus?: 'SUCCESS' | 'BLOCKED' | 'FAILED' | 'HELD';
  knoll?: KnollVerdict | null;
  voice?: string;
  intent?: Record<string, unknown>;
  documentId?: string;
}

export interface HealthResponse {
  ok: boolean;
  time: number;
  alwaysOn: Array<{ role: string; lifecycle: string; status: string }>;
  ephemeral: Array<{ role: string; lifecycle: string; idle: boolean; lastActiveAgoMs: number | null }>;
  knollGate: string;
}

export interface MetricsSnapshot {
  [key: string]: unknown;
}

export interface BillingBalance {
  tenantId: string;
  tier: string;
  [key: string]: unknown;
}

export interface BillingUsageResponse {
  tenantId: string;
  balance: BillingBalance;
  meter: Record<string, unknown>;
  occurrences: unknown[];
}

export interface BillingEstimateInput {
  activeParams: number;
  durationSec: number;
  model?: string;
  tier?: string;
}

export interface WaitlistSignupInput {
  email: string;
  name?: string;
  company?: string;
  interestedTier?: string;
  useCase?: string;
  source?: string;
  referral?: string;
}

export interface WaitlistSignupResponse {
  created: boolean;
  duplicate: boolean;
  entry: Record<string, unknown>;
  position: number;
}

export interface WaitlistStatsResponse {
  total: number;
  bySource: Record<string, number>;
  byTier: Record<string, number>;
  last24h: number;
  last7d: number;
  firstAt: number | null;
  lastAt: number | null;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class HdvClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly tenantId?: string;
  private readonly doFetch: FetchLike;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: HdvClientOptions) {
    if (!options || typeof options.baseUrl !== 'string' || options.baseUrl.length === 0) {
      throw new Error('HdvClient requires a baseUrl');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.tenantId = options.tenantId;
    this.extraHeaders = options.headers ?? {};
    const f = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) {
      throw new Error('No fetch implementation available; pass options.fetch');
    }
    this.doFetch = f;
  }

  // -- Intent --------------------------------------------------------------

  /** POST /v1/intent — submit a natural-language utterance for HOPE to interpret and route. */
  submitIntent(utterance: string): Promise<IntentResponse> {
    return this.request<IntentResponse>('POST', '/v1/intent', { body: { utterance } });
  }

  // -- Health / metrics ----------------------------------------------------

  /** GET /v1/health — resident-agent health and KNOLL gate state. */
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/v1/health');
  }

  /** GET /v1/metrics — observability snapshot (JSON). */
  metrics(): Promise<MetricsSnapshot> {
    return this.request<MetricsSnapshot>('GET', '/v1/metrics');
  }

  /** GET /v1/metrics?format=prometheus — raw Prometheus exposition text. */
  async metricsPrometheus(): Promise<string> {
    const res = await this.raw('GET', '/v1/metrics?format=prometheus');
    const text = await res.text();
    if (!res.ok) throw new HdvApiError(res.status, '/v1/metrics', text);
    return text;
  }

  // -- Billing -------------------------------------------------------------

  /** GET /v1/billing/usage — the (tenant's) balance, meter, and recent occurrences. */
  billingUsage(opts: { tenantId?: string; limit?: number } = {}): Promise<BillingUsageResponse> {
    const query = opts.limit !== undefined ? { limit: String(opts.limit) } : undefined;
    return this.request<BillingUsageResponse>('GET', '/v1/billing/usage', { query, tenantId: opts.tenantId });
  }

  /** GET /v1/billing/pricing — the public pricing table (no tenant needed). */
  billingPricing(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/v1/billing/pricing');
  }

  /** GET /v1/billing/estimate — a cost estimate for a hypothetical unit of work. */
  billingEstimate(input: BillingEstimateInput, opts: { tenantId?: string } = {}): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/v1/billing/estimate', { body: input, tenantId: opts.tenantId });
  }

  /** POST /v1/billing/allowance — set/adjust a tenant's allowance. */
  setBillingAllowance(
    input: { tier?: string; includedAllowanceUsd?: number; hardCapUsd?: number | null },
    opts: { tenantId?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('POST', '/v1/billing/allowance', { body: input, tenantId: opts.tenantId });
  }

  // -- Waitlist ------------------------------------------------------------

  /** POST /v1/waitlist — record a public waitlist signup (idempotent by email). */
  waitlistSignup(input: WaitlistSignupInput): Promise<WaitlistSignupResponse> {
    return this.request<WaitlistSignupResponse>('POST', '/v1/waitlist', { body: input });
  }

  /** GET /v1/waitlist/stats — privacy-safe aggregate signup stats. */
  waitlistStats(): Promise<WaitlistStatsResponse> {
    return this.request<WaitlistStatsResponse>('GET', '/v1/waitlist/stats');
  }

  // -----------------------------------------------------------------------
  // internals
  // -----------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string>; tenantId?: string } = {},
  ): Promise<T> {
    let full = path;
    if (opts.query && Object.keys(opts.query).length > 0) {
      const qs = new URLSearchParams(opts.query).toString();
      full += (path.includes('?') ? '&' : '?') + qs;
    }
    const res = await this.raw(method, full, opts.body, opts.tenantId);
    const text = await res.text();
    const parsed = text.length ? safeJson(text) : undefined;
    if (!res.ok) {
      throw new HdvApiError(res.status, path, parsed ?? text);
    }
    return parsed as T;
  }

  private raw(method: string, path: string, body?: unknown, tenantId?: string): Promise<FetchResponse> {
    const headers: Record<string, string> = { accept: 'application/json', ...this.extraHeaders };
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
    const tenant = tenantId ?? this.tenantId;
    if (tenant) headers['x-hdv-tenant'] = tenant;
    const init: FetchInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return this.doFetch(`${this.baseUrl}${path}`, init);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Convenience factory. */
export function createHdvClient(options: HdvClientOptions): HdvClient {
  return new HdvClient(options);
}
