/**
 * gateway/deep_health.ts — GET /v1/health/deep: per-dependency reachability diagnostics.
 *
 * MOTIVATION: companion chat can silently degrade to canned fallback replies (see
 * companion/chat_handlers.ts's `source: 'fallback'`) with no signal visible from OUTSIDE the
 * process about WHY — rate limit? Ollama down? OOM? network? The non-technical operator's only
 * tool is `docker logs`, and they cannot SSH in and guess. This endpoint answers "what's
 * actually reachable right now" in one request: Postgres, Redis, and whichever LLM/image/video
 * backend is configured (or `"skipped": true` when a dependency isn't configured at all).
 *
 * DISTINCT FROM GET /v1/health: that endpoint stays always-fast and always-public (a liveness
 * probe — "is the process alive"). This one is slower (it makes real network calls), so it is
 * PROTECTED (requires the API key, same as /v1/matrix/stats) and BOUNDED — every check races a
 * shared timeout and the whole thing runs in parallel, so a single stuck dependency can never
 * hang the response past `timeoutMs` (default 4s).
 *
 * Each provider check is a cheap reachability probe only:
 *   - openai_compatible (Ollama et al.): GET {baseUrl}/models — never a chat completion.
 *   - colab_tunnel (image/video): GET {baseUrl}/health — the FastAPI servers in
 *     colab/07_portrait_server.py and colab/08_scene_server.py both expose this route.
 *   - google_ai_studio: no free reachability probe exists (any real call is billed against the
 *     API key's quota), so it reports `skipped: true` with a `detail` explaining why rather than
 *     a false failure.
 *   - stub providers (the offline default) are treated the same as "not configured" — there is
 *     nothing to reach.
 *
 * Zero new dependencies: Postgres uses the already-bundled `@prisma/client`; Redis uses a raw
 * `node:net` TCP + RESP PING (no `redis`/`ioredis` package exists in this repo today — see
 * persistence/redis_router_stub.ts, which is a pure in-memory stub that never reads REDIS_URL).
 */
import net from 'node:net';
import { PrismaClient } from '@prisma/client';
import type { LlmProvider } from '../providers/types.js';
import type { ImageProvider } from '../providers/image_types.js';
import type { VideoProvider } from '../providers/video_types.js';

/** Overall budget for GET /v1/health/deep, shared across all checks (they run in parallel). */
export const DEFAULT_DEEP_HEALTH_TIMEOUT_MS = 4_000;

export interface DeepCheckResult {
  /** Whether this dependency has any configuration at all (env var set / non-stub provider). */
  configured: boolean;
  /** True when no reachability probe ran — either unconfigured, or (google_ai_studio) no cheap
   *  probe exists. Skipped checks are never counted against the overall `ok`. */
  skipped: boolean;
  /** Meaningful only when `skipped` is false: whether the probe considered the dependency reachable. */
  ok: boolean;
  detail?: string;
  latencyMs?: number;
}

export interface DeepHealthChecks {
  postgres: DeepCheckResult;
  redis: DeepCheckResult;
  llm: DeepCheckResult;
  image: DeepCheckResult;
  video: DeepCheckResult;
}

export interface DeepHealthReport {
  /** True only when every CONFIGURED, non-skipped dependency reported ok. */
  ok: boolean;
  checks: DeepHealthChecks;
  timestamp: string;
}

/** A minimal, injectable probe result shape (before the bookkeeping fields are layered on). */
export interface ProbeResult {
  ok: boolean;
  detail?: string;
}

export interface DeepHealthOptions {
  /** Postgres connection string. Omit/empty ⇒ postgres check is skipped (unconfigured). */
  databaseUrl?: string;
  /** Redis connection string. Omit/empty ⇒ redis check is skipped (unconfigured). */
  redisUrl?: string;
  /** The gateway's configured LlmProvider (undefined or name === "stub" ⇒ skipped). */
  llmProvider?: LlmProvider;
  /** The gateway's configured ImageProvider (undefined or name === "stub" ⇒ skipped). */
  imageProvider?: ImageProvider;
  /** The gateway's configured VideoProvider (undefined or name === "stub" ⇒ skipped). */
  videoProvider?: VideoProvider;
  /** Shared timeout across every check, in ms. Defaults to DEFAULT_DEEP_HEALTH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injectable fetch (used for the LLM/image/video HTTP reachability probes). Handy for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable Postgres probe (defaults to a `SELECT 1` via a short-lived PrismaClient). Handy for tests. */
  checkPostgres?: (databaseUrl: string) => Promise<ProbeResult>;
  /** Injectable Redis probe (defaults to a raw TCP + RESP PING). Handy for tests. */
  checkRedis?: (redisUrl: string) => Promise<ProbeResult>;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runDeepHealthChecks(options: DeepHealthOptions = {}): Promise<DeepHealthReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DEEP_HEALTH_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const checkPostgresFn = options.checkPostgres ?? checkPostgresDefault;
  const checkRedisFn = options.checkRedis ?? checkRedisDefault;

