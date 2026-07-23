/**
 * tenancy/tenant.ts — the Tenant model and per-plan entitlements.
 *
 * A Tenant chooses (a) how many parameters / which model they want, and (b) how it is paid for:
 *   - a subscription PLAN whose LLM calls run on HDV-hosted infrastructure (platform keys), or
 *   - BYOK ("bring your own key"): the tenant supplies their own OpenAI-compatible endpoint
 *     + key, and HDV never sees a platform bill for those calls.
 *
 * This module is pure data + policy. It knows NOTHING about agents, RoutingPackets, APEX,
 * KNOLL, DREAM, or VISION. It only decides which catalog models a tenant may reach and how a
 * provider should be built for them (see tenancy/catalog.ts and tenancy/router.ts).
 */

/**
 * Subscription tiers plus the BYOK escape hatch.
 *   FREE       — local free models only (no hosted spend).
 *   STARTER    — local + small hosted (Hostinger) models.
 *   PRO        — local + hosted + cloud models, larger parameter budget.
 *   ENTERPRISE — everything, no parameter cap.
 *   BYOK       — tenant supplies their own key/endpoint; billed by their provider, not HDV.
 */
export type Plan = 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE' | 'BYOK';

/** Where a model's endpoint physically lives. Mirrors the catalog `hosting` field. */
export type Hosting = 'local' | 'hostinger' | 'cloud';

/**
 * Per-tenant credentials for the BYOK path. Only OpenAI-compatible endpoints are supported
 * (the same shape every provider in providers/ already speaks). The apiKey is a secret and is
 * NEVER logged, serialized into route descriptions, or included in error messages.
 */
export interface OpenAiCompatibleByokKey {
  /** Secret API key sent as `Authorization: Bearer <key>`. Never logged. */
  apiKey: string;
  /** Base URL including the version path, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  /**
   * Optional default model id to send to the tenant's endpoint. When omitted, the resolved
   * catalog model id is used.
   */
  model?: string;
}

/** Container for a tenant's own provider keys (currently just OpenAI-compatible). */
export interface ByokKeys {
  openaiCompatible?: OpenAiCompatibleByokKey;
}

/** A paying (or free) tenant of the platform. */
export interface Tenant {
  /** Stable tenant identifier. */
  id: string;
  /** Subscription tier, or BYOK. */
  plan: Plan;
  /** Tenant-supplied provider keys (only consulted on the BYOK path). */
  byokKeys?: ByokKeys;
  /** Preferred catalog model id; used when a request does not specify one. */
  preferredModelId?: string;
  /**
   * Optional self-imposed cap on active parameter count (in BILLIONS). Combined with the plan's
   * own cap: the tighter of the two wins. Handy for cost control on higher tiers.
   */
  maxActiveParams?: number;
}

/** Policy attached to each subscription plan. */
export interface PlanPolicy {
  /** Which hostings this plan may route to. */
  allowedHostings: readonly Hosting[];
  /**
   * Maximum active parameter count in BILLIONS, or null for "no cap". BYOK is uncapped because
   * the tenant pays their own provider directly.
   */
  maxActiveParams: number | null;
}

/** The entitlement table. BYOK may reach any hosting (it uses the tenant's own endpoint). */
export const PLAN_POLICIES: Readonly<Record<Plan, PlanPolicy>> = {
  FREE: { allowedHostings: ['local'], maxActiveParams: 7 },
  STARTER: { allowedHostings: ['local', 'hostinger'], maxActiveParams: 8 },
  PRO: { allowedHostings: ['local', 'hostinger', 'cloud'], maxActiveParams: 70 },
  ENTERPRISE: { allowedHostings: ['local', 'hostinger', 'cloud'], maxActiveParams: null },
  BYOK: { allowedHostings: ['local', 'hostinger', 'cloud'], maxActiveParams: null },
};

/** Look up the policy for a plan. */
export function planPolicy(plan: Plan): PlanPolicy {
  return PLAN_POLICIES[plan];
}

/** True when the tenant is on the BYOK path AND actually supplied usable OpenAI-compatible keys. */
export function hasUsableByokKeys(tenant: Tenant): boolean {
  const k = tenant.byokKeys?.openaiCompatible;
  return Boolean(k && k.apiKey && k.baseUrl);
}

/**
 * The effective active-parameter cap (in billions) for a tenant: the tighter of the plan cap
 * and the tenant's own `maxActiveParams`. Returns null when neither imposes a cap.
 */
export function effectiveParamCap(tenant: Tenant): number | null {
  const planCap = planPolicy(tenant.plan).maxActiveParams;
  const tenantCap = tenant.maxActiveParams ?? null;
  if (planCap === null) return tenantCap;
  if (tenantCap === null) return planCap;
  return Math.min(planCap, tenantCap);
}
