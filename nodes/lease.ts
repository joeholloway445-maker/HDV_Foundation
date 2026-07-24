/**
 * nodes/lease.ts — node-slice leasing (Phase 6: "no double-claims").
 *
 * When APEX publishes a claim and KEDA materializes a worker, that worker claims a slice of the
 * matrix — a set of `{agent, manager, node}` coordinates — and MUST hold an exclusive lease on
 * each so two workers can never run the same node. Leases expire (TTL) so a crashed worker's
 * slice is re-claimable without a human in the loop; a live worker renews to keep its slice.
 *
 * This module is pure lifecycle plumbing. It does NOT route, gate, mutate, or inspect packets,
 * and it imports no peer agent. Two implementations of the same `NodeSliceLease` contract:
 *
 *   - `InMemoryNodeSliceLease` — the offline default. A clock is injectable so TTL expiry is
 *     deterministic in tests. Uses monotonic FENCING TOKENS so a stale holder that wakes up
 *     after its lease expired can be detected and rejected.
 *   - `RedisLeaseStub` — the shape of the Redis-backed lease (Redis is already in
 *     docker-compose): `SET key holder NX PX ttl` to acquire, compare-and-`DEL` to release,
 *     `PEXPIRE` to renew. It runs OFFLINE against any `RedisLike` client (a tiny fake is enough
 *     for tests), and against a real client it is the production path. It is a "stub" only in
 *     that fencing tokens are process-local rather than server-issued.
 */

// ---------------------------------------------------------------------------
// Slice keys
// ---------------------------------------------------------------------------

export interface NodeSliceCoord {
  /** Owning Big-5 agent role, e.g. "DREAM" / "VISION". */
  agent: string;
  /** Sub-manager index within the agent's matrix (0..63). */
  manager: number;
  /** Node index within the manager (0..63). */
  node: number;
}

/** Canonical lease key for one node slice: `lease:node:<agent>/<manager>/<node>`. */
export function sliceKey(coord: NodeSliceCoord): string {
  return `lease:node:${coord.agent}/${coord.manager}/${coord.node}`;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type LeaseReason =
  | 'ACQUIRED'
  | 'RENEWED'
  | 'HELD_BY_OTHER'
  | 'NOT_HELD'
  | 'RELEASED';

export interface LeaseClaim {
  key: string;
  holder: string;
  /** Epoch-ms at which the lease expires unless renewed. */
  expiresAt: number;
  /**
   * Monotonically increasing token for this key. A holder should carry it and workers/leases
   * downstream should reject actions carrying a token lower than the current one (fencing).
   */
  fencingToken: number;
}

export interface LeaseResult {
  ok: boolean;
  reason: LeaseReason;
  /** Present when ok — the (possibly refreshed) claim held by `holder`. */
  claim?: LeaseClaim;
  /** Best-effort: who currently holds the key when the request failed. */
  heldBy?: string;
}

/**
 * The lease contract. All methods are async so a Redis-backed implementation is a drop-in for
 * the in-memory one at every call site.
 */
export interface NodeSliceLease {
  /**
   * Acquire `key` for `holder` for `ttlMs`. If `holder` already holds it, this refreshes the
   * TTL (idempotent re-claim). If someone else holds a live lease, fails with HELD_BY_OTHER.
   */
  claim(key: string, holder: string, ttlMs: number): Promise<LeaseResult>;
  /** Extend an existing lease held by `holder`. Fails if the lease lapsed or is held by another. */
  renew(key: string, holder: string, ttlMs: number): Promise<LeaseResult>;
  /** Release `key` iff `holder` holds it (compare-and-delete). Idempotent: NOT_HELD is not fatal. */
  release(key: string, holder: string): Promise<LeaseResult>;
}

const DEFAULT_TTL_MS = 30_000;

function normalizeTtl(ttlMs: number): number {
  return Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : DEFAULT_TTL_MS;
}

// ---------------------------------------------------------------------------
// In-memory implementation (offline default)
// ---------------------------------------------------------------------------

interface MemEntry {
  holder: string;
  expiresAt: number;
  fencingToken: number;
}

export interface InMemoryNodeSliceLeaseOptions {
  /** Injectable clock (epoch ms). Defaults to Date.now — override for deterministic TTL tests. */
  now?: () => number;
}

export class InMemoryNodeSliceLease implements NodeSliceLease {
  private readonly entries = new Map<string, MemEntry>();
  private readonly tokens = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: InMemoryNodeSliceLeaseOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async claim(key: string, holder: string, ttlMs: number): Promise<LeaseResult> {
    const ttl = normalizeTtl(ttlMs);
    const t = this.now();
    const live = this.liveEntry(key, t);

    if (live && live.holder !== holder) {
      return { ok: false, reason: 'HELD_BY_OTHER', heldBy: live.holder };
    }

    // Free (or expired) → new token; same holder re-claiming → keep its token, refresh TTL.
    const fencingToken = live && live.holder === holder ? live.fencingToken : this.nextToken(key);
    const entry: MemEntry = { holder, expiresAt: t + ttl, fencingToken };
    this.entries.set(key, entry);
    return { ok: true, reason: live ? 'RENEWED' : 'ACQUIRED', claim: toClaim(key, entry) };
  }

  async renew(key: string, holder: string, ttlMs: number): Promise<LeaseResult> {
    const ttl = normalizeTtl(ttlMs);
    const t = this.now();
    const live = this.liveEntry(key, t);
    if (!live) return { ok: false, reason: 'NOT_HELD' };
    if (live.holder !== holder) return { ok: false, reason: 'HELD_BY_OTHER', heldBy: live.holder };
    live.expiresAt = t + ttl;
    return { ok: true, reason: 'RENEWED', claim: toClaim(key, live) };
  }

  async release(key: string, holder: string): Promise<LeaseResult> {
    const live = this.liveEntry(key, this.now());
    if (!live) {
      this.entries.delete(key);
      return { ok: false, reason: 'NOT_HELD' };
    }
    if (live.holder !== holder) return { ok: false, reason: 'HELD_BY_OTHER', heldBy: live.holder };
    this.entries.delete(key);
    return { ok: true, reason: 'RELEASED' };
  }

  /** Test/inspection helper: the live holder of a key, or undefined if free/expired. */
  holderOf(key: string): string | undefined {
    return this.liveEntry(key, this.now())?.holder;
  }

  private liveEntry(key: string, t: number): MemEntry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= t) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  private nextToken(key: string): number {
    const next = (this.tokens.get(key) ?? 0) + 1;
    this.tokens.set(key, next);
    return next;
  }
}

