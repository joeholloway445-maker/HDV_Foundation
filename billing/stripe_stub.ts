/**
 * billing/stripe_stub.ts — a dependency-free Stripe Checkout STUB for the launch.
 *
 * We want a working "subscribe / upgrade" flow at launch WITHOUT taking a hard dependency on the
 * `stripe` SDK (and without a live account being provisioned). This module models the small slice
 * of the Stripe Checkout Sessions API the product actually needs — create a session, get back a
 * hosted-checkout URL, retrieve/settle it — behind an interface that a real Stripe client can drop
 * into later. It performs NO network I/O and requires NO secret key.
 *
 * Modes:
 *   - No STRIPE_SECRET_KEY (or a `sk_test_…` key)  → TEST mode: fake `cs_test_…` sessions.
 *   - A `sk_live_…` key                            → LIVE-shaped stub: `cs_live_…` ids (still a
 *     stub — it does NOT contact Stripe; it just reflects the intended mode so callers/tests can
 *     assert on it). Swapping in the real SDK is a single-constructor change.
 *
 * Constitution note: this is a commercial/billing surface only. It prices and issues checkout
 * intents; it NEVER routes a RoutingPacket, calls KNOLL/APEX, executes, or creates agents.
 */
import { randomUUID } from 'node:crypto';
import type { PlanTier } from './types.js';
import { isPlanTier } from './types.js';

/** Billing interval for a subscription checkout. */
export type BillingInterval = 'month' | 'year';

/** Checkout mode — a one-off payment or a recurring subscription. */
export type CheckoutMode = 'subscription' | 'payment';

/** Lifecycle of a stub session (mirrors the fields callers care about from Stripe). */
export type CheckoutSessionStatus = 'open' | 'complete' | 'expired';
export type PaymentStatus = 'unpaid' | 'paid' | 'no_payment_required';

/**
 * Default monthly platform fee per tier, in whole USD. These are the "flat governance platform
 * fee" figures the marketing page references; usage is metered separately by billing/pricing.ts.
 * FREE and BYOK carry no recurring fee. Override via `StripeCheckoutStubOptions.monthlyPriceUsd`.
 */
export const DEFAULT_MONTHLY_PRICE_USD: Record<PlanTier, number> = {
  FREE: 0,
  STARTER: 29,
  PRO: 99,
  ENTERPRISE: 499,
  BYOK: 19,
};

/** Input to createCheckoutSession — a tier plus optional customer + redirect details. */
export interface CreateCheckoutSessionInput {
  /** The plan the customer is subscribing to / upgrading to. */
  tier: PlanTier | string;
  /** Owning tenant (recorded in metadata; not required to create a session). */
  tenantId?: string;
  /** Customer email to prefill on the hosted page. */
  customerEmail?: string;
  /** month | year (subscription mode only). Default 'month'. */
  interval?: BillingInterval;
  /** Number of seats/units. Default 1. */
  quantity?: number;
  /** subscription | payment. Default 'subscription'. */
  mode?: CheckoutMode;
  /** Where Stripe redirects on success. Falls back to the stub's configured base URL. */
  successUrl?: string;
  /** Where Stripe redirects on cancel. Falls back to the stub's configured base URL. */
  cancelUrl?: string;
  /** Arbitrary metadata echoed back on the session (e.g. campaign, referral). */
  metadata?: Record<string, string>;
  /** Override the created timestamp (tests / replay). */
  now?: number;
}

/** A stub Checkout Session — the fields callers read from a real Stripe session. */
export interface CheckoutSession {
  /** Session id, e.g. `cs_test_…` (test) or `cs_live_…` (live-shaped stub). */
  id: string;
  object: 'checkout.session';
  /** The hosted-checkout URL the client should redirect the browser to. */
  url: string;
  mode: CheckoutMode;
  status: CheckoutSessionStatus;
  paymentStatus: PaymentStatus;
  /** false in test mode, true when a `sk_live_…` key is configured. */
  livemode: boolean;
  currency: string;
  /** Total amount in the smallest currency unit (cents), matching Stripe conventions. */
  amountTotal: number;
  /** Convenience: amountTotal / 100. */
  amountTotalUsd: number;
  tier: PlanTier;
  interval: BillingInterval;
  quantity: number;
  customerEmail?: string;
  tenantId?: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  /** Epoch ms created. */
  created: number;
  /** Epoch ms the session expires (Stripe default: 24h). */
  expiresAt: number;
}

export interface StripeCheckoutStubOptions {
  /** Secret key. Defaults to env STRIPE_SECRET_KEY. Optional — absent ⇒ test mode. */
  secretKey?: string;
  /** Base URL used to synthesize success/cancel URLs when the caller omits them. */
  baseUrl?: string;
  /** Override the per-tier monthly USD price table. */
  monthlyPriceUsd?: Partial<Record<PlanTier, number>>;
  /** Injectable id generator (tests / determinism). */
  idFactory?: () => string;
  env?: NodeJS.ProcessEnv;
}

