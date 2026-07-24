/**
 * hope/reflected/privacy.ts — opt-in consent for Reflected Hope collection.
 *
 * Collection is OFF by default (opt-in, never opt-out). A Reflected Hope may only collect a
 * user's data while that user has explicitly opted in. Opting out clears future collection
 * immediately. This module owns the consent state; the container (reflected_hope.ts) consults
 * it before recording anything.
 */

/** The default consent for any user who has never made a choice: opt-in, so false. */
export const DEFAULT_OPT_IN = false;

export interface ConsentState {
  userId: string;
  optedIn: boolean;
  updatedAt: number;
}

export interface OptInConsentOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * OptInConsent — a per-user consent ledger. Absent an explicit opt-in, `isOptedIn`/`canCollect`
 * return false, so collection never happens by accident.
 */
export class OptInConsent {
  private readonly consents = new Map<string, ConsentState>();
  private readonly now: () => number;

  constructor(options: OptInConsentOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Whether a user has explicitly opted in. Defaults to DEFAULT_OPT_IN (false). */
  isOptedIn(userId: string): boolean {
    return this.consents.get(userId)?.optedIn ?? DEFAULT_OPT_IN;
  }

  /** Alias that reads as intent at the call site: may we collect from this user right now? */
  canCollect(userId: string): boolean {
    return this.isOptedIn(userId);
  }

  /** Record an explicit opt-in. */
  optIn(userId: string): ConsentState {
    return this.set(userId, true);
  }

  /** Record an opt-out — future collection is cleared immediately. */
  optOut(userId: string): ConsentState {
    return this.set(userId, false);
  }

  /** The full consent state for a user, if one has been recorded. */
  stateOf(userId: string): ConsentState | undefined {
    const s = this.consents.get(userId);
    return s ? { ...s } : undefined;
  }

  private set(userId: string, optedIn: boolean): ConsentState {
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      throw new Error('OptInConsent: userId must be a non-empty string');
    }
    const state: ConsentState = { userId, optedIn, updatedAt: this.now() };
    this.consents.set(userId, state);
    return { ...state };
  }
}
