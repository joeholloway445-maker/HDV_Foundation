/**
 * creator/handlers.ts — request handlers for the creator marketplace (creator/).
 *
 * Same pure-ish `{ status, body }` shape as companion/portrait_handlers.ts — unit-testable
 * without binding a port, wired into the gateway with one line per route. These handlers do
 * NOT re-implement auth: every `creatorUserId` parameter here is the ALREADY-authenticated
 * user id the gateway resolved from X-HDV-Session (see gateway/server.ts) — a creator is just
 * an auth/ User with an additional CreatorProfile, not a parallel identity system.
 *
 * `recordLikenessUsage` at the bottom is the OTHER half of this module: a fire-and-forget
 * background helper, same pattern as companion/handlers.ts's `persistMemoryUpdate` (catches +
 * logs + swallows errors so a secondary write never surfaces as a failure on the hot chat/
 * portrait/scene path). It is called from companion/handlers.ts, companion/portrait_handlers.ts,
 * and companion/scene_handlers.ts after a successful real-provider generation, and is a clean
 * no-op whenever the personaId is absent, unknown, or the repositories aren't configured — the
 * overwhelmingly common case (a non-creator-owned companion) is entirely unaffected.
 */
import { randomUUID } from 'node:crypto';
import type {
  CreatorPersonaRepository,
  CreatorProfileRepository,
  LikenessUsageEventRepository,
} from '../persistence/repositories.js';
import { CreatorPayoutStub, PayoutBlockedError, PayoutStubError } from './payout_stub.js';
import type { VerificationStatus } from './payout_stub.js';
import {
  CreatorValidationError,
  LIKENESS_RATE_USD,
  parseCreatorApplyRequest,
  parseCreatorPersonaRequest,
  type LikenessEventType,
} from './types.js';
import type { CreatorPersonaRecord, CreatorProfileRecord } from '../persistence/repositories.js';

/** Minimal response shape (structurally compatible with the gateway's GatewayResponse). */
export interface CreatorResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface CreatorHandlerOptions {
  creatorProfileRepository?: CreatorProfileRepository;
  creatorPersonaRepository?: CreatorPersonaRepository;
  likenessUsageRepository?: LikenessUsageEventRepository;
  /** Optional Stripe Identity + Connect stub (creator/payout_stub.ts). Required for
   *  verification/payout endpoints; earnings/apply/persona work without it. */
  payoutStub?: CreatorPayoutStub;
  /** Injectable clock (tests: deterministic createdAt). Defaults to Date.now. */
  now?: () => number;
}

/**
 * POST /v1/creator/apply — the authenticated user becomes (or updates) a creator. Idempotent
 * upsert keyed on userId; `verificationStatus` is preserved across re-applications (defaults to
 * 'unverified' for a brand-new profile) and is NEVER set here — see creator/payout_stub.ts.
 */
export function handleCreatorApply(
  creatorUserId: string,
  body: unknown,
  options: CreatorHandlerOptions = {},
): CreatorResponse {
  if (!options.creatorProfileRepository) {
    return { status: 503, body: { error: 'creator profiles are not configured on this server' } };
  }

  let parsed;
  try {
    parsed = parseCreatorApplyRequest(body);
  } catch (err) {
    if (err instanceof CreatorValidationError) {
      return { status: 400, body: { error: err.message, code: err.code } };
    }
    throw err;
  }

  const now = options.now ? options.now() : Date.now();
  const existing = options.creatorProfileRepository.get(creatorUserId);
  const record: CreatorProfileRecord = {
    userId: creatorUserId,
    displayName: parsed.displayName,
    bio: parsed.bio,
    // Never set to 'verified' here (or anywhere in this pass) — see creator/payout_stub.ts.
    verificationStatus: existing?.verificationStatus ?? 'unverified',
    createdAt: existing?.createdAt ?? now,
  };
  const saved = options.creatorProfileRepository.upsert(record);
  return { status: 200, body: { profile: saved } };
}