/** Thrown for invalid checkout input (unknown tier, bad quantity). */
export class StripeStubError extends Error {
  readonly code = 'invalid_checkout';
  constructor(message: string) {
    super(message);
    this.name = 'StripeStubError';
  }
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const YEARLY_MONTHS_CHARGED = 10; // 2 months free on annual, a common SaaS convention.

/**
 * The Stripe Checkout stub. Interface-compatible enough that a real `stripe.checkout.sessions`
 * client can replace it later; today it issues fake but well-formed sessions with no network.
 */
export class StripeCheckoutStub {
  readonly livemode: boolean;
  /** True when SOME Stripe secret key (test or live) is configured. */
  readonly configured: boolean;
  readonly currency = 'usd';
  private readonly baseUrl: string;
  private readonly prices: Record<PlanTier, number>;
  private readonly idFactory: () => string;
  private readonly sessions = new Map<string, CheckoutSession>();

  constructor(options: StripeCheckoutStubOptions = {}) {
    const env = options.env ?? process.env;
    const secretKey = (options.secretKey ?? env.STRIPE_SECRET_KEY ?? '').trim();
    this.configured = secretKey.length > 0;
    // Live only when an explicit sk_live_ key is present; everything else is a safe test stub.
    this.livemode = secretKey.startsWith('sk_live_');
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? env.HDV_PUBLIC_URL ?? 'https://hdvfoundation.dev');
    this.prices = { ...DEFAULT_MONTHLY_PRICE_USD, ...(options.monthlyPriceUsd ?? {}) };
    this.idFactory = options.idFactory ?? (() => randomUUID().replace(/-/g, ''));
  }

  /** Monthly USD price for a tier. */
  monthlyPrice(tier: PlanTier): number {
    return this.prices[tier];
  }

  /**
   * Create a (stub) Checkout Session for a subscription/upgrade. Returns a session with a hosted
   * checkout `url` the client redirects to. Throws StripeStubError on invalid input.
   */
  createCheckoutSession(input: CreateCheckoutSessionInput): CheckoutSession {
    const tier = normaliseTier(input.tier);
    const mode: CheckoutMode = input.mode ?? 'subscription';
    const interval: BillingInterval = input.interval ?? 'month';
    const quantity = normaliseQuantity(input.quantity);
    const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();

    const monthly = this.prices[tier];
    const perUnit = interval === 'year' ? monthly * YEARLY_MONTHS_CHARGED : monthly;
    const amountUsd = perUnit * quantity;
    const amountTotal = Math.round(amountUsd * 100);

    const idPrefix = this.livemode ? 'cs_live_' : 'cs_test_';
    const id = `${idPrefix}${this.idFactory()}`;

    // Fake but well-formed hosted-checkout URL (mirrors Stripe's cs-scoped pay URLs).
    const url = `https://checkout.stripe.com/c/pay/${id}#hdv-stub`;

    const successUrl = input.successUrl ?? `${this.baseUrl}/billing/success?session_id=${id}`;
    const cancelUrl = input.cancelUrl ?? `${this.baseUrl}/billing/cancel`;

    // A $0 tier (FREE) needs no payment; anything else is unpaid until settled.
    const paymentStatus: PaymentStatus = amountTotal === 0 ? 'no_payment_required' : 'unpaid';

    const session: CheckoutSession = {
      id,
      object: 'checkout.session',
      url,
      mode,
      status: 'open',
      paymentStatus,
      livemode: this.livemode,
      currency: this.currency,
      amountTotal,
      amountTotalUsd: amountTotal / 100,
      tier,
      interval,
      quantity,
      customerEmail: cleanOptional(input.customerEmail),
      tenantId: cleanOptional(input.tenantId),
      successUrl,
      cancelUrl,
      metadata: { tier, tenantId: input.tenantId ?? '', ...(input.metadata ?? {}) },
      created: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(id, session);
    return session;
  }

  /** Retrieve a previously-created session (stub-local). */
  retrieveSession(id: string): CheckoutSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Simulate the customer completing payment (what a real `checkout.session.completed` webhook
   * would confirm). Returns the settled session, or undefined if the id is unknown/expired.
   */
  markSessionPaid(id: string, now: number = Date.now()): CheckoutSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (now >= session.expiresAt) {
      session.status = 'expired';
      return session;
    }
    session.status = 'complete';
    session.paymentStatus = session.amountTotal === 0 ? 'no_payment_required' : 'paid';
    return session;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normaliseTier(raw: PlanTier | string): PlanTier {
  const upper = typeof raw === 'string' ? raw.trim().toUpperCase() : raw;
  if (!isPlanTier(upper)) {
    throw new StripeStubError('tier must be one of FREE, STARTER, PRO, ENTERPRISE, BYOK');
  }
  return upper;
}

function normaliseQuantity(raw: number | undefined): number {
  if (raw === undefined) return 1;
  if (!Number.isFinite(raw) || raw < 1) {
    throw new StripeStubError('quantity must be a positive integer');
  }
  return Math.floor(raw);
}

function cleanOptional(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
