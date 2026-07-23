/**
 * tenancy/index.ts — public surface of the tenancy (BYOK + subscription) layer.
 *
 * This layer decides, for a given Tenant, WHICH model to use and HOW it is served/paid for:
 *   - BYOK        -> the tenant's own OpenAI-compatible endpoint + key.
 *   - subscription -> HDV-hosted infrastructure using PLATFORM keys (Hostinger / cloud), or the
 *                     deterministic offline StubProvider when nothing is configured.
 *
 * It builds providers from providers/ (pure text transducers) and never touches agents,
 * RoutingPackets, APEX, KNOLL, or the ledger. Raw API keys are never logged or serialized.
 */
export type {
  Plan,
  Hosting,
  Tenant,
  ByokKeys,
  OpenAiCompatibleByokKey,
  PlanPolicy,
} from './tenant.js';
export {
  PLAN_POLICIES,
  planPolicy,
  hasUsableByokKeys,
  effectiveParamCap,
} from './tenant.js';

export type {
  ModelEntry,
  ModelCatalogConfig,
  ModelRequest,
  RunsOn,
} from './catalog.js';
export { ModelCatalog, ModelResolutionError } from './catalog.js';

export type {
  RoutePath,
  TenantRoute,
  ProviderRouterOptions,
  CreateTenantProviderOptions,
} from './router.js';
export {
  ProviderRouter,
  createTenantProvider,
  createTenantRoute,
  ENV_HOSTINGER_BASE_URL,
  ENV_HOSTINGER_API_KEY,
  ENV_CLOUD_BASE_URL,
  ENV_CLOUD_API_KEY,
  ENV_LOCAL_BASE_URL,
  ENV_LOCAL_API_KEY,
} from './router.js';

export { loadCatalog, defaultCatalog } from './load.js';
