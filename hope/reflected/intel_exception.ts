/**
 * hope/reflected/intel_exception.ts — the Tactical Intel Exception.
 *
 * Reflected Hopes are, by default, faithful mirrors. The ONE narrow exception is a slight,
 * deliberate manipulation permitted ONLY for security verification or audit (e.g. seeding a
 * canary value to detect exfiltration, or a honeytoken during an integrity check). Every use
 * is logged. The exception can never be enabled for a non-security purpose, and manipulation
 * is refused unless the flag is currently enabled.
 */

/** The only purposes for which a tactical manipulation may be authorized. */
export type IntelPurpose = 'SECURITY_VERIFICATION' | 'AUDIT';

const PERMITTED_PURPOSES: readonly IntelPurpose[] = ['SECURITY_VERIFICATION', 'AUDIT'];

export interface IntelExceptionEntry {
  at: number;
  /** 'ENABLE' | 'DISABLE' | 'MANIPULATE' */
  event: 'ENABLE' | 'DISABLE' | 'MANIPULATE';
  purpose: IntelPurpose;
  /** Who authorized/performed the action (human or audit-system id). */
  actor: string;
  /** Human-readable justification (mandatory — this is a logged, auditable exception). */
  reason: string;
}

export interface TacticalIntelExceptionOptions {
  now?: () => number;
}

export interface ManipulationContext {
  actor: string;
  reason: string;
}

function assertPurpose(purpose: IntelPurpose): void {
  if (!PERMITTED_PURPOSES.includes(purpose)) {
    throw new Error(
      `TacticalIntelException: purpose "${purpose}" is not permitted — security/audit only`,
    );
  }
}

/**
 * TacticalIntelException — a logged, purpose-bound flag. While enabled for a permitted purpose,
 * `applyManipulation` may transform a value; otherwise it refuses. Every enable/disable and
 * every manipulation is appended to an append-only audit log.
 */
export class TacticalIntelException {
  private enabled = false;
  private purpose: IntelPurpose | null = null;
  private readonly log: IntelExceptionEntry[] = [];
  private readonly now: () => number;

  constructor(options: TacticalIntelExceptionOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  activePurpose(): IntelPurpose | null {
    return this.purpose;
  }

  /** Enable the exception for a permitted (security/audit) purpose. Logged. */
  enable(purpose: IntelPurpose, actor: string, reason: string): void {
    assertPurpose(purpose);
    this.requireReason(actor, reason);
    this.enabled = true;
    this.purpose = purpose;
    this.log.push({ at: this.now(), event: 'ENABLE', purpose, actor, reason });
  }

  /** Disable the exception. Logged. */
  disable(actor: string, reason: string): void {
    this.requireReason(actor, reason);
    const purpose = this.purpose ?? 'AUDIT';
    this.enabled = false;
    this.purpose = null;
    this.log.push({ at: this.now(), event: 'DISABLE', purpose, actor, reason });
  }

  /**
   * Apply a slight manipulation to a value — permitted ONLY while enabled for a security/audit
   * purpose. Refuses (throws) when disabled. Every application is logged.
   */
  applyManipulation<T>(input: T, transform: (value: T) => T, ctx: ManipulationContext): T {
    if (!this.enabled || this.purpose === null) {
      throw new Error(
        'TacticalIntelException: manipulation refused — exception is not enabled for security/audit',
      );
    }
    this.requireReason(ctx.actor, ctx.reason);
    this.log.push({
      at: this.now(),
      event: 'MANIPULATE',
      purpose: this.purpose,
      actor: ctx.actor,
      reason: ctx.reason,
    });
    return transform(input);
  }

  /** The append-only audit trail of every enable/disable/manipulation. */
  entries(): readonly IntelExceptionEntry[] {
    return [...this.log];
  }

  private requireReason(actor: string, reason: string): void {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new Error('TacticalIntelException: actor is required for the audit log');
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error('TacticalIntelException: a reason is required for the audit log');
    }
  }
}