/**
 * POST /v1/creator/persona — the authenticated creator submits or updates a persona. Rejects
 * with 409 if `personaId` is already claimed by a DIFFERENT creator (the join key must stay
 * unambiguous); re-submitting the same creator's own personaId updates it in place.
 */
export function handleCreatePersona(
  creatorUserId: string,
  body: unknown,
  options: CreatorHandlerOptions = {},
): CreatorResponse {
  if (!options.creatorPersonaRepository) {
    return { status: 503, body: { error: 'creator personas are not configured on this server' } };
  }

  let parsed;
  try {
    parsed = parseCreatorPersonaRequest(body);
  } catch (err) {
    if (err instanceof CreatorValidationError) {
      return { status: 400, body: { error: err.message, code: err.code } };
    }
    throw err;
  }

  const existing = options.creatorPersonaRepository.findByPersonaId(parsed.personaId);
  if (existing && existing.creatorUserId !== creatorUserId) {
    return {
      status: 409,
      body: {
        error: `personaId "${parsed.personaId}" is already claimed by another creator`,
        code: 'persona_id_taken',
      },
    };
  }

  const now = options.now ? options.now() : Date.now();
  const record: CreatorPersonaRecord = {
    id: existing?.id ?? randomUUID(),
    creatorUserId,
    personaId: parsed.personaId,
    displayName: parsed.displayName,
    description: parsed.description,
    referencePhotoUrls: parsed.referencePhotoUrls,
    createdAt: existing?.createdAt ?? now,
  };
  const saved = options.creatorPersonaRepository.upsert(record);
  return { status: 200, body: { persona: saved } };
}

/**
 * The response shape for GET /v1/creator/earnings. `payoutAvailable` is ALWAYS false in this
 * pass: nothing in this codebase can set a creator's verificationStatus to 'verified' yet (see
 * creator/payout_stub.ts), so requestPayout is unconditionally blocked regardless of this flag.
 * It exists purely so a frontend can render a clear "payouts coming soon" state instead of
 * inferring that from a 403.
 */
export interface EarningsResponse {
  accruedUsd: number;
  verificationStatus: VerificationStatus;
  payoutAvailable: false;
}

/**
 * GET /v1/creator/earnings — the authenticated creator's accrued balance (sum of every
 * LikenessUsageEvent.accruedUsd recorded for them) plus their verification status. Never 503s
 * on a missing likenessUsageRepository — it just reports a zero balance, same "clean no-op"
 * posture as recordLikenessUsage below.
 */
export function handleGetEarnings(creatorUserId: string, options: CreatorHandlerOptions = {}): CreatorResponse {
  const accruedUsd = options.likenessUsageRepository?.sumAccruedUsd(creatorUserId) ?? 0;
  const verificationStatus: VerificationStatus = options.payoutStub
    ? options.payoutStub.checkVerificationStatus(creatorUserId)
    : (options.creatorProfileRepository?.get(creatorUserId)?.verificationStatus ?? 'unverified');

  const earnings: EarningsResponse = { accruedUsd, verificationStatus, payoutAvailable: false };
  return { status: 200, body: { ...earnings } };
}

/**
 * POST /v1/creator/verification — kick off the stub identity-verification flow for the
 * authenticated creator. Thin wrapper over creator/payout_stub.ts's requestVerification; always
 * returns a session stuck in 'requires_input' — see that module's doc comment.
 */
export function handleRequestVerification(
  creatorUserId: string,
  options: CreatorHandlerOptions = {},
): CreatorResponse {
  if (!options.payoutStub) {
    return { status: 503, body: { error: 'identity verification is not configured on this server' } };
  }
  const verification = options.payoutStub.requestVerification(creatorUserId);
  return { status: 200, body: { verification } };
}

/**
 * POST /v1/creator/payout — thin wrapper over creator/payout_stub.ts's requestPayout. THIS
 * ALWAYS 403s in this build — that is correct, expected behavior (see creator/payout_stub.ts):
 * no creator can ever reach 'verified' yet, so every payout request is blocked by construction.
 */
