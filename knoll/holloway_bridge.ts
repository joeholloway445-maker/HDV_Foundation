/**
 * knoll/holloway_bridge.ts — wire HOLLOWAY sovereign overrides into KNOLL's freeze controller.
 *
 * Direction of dependency is intentional and one-way:
 *   knoll → holloway   (security layer consults sovereign authority)
 *   holloway ↛ knoll   (sovereign layer stays peer-agent-free)
 *
 * This bridge:
 *   1. Recognizes signed HollowayOverrideToken (object or JSON string) for APEX's
 *      freeze-exception / unfreeze paths.
 *   2. Applies FREEZE / UNFREEZE to a SystemFreezeController via applyHollowayOverride +
 *      asFreezeControllable — so Acting / Former Prime directives are cryptographically
 *      verified before the freeze flag moves.
 *   3. Optionally records the override on the Designated Audit Ledger when a
 *      SovereignAuthority (or any ledger-bearing registry) is supplied.
 */
import {
  applyHollowayOverride,
  verifyOverrideToken,
  type HollowayOverrideToken,
  type PrimeRegistry,
  type DesignatedAuditLedger,
} from '../holloway/index.js';
import {
  SystemFreezeController,
  asFreezeControllable,
  defaultIsHollowayToken,
} from './freeze.js';

/** Narrow unknown → HollowayOverrideToken when the shape looks right (pre-signature check). */
export function asHollowayOverrideToken(value: unknown): HollowayOverrideToken | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.issuedBy !== 'string' ||
    (v.authority !== 'ACTING_PRIME' && v.authority !== 'FORMER_PRIME') ||
    (v.action !== 'FREEZE' && v.action !== 'UNFREEZE') ||
    typeof v.reason !== 'string' ||
    typeof v.issuedAt !== 'number' ||
    typeof v.signature !== 'string'
  ) {
    return null;
  }
  return value as HollowayOverrideToken;
}

/** Parse a JSON-encoded override token string, or return null. */
export function parseOverrideToken(token: unknown): HollowayOverrideToken | null {
  if (typeof token === 'string') {
    const trimmed = token.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      return asHollowayOverrideToken(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return asHollowayOverrideToken(token);
}

/**
 * Recognizer suitable for `SystemFreezeControllerOptions.isHollowayToken`.
 * Accepts:
 *   - legacy shape strings (`holloway_…` / `prime_…`),
 *   - signed HollowayOverrideToken objects,
 *   - JSON-serialized HollowayOverrideToken strings.
 * When `registry` is supplied, `issuedBy` must be a live Acting/Former Prime.
 */
export function createSovereignTokenRecognizer(
  registry?: PrimeRegistry,
): (token: unknown) => boolean {
  return (token: unknown): boolean => {
    if (defaultIsHollowayToken(token)) return true;
    const parsed = parseOverrideToken(token);
    if (!parsed) return false;
    if (!verifyOverrideToken(parsed)) return false;
    if (parsed.authority !== 'ACTING_PRIME' && parsed.authority !== 'FORMER_PRIME') return false;
    if (registry) {
      const live =
        (parsed.authority === 'ACTING_PRIME' && registry.isActingPrime(parsed.issuedBy)) ||
        (parsed.authority === 'FORMER_PRIME' && registry.isFormerPrime(parsed.issuedBy));
      if (!live) return false;
    }
    return true;
  };
}

export interface ApplySovereignFreezeOptions {
  /** Optional registry so only live Acting/Former Primes may override. */
  registry?: PrimeRegistry;
  /**
   * Optional Designated Audit Ledger. When present, the override is recorded as an OVERRIDE
   * row (Acting / Former / Prime Hope readable only).
   */
  ledger?: DesignatedAuditLedger;
}

/**
 * Apply a verified sovereign FREEZE / UNFREEZE to KNOLL's SystemFreezeController.
 * @throws {InvalidOverrideToken} when the token fails signature / authority checks.
 */
export function applySovereignFreezeOverride(
  freeze: SystemFreezeController,
  token: HollowayOverrideToken,
  options: ApplySovereignFreezeOptions = {},
): void {
  applyHollowayOverride(asFreezeControllable(freeze), token, options.registry);
  if (options.ledger) {
    options.ledger.recordOverride(
      token.issuedBy,
      `sovereign ${token.action} via Holloway override`,
      { action: token.action, reason: token.reason, issuedAt: token.issuedAt, authority: token.authority },
    );
  }
}

/**
 * Stand up a freeze controller pre-wired with the sovereign token recognizer.
 * Used by Knoll when no freeze controller is injected.
 */
export function createSovereignFreezeController(
  options: {
    now?: () => number;
    registry?: PrimeRegistry;
  } = {},
): SystemFreezeController {
  return new SystemFreezeController({
    now: options.now,
    isHollowayToken: createSovereignTokenRecognizer(options.registry),
  });
}
