/**
 * knoll/freeze.ts — SystemFreezeController (KNOLL active-router enforcement).
 *
 * KNOLL is no longer a passive observer. When its behavioral gate scores a packet at or above
 * the 34% deny threshold (see knoll/scoring.ts), KNOLL both DENIES the packet AND trips an
 * ABSOLUTE, system-level FREEZE through this controller. While frozen, APEX (apex/router.ts)
 * MUST refuse every new business route — no create, no execute — except a single explicit
 * Holloway/Prime override path.
 *
 * This controller owns two responsibilities:
 *   1. the absolute freeze flag (triggerFreeze / isFrozen / unfreeze), and
 *   2. an isolated quarantine store for the offending packet (quarantinePacket).
 *
 * It stays within KNOLL's remit — monitor + gate. It NEVER creates or executes business work;
 * it only raises/lowers a flag and stores an isolated copy of a suspect packet.
 *
 * HOLLOWAY / PRIME OVERRIDE. Clearing a freeze requires a Holloway/Prime override. This module
 * stays dependency-free of `holloway/` (so the freeze unit stays lean); the default recognizer
 * accepts the shape of a legacy override string (`holloway_…` / `prime_…`). Production wiring
 * injects the sovereign recognizer from `knoll/holloway_bridge.ts`, which verifies signed
 * `HollowayOverrideToken`s. Use {@link asFreezeControllable} with `applyHollowayOverride` for
 * the authoritative FREEZE/UNFREEZE path (Former / Acting Prime).
 */
import type { RoutingPacket } from '../config/routing_schema.js';

/** A point-in-time snapshot of the freeze flag. */
export interface FreezeState {
  frozen: boolean;
  /** Why the freeze was tripped (the behavioral verdict reasoning). */
  reason: string | null;
  /** The anomaly score that tripped the freeze, when applicable. */
  score: number | null;
  /** The packet id that tripped the freeze, when known. */
  packetId: string | null;
  /** When the freeze was tripped (ms epoch), or null while running. */
  frozenAt: number | null;
}

/** An isolated, deep-copied record of a quarantined packet. */
export interface QuarantineRecord {
  packetId: string;
  /** A deep, detached copy — the live packet is never referenced from quarantine. */
  packet: RoutingPacket;
  reason: string;
  score: number | null;
  quarantinedAt: number;
}

export interface SystemFreezeControllerOptions {
  /** Injectable clock for deterministic testing. */
  now?: () => number;
  /**
   * Recognizer for a Holloway/Prime override token. Default: legacy string SHAPE
   * (`holloway_…` / `prime_…`). Inject `createSovereignTokenRecognizer()` from
   * `knoll/holloway_bridge.ts` to also accept signed `HollowayOverrideToken`s.
   */
  isHollowayToken?: (token: unknown) => boolean;
}

/** Default Holloway/Prime override token SHAPE check (legacy string form). */
export function defaultIsHollowayToken(token: unknown): boolean {
  return typeof token === 'string' && /^(holloway|prime)_[A-Za-z0-9]{8,}$/.test(token);
}

/**
 * Duck-typed adapter so a verified sovereign override (`applyHollowayOverride`) can drive
 * this controller WITHOUT `holloway/` importing KNOLL. The applicator has already verified
 * the signed token; `unfreeze` here is a privileged clear (not a second token check).
 */
export function asFreezeControllable(ctrl: SystemFreezeController): {
  freeze(reason?: string): void;
  unfreeze(reason?: string): void;
  readonly frozen: boolean;
} {
  return {
    get frozen() {
      return ctrl.isFrozen();
    },
    freeze(reason = 'sovereign FREEZE override') {
      ctrl.triggerFreeze(reason, 1.0);
    },
    unfreeze(_reason?: string) {
      ctrl.clearFreeze();
    },
  };
}

export class SystemFreezeController {
  private frozen = false;
  private reason: string | null = null;
  private score: number | null = null;
  private packetId: string | null = null;
  private frozenAt: number | null = null;

  private readonly quarantine: QuarantineRecord[] = [];
  private readonly now: () => number;
  private readonly isHollowayTokenFn: (token: unknown) => boolean;

  constructor(options: SystemFreezeControllerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.isHollowayTokenFn = options.isHollowayToken ?? defaultIsHollowayToken;
  }

  /**
   * Trip the absolute system-level freeze. Idempotent: the FIRST trigger wins and records the
   * originating reason/score/packet; later triggers keep the freeze raised without overwriting
   * the original cause (so the audit trail points at the packet that first broke the system).
   */
  triggerFreeze(reason: string, score: number, packetId?: string): FreezeState {
    if (!this.frozen) {
      this.frozen = true;
      this.reason = reason;
      this.score = score;
      this.packetId = packetId ?? null;
      this.frozenAt = this.now();
    }
    return this.state();
  }

  /**
   * Store an isolated (deep-copied) copy of a packet. The copy is fully detached from the live
   * object graph so nothing downstream can mutate a quarantined packet, and the quarantined
   * packet can never re-enter routing.
   */
  quarantinePacket(packet: RoutingPacket, meta: { reason?: string; score?: number } = {}): QuarantineRecord {
    const record: QuarantineRecord = {
      packetId: packet.header.packetId,
      packet: deepCopy(packet),
      reason: meta.reason ?? this.reason ?? 'quarantined by KNOLL',
      score: meta.score ?? null,
      quarantinedAt: this.now(),
    };
    this.quarantine.push(record);
    return record;
  }

  /** Is the system currently frozen? APEX MUST consult this before every business route. */
  isFrozen(): boolean {
    return this.frozen;
  }

  /**
   * Clear the freeze — ONLY via a valid Holloway/Prime override token. Returns true when the
   * token is accepted and the freeze is lifted; false (freeze remains) otherwise.
   * Quarantined packets are retained for forensics; unfreezing never releases them into routing.
   *
   * Prefer {@link asFreezeControllable} + `applyHollowayOverride` for signed sovereign tokens;
   * this method remains the APEX / string-token path.
   */
  unfreeze(hollowayToken: unknown): boolean {
    if (!this.frozen) return true;
    if (!this.isHollowayTokenFn(hollowayToken)) return false;
    this.clearFreeze();
    return true;
  }

  /**
   * Privileged clear used AFTER a signed sovereign override has already been verified
   * (see {@link asFreezeControllable}). Not an public override path by itself.
   */
  clearFreeze(): void {
    this.frozen = false;
    this.reason = null;
    this.score = null;
    this.packetId = null;
    this.frozenAt = null;
  }

  /** Recognizer for a Holloway/Prime override token (injected or default shape check). */
  isHollowayToken(token: unknown): boolean {
    return this.isHollowayTokenFn(token);
  }

  /** A read-only snapshot of the current freeze flag. */
  state(): FreezeState {
    return {
      frozen: this.frozen,
      reason: this.reason,
      score: this.score,
      packetId: this.packetId,
      frozenAt: this.frozenAt,
    };
  }

  /** Read-only view of the quarantine store. */
  quarantined(): readonly QuarantineRecord[] {
    return this.quarantine;
  }

  /** Test/lifecycle helper: clear freeze + quarantine unconditionally (NOT an override path). */
  reset(): void {
    this.frozen = false;
    this.reason = null;
    this.score = null;
    this.packetId = null;
    this.frozenAt = null;
    this.quarantine.length = 0;
  }
}

/** Structured deep copy that keeps quarantine isolated from the live packet graph. */
function deepCopy<T>(value: T): T {
  const sc = (globalThis as { structuredClone?: <U>(v: U) => U }).structuredClone;
  if (typeof sc === 'function') return sc(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