export function handleRequestPayout(
  creatorUserId: string,
  body: unknown,
  options: CreatorHandlerOptions = {},
): CreatorResponse {
  if (!options.payoutStub) {
    return { status: 503, body: { error: 'payouts are not configured on this server' } };
  }

  let amountUsd: number;
  try {
    amountUsd = parsePayoutAmount(body);
  } catch (err) {
    if (err instanceof CreatorValidationError) {
      return { status: 400, body: { error: err.message, code: err.code } };
    }
    throw err;
  }

  try {
    options.payoutStub.requestPayout(creatorUserId, amountUsd);
    // Unreachable in this build (requestPayout always throws — see creator/payout_stub.ts), but
    // typed so a future real integration has a documented success shape to land into.
    return { status: 200, body: { ok: true } };
  } catch (err) {
    if (err instanceof PayoutBlockedError) {
      return {
        status: 403,
        body: {
          error: 'identity verification required before payout — none exists yet in this build',
          code: err.code,
        },
      };
    }
    if (err instanceof PayoutStubError) {
      return { status: 400, body: { error: err.message, code: err.code } };
    }
    throw err;
  }
}

function parsePayoutAmount(body: unknown): number {
  if (body !== null && typeof body === 'object' && 'amountUsd' in (body as Record<string, unknown>)) {
    const raw = (body as Record<string, unknown>).amountUsd;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  throw new CreatorValidationError('"amountUsd" must be a positive number', 'invalid_amount');
}

// ---------------------------------------------------------------------------
// Likeness-usage attribution — called fire-and-forget from companion/handlers.ts,
// companion/portrait_handlers.ts, companion/scene_handlers.ts.
// ---------------------------------------------------------------------------

export interface RecordLikenessUsageOptions {
  creatorPersonaRepository?: CreatorPersonaRepository;
  likenessUsageRepository?: LikenessUsageEventRepository;
}

/**
 * Fire-and-forget: if `personaId` belongs to a registered CreatorPersona, append a
 * LikenessUsageEvent for its owning creator at the placeholder rate (creator/types.ts's
 * LIKENESS_RATE_USD). Same pattern as companion/handlers.ts's `persistMemoryUpdate` — never
 * throws into the caller, never adds await-blocking latency (callers should NOT `await` this),
 * and no-ops cleanly (not an error) when:
 *   - `personaId` is absent/undefined (e.g. a companion with no creator persona attached), or
 *   - either repository is missing from `options` (creator marketplace not wired up), or
 *   - `personaId` doesn't match any registered CreatorPersona (the overwhelmingly common case —
 *     a plain fucklike.ai fictional companion, unaffected either way).
 */
export function recordLikenessUsage(
  personaId: string | undefined,
  eventType: LikenessEventType,
  options: RecordLikenessUsageOptions = {},
): void {
  if (!personaId) return;
  const { creatorPersonaRepository, likenessUsageRepository } = options;
  if (!creatorPersonaRepository || !likenessUsageRepository) return;
  void persistLikenessUsage(personaId, eventType, creatorPersonaRepository, likenessUsageRepository);
}

async function persistLikenessUsage(
  personaId: string,
  eventType: LikenessEventType,
  creatorPersonaRepository: CreatorPersonaRepository,
  likenessUsageRepository: LikenessUsageEventRepository,
): Promise<void> {
  try {
    const persona = creatorPersonaRepository.findByPersonaId(personaId);
    if (!persona) return; // not a creator-owned persona — the common case; silent no-op.
    likenessUsageRepository.append({
      id: randomUUID(),
      creatorUserId: persona.creatorUserId,
      personaId,
      eventType,
      accruedUsd: LIKENESS_RATE_USD[eventType],
      createdAt: Date.now(),
    });
  } catch (err) {
    console.error(
      `[creator/usage] failed to record ${eventType} usage for personaId=${personaId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
