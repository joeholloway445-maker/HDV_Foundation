/**
 * market/handlers.ts — request handlers for the launch waitlist.
 *
 * These are pure-ish functions that take parsed input and return `{ status, body }`, exactly like
 * the HOPE gateway's own handlers, so they can be unit-tested WITHOUT binding a port and wired
 * into the gateway's route table with a single line. They own NO transport and NO agent logic —
 * they validate input, delegate to the WaitlistStore, and shape the JSON response.
 */
import { WaitlistValidationError, type WaitlistSignupInput } from './types.js';
import type { WaitlistStore } from './store.js';

/** Minimal response shape (structurally compatible with the gateway's GatewayResponse). */
export interface MarketResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface WaitlistSignupContext {
  /** Server-derived client IP (never trusted from the body). */
  ip?: string;
  /** Fallback source when the body doesn't specify one (e.g. 'api', 'waitlist-page'). */
  defaultSource?: string;
}

/**
 * POST /v1/waitlist — record a waitlist signup. Idempotent by email: re-signing returns 200 with
 * `duplicate: true` rather than erroring, so the marketing form is safe to submit twice.
 */
export function handleWaitlistSignup(
  store: WaitlistStore,
  body: unknown,
  ctx: WaitlistSignupContext = {},
): MarketResponse {
  if (body === null || typeof body !== 'object') {
    return {
      status: 400,
      body: { error: 'body must be JSON with at least an "email" field', code: 'invalid_signup' },
    };
  }

  const b = body as Record<string, unknown>;
  const input: WaitlistSignupInput = {
    email: b.email,
    name: b.name,
    company: b.company,
    interestedTier: b.interestedTier ?? b.tier,
    useCase: b.useCase ?? b.use_case,
    source: b.source ?? ctx.defaultSource,
    referral: b.referral ?? b.ref,
    ip: ctx.ip,
  };

  try {
    const result = store.add(input);
    return {
      // 201 for a brand-new signup, 200 for an idempotent re-signup.
      status: result.created ? 201 : 200,
      body: {
        ok: true,
        created: result.created,
        duplicate: result.duplicate,
        position: result.position,
        message: result.created
          ? "You're on the list — we'll be in touch at launch."
          : "You're already on the list — we've got you.",
        entry: result.entry as unknown as Record<string, unknown>,
      },
    };
  } catch (err) {
    if (err instanceof WaitlistValidationError) {
      return { status: 400, body: { error: err.message, code: err.code } };
    }
    // Store-full (or any unexpected condition) — surface as 503 so the client can retry later.
    const message = err instanceof Error ? err.message : String(err);
    return { status: 503, body: { error: message, code: 'waitlist_unavailable' } };
  }
}

/**
 * GET /v1/waitlist/stats — privacy-safe aggregate stats. This is a PROTECTED route (the gateway
 * gates it with the standard API-key middleware); it returns counts only, never raw emails.
 */
export function handleWaitlistStats(store: WaitlistStore, now?: number): MarketResponse {
  const stats = store.stats(now);
  return { status: 200, body: { ...(stats as unknown as Record<string, unknown>) } };
}
