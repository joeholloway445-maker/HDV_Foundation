/**
 * tenancy/router.ts — ProviderRouter: choose HOW a tenant's chosen model is served.
 *
 * Two payment/serving paths:
 *   1. BYOK   — plan === 'BYOK' AND the tenant supplied OpenAI-compatible keys.
 *               We build an OpenAiCompatibleProvider pointed at the TENANT's baseUrl + key.
 *   2. HDV    — every other plan. Hosted on HDV infrastructure using PLATFORM keys from env:
 *               - hosting 'hostinger' -> HDV_HOSTINGER_LLM_*  (Hostinger-hosted open models)
 *               - hosting 'cloud'     -> HDV_LLM_*            (cloud OpenAI-compatible)
 *               - hosting 'local'     -> HDV_LOCAL_LLM_* if set, else the offline StubProvider.
 *   When a hosted endpoint is not configured the router degrades to the deterministic offline
 *   StubProvider so the system never hard-fails on a missing platform env var.
 *
 * SECURITY: no raw API key is EVER logged, thrown, or serialized. Route descriptions expose the
 * base URL (safe) and a redacted key hint only. This module is pure text-provider plumbing; it
 * knows nothing about agents, RoutingPackets, APEX, KNOLL, or the ledger.
 */
import {
  OpenAiCompatibleProvider,
  StubProvider,
  redactSecret,
  type LlmProvider,
} from '../providers/index.js';
import { ModelCatalog, type ModelEntry, type ModelRequest } from './catalog.js';
import { hasUsableByokKeys, type Tenant } from './tenant.js';

/** Which serving path the router selected. */
export type RoutePath = 'byok' | 'subscription' | 'local' | 'stub';

/** Env var names consulted for the HDV (platform-paid) serving paths. */
export const ENV_HOSTINGER_BASE_URL = 'HDV_HOSTINGER_LLM_BASE_URL';
export const ENV_HOSTINGER_API_KEY = 'HDV_HOSTINGER_LLM_API_KEY';
export const ENV_CLOUD_BASE_URL = 'HDV_LLM_BASE_URL';
export const ENV_CLOUD_API_KEY = 'HDV_LLM_API_KEY';
export const ENV_LOCAL_BASE_URL = 'HDV_LOCAL_LLM_BASE_URL';
export const ENV_LOCAL_API_KEY = 'HDV_LOCAL_LLM_API_KEY';

/**
 * The result of routing: the built provider plus safe, key-free metadata describing WHY it was
 * chosen. Safe to log or serialize — it contains no secrets.
 */
export interface TenantRoute {
  /** The provider to call `.complete()` on. */
  provider: LlmProvider;
  /** The resolved catalog model. */
  model: ModelEntry;
  /** Which serving path was taken. */
  path: RoutePath;
  /** Base URL of the endpoint (or "(stub)" for the offline path). Never contains a key. */
  endpoint: string;
  /** Redacted key hint (never the raw key). "(none)" when keyless. */
  keyHint: string;
  /** Who pays: the tenant (BYOK) or the platform (HDV subscription). */
  billedTo: 'tenant' | 'platform';
}

export interface ProviderRouterOptions {
  /** Environment source for platform keys/URLs (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch, passed through to HTTP providers. Handy for tests. */
  fetchImpl?: typeof fetch;
}

export class ProviderRouter {
  private readonly catalog: ModelCatalog;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl?: typeof fetch;

  constructor(catalog: ModelCatalog, options: ProviderRouterOptions = {}) {
    this.catalog = catalog;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl;
  }

