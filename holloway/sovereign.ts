/**
 * holloway/sovereign.ts — SovereignAuthority: Acting-Prime command + Former-Prime countermand.
 *
 * Authority model:
 *   - The single ActingPrimeHolloway issues directives with UNCONSTRAINED command over the
 *     governed layers. There is no approval gate, quorum, or rate limit on issuance.
 *   - The ONE and only check is a COUNTERMAND from a FormerPrimeHolloway. A Former Prime holds
 *     no command power of its own, but may veto (countermand) any active directive.
 *   - Countermands are OVERRIDES and are written to the Designated Audit Ledger. Directives
 *     explicitly flagged anomalous or critical-out-of-band are likewise recorded.
 *
 * `SovereignAuthority` implements {@link PrimeRegistry} so a Designated Audit Ledger can bind
 * its read authorization to live sovereign membership.
 */
import type {
  ActingPrimeHolloway,
  FormerPrimeHolloway,
  PrimeRegistry,
} from './types.js';
import { DesignatedAuditLedger } from './designated_ledger.js';

/** The status of a sovereign directive. */
export type DirectiveStatus = 'ACTIVE' | 'COUNTERMANDED';

/** A command issued by the Acting Prime. */
export interface Directive {
  /** Monotonic directive id, e.g. `dir_00000001`. */
  readonly id: string;
  /** Id of the Acting Prime that issued it. */
  readonly issuedBy: string;
  /** The command verb / description. */
  readonly command: string;
  /** Opaque structured detail. */
  readonly data: Record<string, unknown>;
  readonly issuedAt: number;
  /** Whether this directive was flagged outside the normal operating envelope. */
  readonly anomalous: boolean;
  /** Whether this directive was flagged a critical out-of-band decision. */
  readonly critical: boolean;
  status: DirectiveStatus;
  /** Former-Prime id that countermanded it, when countermanded. */
  countermandedBy?: string;
  countermandedAt?: number;
  /** Reason supplied with the countermand. */
  countermandReason?: string;
}

/** Options for {@link SovereignAuthority.issueDirective}. */
export interface IssueDirectiveOptions {
  data?: Record<string, unknown>;
  /** Flag the directive as outside the normal operating envelope (recorded to the ledger). */
  anomalous?: boolean;
  /** Flag the directive as a critical out-of-band decision (recorded to the ledger). */
  critical?: boolean;
  timestamp?: number;
}

/** Options for {@link SovereignAuthority}. */
export interface SovereignAuthorityOptions {
  /** Former Primes seeded at construction (each retains the countermand veto). */
  formerPrimes?: readonly FormerPrimeHolloway[];
  /** Designated Audit Ledger to record overrides / anomalous / critical events into. */
  ledger?: DesignatedAuditLedger;
}

/** Thrown when a countermand is attempted by a principal that is not a registered Former Prime. */
export class UnauthorizedCountermand extends Error {
  constructor(formerId: string) {
    super(
      `UnauthorizedCountermand: '${formerId}' is not a registered Former Prime and may not ` +
        'countermand an Acting-Prime directive.',
    );
    this.name = 'UnauthorizedCountermand';
  }
}

/** Thrown when a countermand targets an unknown directive id. */
export class UnknownDirective extends Error {
  constructor(directiveId: string) {
    super(`UnknownDirective: no directive with id '${directiveId}'.`);
    this.name = 'UnknownDirective';
  }
}

export class SovereignAuthority implements PrimeRegistry {
  private acting: ActingPrimeHolloway;
  private readonly formers = new Map<string, FormerPrimeHolloway>();
  private readonly directivesById = new Map<string, Directive>();
  private readonly order: string[] = [];
  private seq = 0;
  readonly ledger: DesignatedAuditLedger;

  constructor(actingPrime: ActingPrimeHolloway, options: SovereignAuthorityOptions = {}) {
    this.acting = actingPrime;
    this.ledger = options.ledger ?? new DesignatedAuditLedger({ registry: this });
    for (const f of options.formerPrimes ?? []) this.formers.set(f.id, f);
  }