function toClaim(key: string, e: MemEntry): LeaseClaim {
  return { key, holder: e.holder, expiresAt: e.expiresAt, fencingToken: e.fencingToken };
}

// ---------------------------------------------------------------------------
// Redis-backed stub (production shape; offline-testable via a fake RedisLike)
// ---------------------------------------------------------------------------

/** The minimal Redis surface the lease needs. Any real client (ioredis/node-redis) satisfies it. */
export interface RedisLike {
  /** SET key value [NX] [PX ttl]. Returns 'OK' when set, null when NX blocked it. */
  set(
    key: string,
    value: string,
    opts?: { nx?: boolean; pxMs?: number },
  ): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  /** PEXPIRE key ms. Returns 1 if the timeout was set, 0 if the key does not exist. */
  pexpire(key: string, ms: number): Promise<number>;
  /** DEL key. Returns the number of keys removed. */
  del(key: string): Promise<number>;
}

export interface RedisLeaseStubOptions {
  redis: RedisLike;
  /** Optional clock for the returned `expiresAt` (does not affect Redis-side TTL). */
  now?: () => number;
}

/**
 * A Redis-backed `NodeSliceLease` using the canonical `SET NX PX` acquire + compare-and-delete
 * release pattern. It is exclusive because `SET ... NX` only succeeds when the key is absent, and
 * Redis's own PX TTL reclaims a crashed holder's slice. Fencing tokens are process-local here
 * (hence "stub"); a production hardening would issue them via a server-side `INCR`.
 */
export class RedisLeaseStub implements NodeSliceLease {
  private readonly redis: RedisLike;
  private readonly now: () => number;
  private token = 0;

  constructor(options: RedisLeaseStubOptions) {
    this.redis = options.redis;
    this.now = options.now ?? Date.now;
  }

  async claim(key: string, holder: string, ttlMs: number): Promise<LeaseResult> {
    const ttl = normalizeTtl(ttlMs);
    const set = await this.redis.set(key, holder, { nx: true, pxMs: ttl });
    if (set === 'OK') {
      return { ok: true, reason: 'ACQUIRED', claim: this.claimFor(key, holder, ttl) };
    }
    // NX blocked → someone (maybe us) holds it. Idempotent re-claim refreshes our own TTL.
    const current = await this.redis.get(key);
    if (current === holder) {
      await this.redis.pexpire(key, ttl);
      return { ok: true, reason: 'RENEWED', claim: this.claimFor(key, holder, ttl) };
    }
    return { ok: false, reason: 'HELD_BY_OTHER', heldBy: current ?? undefined };
  }

  async renew(key: string, holder: string, ttlMs: number): Promise<LeaseResult> {
    const ttl = normalizeTtl(ttlMs);
    const current = await this.redis.get(key);
    if (current === null) return { ok: false, reason: 'NOT_HELD' };
    if (current !== holder) return { ok: false, reason: 'HELD_BY_OTHER', heldBy: current };
    const set = await this.redis.pexpire(key, ttl);
    if (set === 0) return { ok: false, reason: 'NOT_HELD' };
    return { ok: true, reason: 'RENEWED', claim: this.claimFor(key, holder, ttl) };
  }

  async release(key: string, holder: string): Promise<LeaseResult> {
    const current = await this.redis.get(key);
    if (current === null) return { ok: false, reason: 'NOT_HELD' };
    if (current !== holder) return { ok: false, reason: 'HELD_BY_OTHER', heldBy: current };
    await this.redis.del(key);
    return { ok: true, reason: 'RELEASED' };
  }

  private claimFor(key: string, holder: string, ttl: number): LeaseClaim {
    this.token += 1;
    return { key, holder, expiresAt: this.now() + ttl, fencingToken: this.token };
  }
}
