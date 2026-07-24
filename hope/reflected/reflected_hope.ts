/**
 * hope/reflected/reflected_hope.ts — Reflected Hopes: per-user, isolated mirror containers.
 *
 * Each userId gets its own ReflectedHope container in a dedicated storage namespace
 * (see segmentation.ts). A Reflected Hope is a private mirror used to interpret and
 * personalize; it is architecturally incapable of writing into the authoritative Core Hope
 * or Prime Hope stores — it holds no reference to them and exposes no path into them.
 *
 * CONSTITUTIONAL INVARIANT — like all of HOPE, this cannot execute or create. It only stores
 * and retrieves interpretation-side text; it mints no RoutingPacket and imports no peer agent.
 * Collection is opt-in (privacy.ts); the sole manipulation seam is the logged Tactical Intel
 * Exception (intel_exception.ts).
 */
import { OptInConsent } from './privacy.js';
import { assertIsolation, containerPath, reflectedId } from './segmentation.js';

export interface ReflectedObservation {
  id: string;
  text: string;
  at: number;
  metadata?: Record<string, unknown>;
}

export interface RecordOptions {
  metadata?: Record<string, unknown>;
  id?: string;
}

export interface ReflectedHopeOptions {
  now?: () => number;
  newId?: () => string;
}

/**
 * A single user's isolated Reflected Hope container. Its `path` is a dedicated, asserted-safe
 * namespace under REFLECTED_ROOT. It has no API — and holds no reference — that could reach the
 * Core/Prime stores.
 */
export class ReflectedHope {
  readonly userId: string;
  readonly reflectedId: string;
  readonly path: string;

  private readonly observations: ReflectedObservation[] = [];
  private readonly now: () => number;
  private readonly newId: () => string;
  private counter = 0;

  constructor(userId: string, options: ReflectedHopeOptions = {}) {
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      throw new Error('ReflectedHope: userId must be a non-empty string');
    }
    this.userId = userId;
    this.reflectedId = reflectedId(userId);
    // Hard guarantee the container path is isolated from Core/Prime Hope before we touch it.
    this.path = assertIsolation(this.reflectedId);
    this.now = options.now ?? Date.now;
    this.newId =
      options.newId ??
      (() => `refl_${this.reflectedId}_${(this.counter++).toString(36)}`);
  }

  /** Record an observation into THIS user's isolated container. */
  record(text: string, options: RecordOptions = {}): ReflectedObservation {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('ReflectedHope.record: text must be a non-empty string');
    }
    const obs: ReflectedObservation = {
      id: options.id ?? this.newId(),
      text,
      at: this.now(),
      metadata: options.metadata,
    };
    this.observations.push(obs);
    return { ...obs };
  }

  entries(): readonly ReflectedObservation[] {
    return this.observations.map((o) => ({ ...o }));
  }

  size(): number {
    return this.observations.length;
  }

  clear(): void {
    this.observations.length = 0;
  }
}

export interface ReflectedHopeRegistryOptions {
  consent?: OptInConsent;
  containerOptions?: ReflectedHopeOptions;
}

/**
 * Registry of per-user Reflected Hope containers. Enforces isolation (one container per
 * reflected id) and opt-in collection. It holds NO reference to any Core/Prime Hope store, so
 * reflected activity can never contaminate the authoritative stores.
 */
export class ReflectedHopeRegistry {
  private readonly containers = new Map<string, ReflectedHope>();
  private readonly consent: OptInConsent;
  private readonly containerOptions: ReflectedHopeOptions;

  constructor(options: ReflectedHopeRegistryOptions = {}) {
    this.consent = options.consent ?? new OptInConsent();
    this.containerOptions = options.containerOptions ?? {};
  }

  /** The consent ledger governing collection. */
  consentManager(): OptInConsent {
    return this.consent;
  }

  /** Get (or lazily create) the isolated container for a user. */
  containerFor(userId: string): ReflectedHope {
    const rid = reflectedId(userId);
    let container = this.containers.get(rid);
    if (!container) {
      container = new ReflectedHope(userId, this.containerOptions);
      this.containers.set(rid, container);
    }
    return container;
  }

  /**
   * Collect an observation for a user — ONLY if they have opted in. Returns the stored
   * observation, or null when consent is absent (no data is collected in that case).
   */
  collect(userId: string, text: string, metadata?: Record<string, unknown>): ReflectedObservation | null {
    if (!this.consent.canCollect(userId)) return null;
    return this.containerFor(userId).record(text, { metadata });
  }

  /** Whether a container currently exists for a user. */
  has(userId: string): boolean {
    return this.containers.has(reflectedId(userId));
  }

  /** Opt a user out AND purge their container (right to be forgotten). */
  forget(userId: string): void {
    this.consent.optOut(userId);
    const rid = reflectedId(userId);
    this.containers.get(rid)?.clear();
    this.containers.delete(rid);
  }

  /** The dedicated storage path for a user's container (isolation-asserted). */
  pathFor(userId: string): string {
    return containerPath(reflectedId(userId));
  }
}

/**
 * CoreHopeStore — a minimal stand-in for the authoritative Core Hope / Prime Hope store.
 *
 * It exists here to make the isolation contract concrete and testable: a ReflectedHope /
 * ReflectedHopeRegistry never receives one of these and has no method that writes to it, so
 * reflected activity provably cannot contaminate the core store.
 */
export class CoreHopeStore {
  private readonly records = new Map<string, unknown>();

  set(key: string, value: unknown): void {
    this.records.set(key, value);
  }

  get(key: string): unknown {
    return this.records.get(key);
  }

  size(): number {
    return this.records.size;
  }
}