  // Every check runs concurrently (Promise.all) and every check's own promise is individually
  // raced against `timeoutMs` (withTimeout), so the slowest possible wall-clock time for this
  // whole function is `timeoutMs` regardless of how many dependencies are configured or how
  // badly any single one is stuck.
  const [postgres, redis, llm, image, video] = await Promise.all([
    checkPostgresDependency(options.databaseUrl, checkPostgresFn, timeoutMs),
    checkRedisDependency(options.redisUrl, checkRedisFn, timeoutMs),
    checkLlmDependency(options.llmProvider, fetchImpl, timeoutMs),
    checkImageDependency(options.imageProvider, fetchImpl, timeoutMs),
    checkVideoDependency(options.videoProvider, fetchImpl, timeoutMs),
  ]);

  const checks: DeepHealthChecks = { postgres, redis, llm, image, video };
  const ok = Object.values(checks).every((c) => c.skipped || c.ok);
  return { ok, checks, timestamp: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Per-dependency wrappers — decide configured/skipped, then delegate to boundedCheck.
// ---------------------------------------------------------------------------

async function checkPostgresDependency(
  databaseUrl: string | undefined,
  probe: (url: string) => Promise<ProbeResult>,
  timeoutMs: number,
): Promise<DeepCheckResult> {
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    return { configured: false, skipped: true, ok: true };
  }
  return boundedCheck(() => probe(databaseUrl), timeoutMs);
}

async function checkRedisDependency(
  redisUrl: string | undefined,
  probe: (url: string) => Promise<ProbeResult>,
  timeoutMs: number,
): Promise<DeepCheckResult> {
  if (!redisUrl || redisUrl.trim().length === 0) {
    return { configured: false, skipped: true, ok: true };
  }
  return boundedCheck(() => probe(redisUrl), timeoutMs);
}

async function checkLlmDependency(
  provider: LlmProvider | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DeepCheckResult> {
  if (!provider || provider.name === 'stub') return { configured: false, skipped: true, ok: true };
  const endpoint = providerEndpoint(provider);
  if (!endpoint) {
    return { configured: true, skipped: true, ok: true, detail: 'no base URL available on the configured provider' };
  }
  return boundedCheck(() => checkHttpReachable(llmModelsUrl(endpoint), fetchImpl), timeoutMs);
}

async function checkImageDependency(
  provider: ImageProvider | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DeepCheckResult> {
  if (!provider || provider.name === 'stub') return { configured: false, skipped: true, ok: true };
  if (provider.name !== 'colab_tunnel') {
    // e.g. google_ai_studio: any real call is billed against the API key's quota, so there is
    // no genuinely free/cheap reachability probe. Report honestly rather than guessing.
    return {
      configured: true,
      skipped: true,
      ok: true,
      detail: `no cheap reachability check implemented for image provider "${provider.name}" (would require a billed API call)`,
    };
  }
  const endpoint = providerEndpoint(provider);
  if (!endpoint) {
    return { configured: true, skipped: true, ok: true, detail: 'no base URL available on the configured provider' };
  }
  return boundedCheck(() => checkHttpReachable(colabHealthUrl(endpoint), fetchImpl), timeoutMs);
}

async function checkVideoDependency(
  provider: VideoProvider | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DeepCheckResult> {
  if (!provider || provider.name === 'stub') return { configured: false, skipped: true, ok: true };
  // video_factory.ts only ever builds "stub" | "colab_tunnel" — no third kind to special-case.
  const endpoint = providerEndpoint(provider);
  if (!endpoint) {
    return { configured: true, skipped: true, ok: true, detail: 'no base URL available on the configured provider' };
  }
  return boundedCheck(() => checkHttpReachable(colabHealthUrl(endpoint), fetchImpl), timeoutMs);
}

/** Run `fn`, bounded by `timeoutMs`, and shape the result as a configured/non-skipped DeepCheckResult. */
async function boundedCheck(fn: () => Promise<ProbeResult>, timeoutMs: number): Promise<DeepCheckResult> {
  const start = Date.now();
  const guarded = fn().catch(
    (err): ProbeResult => ({ ok: false, detail: redactCredentials(errorMessage(err)) }),
  );
  const result = await withTimeout(guarded, timeoutMs, {
    ok: false,
    detail: `timed out after ${timeoutMs}ms`,
  });
  return {
    configured: true,
    skipped: false,
    ok: result.ok,
    detail: result.detail ? redactCredentials(result.detail) : undefined,
    latencyMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Default probes
// ---------------------------------------------------------------------------

/** Cheap Postgres reachability probe: `SELECT 1` over a short-lived PrismaClient, then disconnect. */
async function checkPostgresDefault(databaseUrl: string): Promise<ProbeResult> {
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await client.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: errorMessage(err) };
  } finally {
    // Fire-and-forget: never block the health response on teardown of a client we may already
    // be walking away from (e.g. the outer timeout won the race).
    void client.$disconnect().catch(() => {});
  }
}

/**
 * Cheap Redis reachability probe: raw TCP connect + a RESP `PING`, no `redis`/`ioredis`
 * dependency (none exists in this repo — see the module doc comment). Any RESP reply (`+PONG`,
 * `-NOAUTH ...`, `-ERR ...`) proves a live Redis-speaking peer answered; a bare TCP accept with
 * no RESP reply, a connection error, or a timeout all count as unreachable.
 */
function checkRedisDefault(redisUrl: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let host: string;
    let port: number;
    try {
      const parsed = new URL(redisUrl);
      host = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : 6379;
    } catch {
      resolve({ ok: false, detail: 'invalid REDIS_URL (could not parse host/port)' });
      return;
    }

    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(3_000);
    socket.once('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'));
    socket.once('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const isResp = text.startsWith('+') || text.startsWith('-') || text.startsWith(':');
      finish({ ok: isResp, detail: isResp ? undefined : `unexpected reply: ${text.slice(0, 80)}` });
    });
    socket.once('error', (err) => finish({ ok: false, detail: err.message }));
    socket.once('timeout', () => finish({ ok: false, detail: 'connection timed out' }));
    socket.once('close', () => finish({ ok: false, detail: 'connection closed before any reply' }));
  });
}