  /** The current Acting Prime. */
  get actingPrime(): ActingPrimeHolloway {
    return this.acting;
  }

  /** A snapshot of the registered Former Primes. */
  get formerPrimes(): readonly FormerPrimeHolloway[] {
    return [...this.formers.values()];
  }

  // --- PrimeRegistry ---------------------------------------------------------

  isActingPrime(id: string): boolean {
    return this.acting.id === id;
  }

  isFormerPrime(id: string): boolean {
    return this.formers.has(id);
  }

  // --- Command ---------------------------------------------------------------

  /**
   * Issue a directive. UNCONSTRAINED: the Acting Prime's command is never gated here. If the
   * directive is flagged anomalous or critical-out-of-band, it is also written to the ledger.
   */
  issueDirective(command: string, options: IssueDirectiveOptions = {}): Directive {
    const directive: Directive = {
      id: `dir_${(++this.seq).toString().padStart(8, '0')}`,
      issuedBy: this.acting.id,
      command,
      data: options.data ?? {},
      issuedAt: options.timestamp ?? Date.now(),
      anomalous: options.anomalous ?? false,
      critical: options.critical ?? false,
      status: 'ACTIVE',
    };
    this.directivesById.set(directive.id, directive);
    this.order.push(directive.id);

    if (directive.critical) {
      this.ledger.recordCriticalOutOfBand(this.acting.id, `critical directive: ${command}`, {
        directiveId: directive.id,
        data: directive.data,
      });
    }
    if (directive.anomalous) {
      this.ledger.recordAnomalousCommand(this.acting.id, `anomalous directive: ${command}`, {
        directiveId: directive.id,
        data: directive.data,
      });
    }
    return directive;
  }

  /**
   * Countermand an active directive. This is the SOLE check on Acting-Prime command and may
   * only be exercised by a registered Former Prime. The event is recorded to the ledger as an
   * OVERRIDE.
   *
   * @throws {UnauthorizedCountermand} if `formerId` is not a registered Former Prime.
   * @throws {UnknownDirective} if `directiveId` does not exist.
   */
  countermand(formerId: string, directiveId: string, reason = ''): Directive {
    if (!this.formers.has(formerId)) throw new UnauthorizedCountermand(formerId);
    const directive = this.directivesById.get(directiveId);
    if (!directive) throw new UnknownDirective(directiveId);

    if (directive.status === 'COUNTERMANDED') return directive;

    directive.status = 'COUNTERMANDED';
    directive.countermandedBy = formerId;
    directive.countermandedAt = Date.now();
    directive.countermandReason = reason;

    this.ledger.recordOverride(
      formerId,
      `Former Prime countermanded directive '${directiveId}'`,
      {
        directiveId,
        issuedBy: directive.issuedBy,
        command: directive.command,
        reason,
      },
    );
    return directive;
  }

  /** Look up a directive by id. */
  getDirective(id: string): Directive | undefined {
    return this.directivesById.get(id);
  }

  /** True iff the directive exists and is still ACTIVE (not countermanded). */
  isActive(id: string): boolean {
    return this.directivesById.get(id)?.status === 'ACTIVE';
  }

  /** All directives, in issuance order. */
  directives(): readonly Directive[] {
    return this.order.map((id) => this.directivesById.get(id)!);
  }

  /**
   * Succession: the current Acting Prime steps down and `successor` assumes command. The
   * outgoing Prime becomes a Former Prime (retaining the countermand veto). Recorded as a
   * critical out-of-band decision.
   */
  succeed(successor: ActingPrimeHolloway, steppedDownAt = Date.now()): void {
    const outgoing: FormerPrimeHolloway = {
      id: this.acting.id,
      role: 'FORMER_PRIME',
      name: this.acting.name,
      since: this.acting.since,
      steppedDownAt,
    };
    this.formers.set(outgoing.id, outgoing);
    const previousId = this.acting.id;
    this.acting = successor;
    this.ledger.recordCriticalOutOfBand(successor.id, 'sovereign succession', {
      from: previousId,
      to: successor.id,
    });
  }
}
