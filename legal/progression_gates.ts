/**
 * legal/progression_gates.ts — the Manual Progression Gate.
 *
 * Structural expansion of the system (adding nodes/managers, widening the matrix, onboarding a
 * third-party integration, or any change flagged as "structural") is NOT self-service. It must
 * pass a human-in-the-loop gate: a change is first registered as PENDING via
 * `requireHumanVerification(changeId)`, and only a subsequent `approve(changeId, humanId)`
 * unlocks it. `reject` records a refusal. `assertApprovedForExpansion` is the guard callers put
 * in front of the expansion itself.
 *
 * This is a legal/governance stub: it records decisions in memory and never performs the
 * expansion — it only authorizes (or blocks) it.
 */

export type GateStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface GateDecision {
  changeId: string;
  status: GateStatus;
  /** The human who approved/rejected (absent while PENDING). */
  humanId?: string;
  /** Optional justification, primarily for rejections. */
  reason?: string;
  /** When the change was first registered as PENDING. */
  requestedAt: number;
  /** When it was approved/rejected (absent while PENDING). */
  decidedAt?: number;
}

export interface ManualProgressionGateOptions {
  now?: () => number;
}

/**
 * ManualProgressionGate — a small human-verification ledger keyed by changeId. Idempotent
 * registration; a decision (approve/reject) is terminal and cannot be silently overwritten.
 */
export class ManualProgressionGate {
  private readonly gates = new Map<string, GateDecision>();
  private readonly now: () => number;

  constructor(options: ManualProgressionGateOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Register a change as requiring human verification before structural expansion. Returns the
   * PENDING decision. Idempotent: re-registering a known change returns its current decision
   * without resetting an existing approval/rejection.
   */
  requireHumanVerification(changeId: string): GateDecision {
    this.assertChangeId(changeId);
    const existing = this.gates.get(changeId);
    if (existing) return { ...existing };
    const decision: GateDecision = {
      changeId,
      status: 'PENDING',
      requestedAt: this.now(),
    };
    this.gates.set(changeId, decision);
    return { ...decision };
  }

  /** Approve a pending change. A human id is mandatory (this is the human-in-the-loop step). */
  approve(changeId: string, humanId: string): GateDecision {
    return this.decide(changeId, humanId, 'APPROVED');
  }

  /** Reject a pending change with an optional reason. */
  reject(changeId: string, humanId: string, reason?: string): GateDecision {
    return this.decide(changeId, humanId, 'REJECTED', reason);
  }

  /** Current status of a change, or undefined if it was never registered. */
  status(changeId: string): GateStatus | undefined {
    return this.gates.get(changeId)?.status;
  }

  isApproved(changeId: string): boolean {
    return this.gates.get(changeId)?.status === 'APPROVED';
  }

  /** The guard callers place immediately before performing a structural expansion. */
  assertApprovedForExpansion(changeId: string): void {
    const decision = this.gates.get(changeId);
    if (!decision) {
      throw new Error(
        `ManualProgressionGate: change "${changeId}" has no human verification on record — ` +
          'call requireHumanVerification() and obtain approval before structural expansion',
      );
    }
    if (decision.status !== 'APPROVED') {
      throw new Error(
        `ManualProgressionGate: change "${changeId}" is ${decision.status}, not APPROVED — ` +
          'structural expansion is blocked',
      );
    }
  }

  /** Snapshot of every recorded decision. */
  decisions(): readonly GateDecision[] {
    return [...this.gates.values()].map((d) => ({ ...d }));
  }

  private decide(changeId: string, humanId: string, status: GateStatus, reason?: string): GateDecision {
    this.assertChangeId(changeId);
    if (typeof humanId !== 'string' || humanId.trim().length === 0) {
      throw new Error('ManualProgressionGate: a humanId is required to decide a change');
    }
    const existing = this.gates.get(changeId);
    if (!existing) {
      throw new Error(
        `ManualProgressionGate: change "${changeId}" must be registered via ` +
          'requireHumanVerification() before it can be decided',
      );
    }
    if (existing.status !== 'PENDING') {
      throw new Error(
        `ManualProgressionGate: change "${changeId}" is already ${existing.status} and cannot be re-decided`,
      );
    }
    const decision: GateDecision = {
      ...existing,
      status,
      humanId,
      reason,
      decidedAt: this.now(),
    };
    this.gates.set(changeId, decision);
    return { ...decision };
  }

  private assertChangeId(changeId: string): void {
    if (typeof changeId !== 'string' || changeId.trim().length === 0) {
      throw new Error('ManualProgressionGate: changeId must be a non-empty string');
    }
  }
}