/** Cheap HTTP reachability probe: any HTTP response (even 401/404) proves the network path and
 *  HTTP stack are alive — this is a reachability check, not an authorization check. */
async function checkHttpReachable(url: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(url, { method: 'GET' });
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: errorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Race `promise` against a timer; resolves with `fallback` if the timer wins. Never leaves a
 *  dangling timer: whichever settles first clears/consumes the other. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** Best-effort URL extraction from a provider's `toJSON()` (url for chat/generate providers,
 *  baseUrl for google_ai_studio). Not part of the LlmProvider/ImageProvider/VideoProvider
 *  interfaces (they only require name/model/complete|generate), so this narrows defensively. */
function providerEndpoint(provider: unknown): string | undefined {
  const p = provider as { toJSON?: () => { url?: string; baseUrl?: string } };
  if (typeof p?.toJSON !== 'function') return undefined;
  const json = p.toJSON();
  return json.url ?? json.baseUrl;
}

/** OpenAiCompatibleProvider.toJSON().url is the full chat-completions URL; derive the
 *  standard OpenAI-compatible models-list URL from it (works for Ollama too). */
function llmModelsUrl(chatCompletionsUrl: string): string {
  return `${chatCompletionsUrl.replace(/\/chat\/completions\/?$/, '')}/models`;
}

/** ColabTunnel{Image,Video}Provider.toJSON().url is the full /generate URL; derive the
 *  /health URL both colab/07_portrait_server.py and colab/08_scene_server.py expose. */
function colabHealthUrl(generateUrl: string): string {
  return `${generateUrl.replace(/\/generate\/?$/, '')}/health`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strip any embedded `user:pass@` credentials from a URL that might appear inside an error
 *  message (e.g. a Postgres/Redis connection failure that echoes the connection string). */
function redactCredentials(text: string): string {
  return text.replace(/:\/\/[^\s/@]+@/g, '://***redacted***@');
}