  /**
   * Resolve the tenant's model and build a provider for it, returning key-free route metadata.
   */
  route(tenant: Tenant, request: ModelRequest = {}): TenantRoute {
    const model = this.catalog.resolve(tenant, request);

    // 1. BYOK path: the tenant supplies their own endpoint + key.
    if (tenant.plan === 'BYOK' && hasUsableByokKeys(tenant)) {
      const key = tenant.byokKeys!.openaiCompatible!;
      const provider = new OpenAiCompatibleProvider({
        baseUrl: key.baseUrl,
        apiKey: key.apiKey,
        model: key.model ?? model.id,
        fetchImpl: this.fetchImpl,
      });
      return {
        provider,
        model,
        path: 'byok',
        endpoint: key.baseUrl,
        keyHint: redactSecret(key.apiKey),
        billedTo: 'tenant',
      };
    }

    // 2. HDV subscription paths (platform keys), by where the model is hosted.
    switch (model.hosting) {
      case 'hostinger':
        return this.hostedRoute(model, 'subscription', ENV_HOSTINGER_BASE_URL, ENV_HOSTINGER_API_KEY);
      case 'cloud':
        return this.hostedRoute(model, 'subscription', ENV_CLOUD_BASE_URL, ENV_CLOUD_API_KEY);
      case 'local':
      default:
        return this.localRoute(model);
    }
  }

  /** Build the provider only (convenience for callers that don't need route metadata). */
  provider(tenant: Tenant, request: ModelRequest = {}): LlmProvider {
    return this.route(tenant, request).provider;
  }

  /**
   * A hosted (Hostinger or cloud) path using PLATFORM env keys. Degrades to the offline stub
   * when the base URL is not configured, so a missing platform env var never hard-fails.
   */
  private hostedRoute(
    model: ModelEntry,
    path: RoutePath,
    baseUrlVar: string,
    apiKeyVar: string,
  ): TenantRoute {
    const baseUrl = this.env[baseUrlVar];
    if (!baseUrl) {
      return this.stubRoute(model);
    }
    const apiKey = this.env[apiKeyVar];
    const provider = new OpenAiCompatibleProvider({
      baseUrl,
      apiKey,
      model: model.id,
      fetchImpl: this.fetchImpl,
    });
    return {
      provider,
      model,
      path,
      endpoint: baseUrl,
      keyHint: redactSecret(apiKey),
      billedTo: 'platform',
    };
  }

  /** Local free models: a real local endpoint if configured, otherwise the offline stub. */
  private localRoute(model: ModelEntry): TenantRoute {
    const baseUrl = this.env[ENV_LOCAL_BASE_URL];
    if (!baseUrl) {
      return this.stubRoute(model);
    }
    const apiKey = this.env[ENV_LOCAL_API_KEY];
    const provider = new OpenAiCompatibleProvider({
      baseUrl,
      apiKey,
      model: model.id,
      fetchImpl: this.fetchImpl,
    });
    return {
      provider,
      model,
      path: 'local',
      endpoint: baseUrl,
      keyHint: redactSecret(apiKey),
      billedTo: 'platform',
    };
  }

  /** The deterministic offline fallback. Reports the requested model id for continuity. */
  private stubRoute(model: ModelEntry): TenantRoute {
    return {
      provider: new StubProvider({ model: model.id }),
      model,
      path: 'stub',
      endpoint: '(stub)',
      keyHint: '(none)',
      billedTo: 'platform',
    };
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export interface CreateTenantProviderOptions extends ProviderRouterOptions {
  /** The catalog to resolve against (required). */
  catalog: ModelCatalog;
  /** Optional model request (id or paramCount). */
  request?: ModelRequest;
}

/**
 * createTenantProvider — one-call factory: pick the tenant's model and build a provider.
 * Returns only the provider; use ProviderRouter.route(...) when you also need route metadata.
 */
export function createTenantProvider(
  tenant: Tenant,
  options: CreateTenantProviderOptions,
): LlmProvider {
  const router = new ProviderRouter(options.catalog, {
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
  return router.provider(tenant, options.request ?? {});
}

/** Like createTenantProvider but returns the full, key-free TenantRoute. */
export function createTenantRoute(
  tenant: Tenant,
  options: CreateTenantProviderOptions,
): TenantRoute {
  const router = new ProviderRouter(options.catalog, {
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
  return router.route(tenant, options.request ?? {});
}
