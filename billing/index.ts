/**
 * billing/index.ts — public surface of the PRODUCT metering layer (HDV Foundation).
 *
 * The commercial skin over the APEX ledger: plan tiers, a pricing engine, per-tenant allowance
 * accounts with clear cost + occurrence metrics, and a MeterService that attributes live APEX
 * traffic to a tenant via the read-only dispatch-observer seam. Nothing here routes, gates,
 * executes, creates, or interprets — it only prices and accounts, so the constitution holds.
 *
 * `BillingService` bundles the three collaborators (pricing · store · meter) into one object
 * the gateway and demos can wire in a single line.
 */
export * from './types.js';
export {
  PricingBook,
  loadPricingBook,
  DEFAULT_PRICING_PATH,
} from './pricing.js';
export type {
  RawTierPricing,
  RawPricingConfig,
  TierPricing,
  CostEstimate,
  PricingTableRow,
  EstimateInput,
} from './pricing.js';
export {
  AllowanceAccount,
  AllowanceStore,
  DEFAULT_MAX_OCCURRENCES,
} from './allowance.js';
export type {
  AllowanceAccountOptions,
  AllowanceStoreOptions,
} from './allowance.js';
export { MeterService, kindForDestination } from './meter.js';
export type { MeterServiceOptions, MeterStats } from './meter.js';
export { StripeCheckoutStub, StripeStubError, DEFAULT_MONTHLY_PRICE_USD } from './stripe_stub.js';
export type {
  CreateCheckoutSessionInput,
  CheckoutSession,
  CheckoutSessionStatus,
  PaymentStatus,
  BillingInterval,
  CheckoutMode,
  StripeCheckoutStubOptions,
} from './stripe_stub.js';

import { PricingBook, loadPricingBook } from './pricing.js';
import { AllowanceStore } from './allowance.js';
import { MeterService } from './meter.js';
import { StripeCheckoutStub } from './stripe_stub.js';
import type { PlanTier } from './types.js';

export interface BillingServiceOptions {
  /** Provide a pre-loaded pricing book; otherwise load config/pricing.json (or HDV_PRICING_PATH). */
  pricing?: PricingBook;
  /** Path override for the pricing config (ignored when `pricing` is provided). */
  pricingPath?: string;
  /** Provide a pre-built store; otherwise one is created (seeding the offline `demo` tenant). */
  store?: AllowanceStore;
  /** Tier for tenants that consume before an allowance is set. Default 'FREE'. */
  defaultTier?: PlanTier;
  /** Tier for the seeded `demo` tenant. Default 'STARTER'. */
  demoTier?: PlanTier;
  /** Tenant the MeterService attributes live APEX traffic to. Default 'demo'. */
  meterTenantId?: string;
  /** Personas assumed per successful ephemeral dispatch (see MeterService). Default 1. */
  personasPerDispatch?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * One-line composition of the billing layer. Reads env for sensible defaults:
 *   HDV_PRICING_PATH          — pricing config path
 *   HDV_BILLING_DEFAULT_TIER  — default tier for new tenants
 *   HDV_BILLING_METER_TENANT  — tenant to attribute live traffic to (default 'demo')
 */
export class BillingService {
  readonly pricing: PricingBook;
  readonly store: AllowanceStore;
  readonly meter: MeterService;
  /**
   * Stripe Checkout — a stub by default (no STRIPE_SECRET_KEY ⇒ fake test-mode sessions, no
   * network I/O, no real charge). Swapping in a real Stripe client later is the single
   * constructor change stripe_stub.ts documents; nothing else in the gateway needs to change.
   */
  readonly checkout: StripeCheckoutStub;

  constructor(options: BillingServiceOptions = {}) {
    const env = options.env ?? process.env;
    this.pricing = options.pricing ?? loadPricingBook(options.pricingPath, env);
    const defaultTier = options.defaultTier ?? asTier(env.HDV_BILLING_DEFAULT_TIER) ?? 'FREE';
    this.store =
      options.store ??
      new AllowanceStore(this.pricing, {
        defaultTier,
        demoTier: options.demoTier ?? 'STARTER',
        seedDemo: true,
      });
    this.meter = new MeterService({
      store: this.store,
      tenantId: options.meterTenantId ?? envTenant(env) ?? 'demo',
      personasPerDispatch: options.personasPerDispatch,
    });
    this.checkout = new StripeCheckoutStub({ env });
  }
}

function asTier(value: string | undefined): PlanTier | undefined {
  if (!value) return undefined;
  const upper = value.trim().toUpperCase();
  const tiers: readonly string[] = ['FREE', 'STARTER', 'PRO', 'ENTERPRISE', 'BYOK'];
  return tiers.includes(upper) ? (upper as PlanTier) : undefined;
}

function envTenant(env: NodeJS.ProcessEnv): string | undefined {
  const t = env.HDV_BILLING_METER_TENANT?.trim();
  return t && t.length > 0 ? t : undefined;
}
