/**
 * tenancy/catalog.ts — the ModelCatalog.
 *
 * Loads the model catalog (config/models.json) and resolves a concrete model for a tenant from
 * either an explicit model id OR a desired parameter count (nearest match). Resolution is
 * entitlement-aware: a tenant can only ever be handed a model their plan (and their own
 * maxActiveParams cap) permits. The catalog itself holds NO secrets — hosted/cloud endpoints
 * get their base URL and key from env at route time (see tenancy/router.ts).
 */
import type { ProviderKind } from '../providers/index.js';
import {
  effectiveParamCap,
  hasUsableByokKeys,
  planPolicy,
  type Hosting,
  type Tenant,
} from './tenant.js';

/** How a model may be delivered to a tenant. */
export type RunsOn = 'local' | 'hostinger' | 'openai_compatible' | 'byok';

/** A single catalog entry. `parameterCount` is in BILLIONS. Never contains secrets. */
export interface ModelEntry {
  /** Stable model id, e.g. "mistral-7b". */
  id: string;
  /** Human-readable name for UIs. */
  displayName: string;
  /** Active parameter count, in billions (e.g. 7, 8, 70). */
  parameterCount: number;
  /** Adapter used to reach it. */
  providerKind: ProviderKind;
  /** Where the endpoint physically lives. */
  hosting: Hosting;
  /** Relative price weight (1.0 = baseline hosted 8B; 0.0 = free local). */
  costMultiplier: number;
  /** Eligible delivery paths. */
  runsOn: readonly RunsOn[];
}

/** Shape of config/models.json. */
export interface ModelCatalogConfig {
  defaultModelId: string;
  models: ModelEntry[];
}

/** A model request: an explicit id, a desired parameter count (billions), or nothing. */
export interface ModelRequest {
  /** Explicit catalog model id. Wins over paramCount when both are given. */
  modelId?: string;
  /** Desired active parameter count in billions; resolves to the nearest allowed model. */
  paramCount?: number;
}

/** Raised when no model can satisfy a request within a tenant's entitlements. */
export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}

export class ModelCatalog {
  private readonly byId: Map<string, ModelEntry>;
  readonly models: readonly ModelEntry[];
  readonly defaultModelId: string;

  constructor(config: ModelCatalogConfig) {
    if (!config.models || config.models.length === 0) {
      throw new Error('ModelCatalog requires a non-empty models array.');
    }
    this.models = config.models.map(normalizeEntry);
    this.byId = new Map(this.models.map((m) => [m.id, m]));
    this.defaultModelId = config.defaultModelId ?? this.models[0].id;
    if (!this.byId.has(this.defaultModelId)) {
      throw new Error(`defaultModelId "${this.defaultModelId}" is not present in the catalog.`);
    }
  }

  /** Build a catalog from a parsed config object (e.g. an imported JSON module). */
  static fromConfig(config: ModelCatalogConfig): ModelCatalog {
    return new ModelCatalog(config);
  }

  /** Look up a model by id, or undefined. */
  get(id: string): ModelEntry | undefined {
    return this.byId.get(id);
  }

  /** All models a tenant is entitled to reach, given their plan and parameter cap. */
  allowedFor(tenant: Tenant): ModelEntry[] {
    const policy = planPolicy(tenant.plan);
    const cap = effectiveParamCap(tenant);
    const byok = tenant.plan === 'BYOK' && hasUsableByokKeys(tenant);
    return this.models.filter((m) => {
      if (cap !== null && m.parameterCount > cap) return false;
      // BYOK tenants reach any model they can point their own endpoint at.
      if (byok) return m.runsOn.includes('byok');
      return policy.allowedHostings.includes(m.hosting);
    });
  }

  /**
   * Resolve a concrete model for a tenant.
   *
   * Precedence:
   *   1. request.modelId (if allowed for the tenant).
   *   2. request.paramCount -> nearest allowed model by |parameterCount - paramCount|.
   *   3. tenant.preferredModelId (if allowed).
   *   4. the catalog default (if allowed), else the largest allowed model within cap.
   *
   * Throws ModelResolutionError only when the tenant is entitled to NO models at all, or when
   * an explicitly requested id exists but is outside the tenant's entitlements.
   */
  resolve(tenant: Tenant, request: ModelRequest = {}): ModelEntry {
    const allowed = this.allowedFor(tenant);
    if (allowed.length === 0) {
      throw new ModelResolutionError(
        `Tenant "${tenant.id}" (plan ${tenant.plan}) is not entitled to any catalog model.`,
      );
    }

    if (request.modelId) {
      const wanted = this.byId.get(request.modelId);
      if (!wanted) {
        throw new ModelResolutionError(`Unknown model id "${request.modelId}".`);
      }
      if (!allowed.some((m) => m.id === wanted.id)) {
        throw new ModelResolutionError(
          `Model "${request.modelId}" (${wanted.parameterCount}B, ${wanted.hosting}) is not ` +
            `available on plan ${tenant.plan}.`,
        );
      }
      return wanted;
    }

    if (typeof request.paramCount === 'number') {
      return nearestByParams(allowed, request.paramCount);
    }

    if (tenant.preferredModelId) {
      const preferred = allowed.find((m) => m.id === tenant.preferredModelId);
      if (preferred) return preferred;
    }

    const fallbackDefault = allowed.find((m) => m.id === this.defaultModelId);
    if (fallbackDefault) return fallbackDefault;

    // Largest model within the tenant's entitlements (best they're allowed to use).
    return allowed.reduce((best, m) => (m.parameterCount > best.parameterCount ? m : best));
  }
}

/** Pick the entry whose parameter count is closest to the target (ties -> smaller/cheaper). */
function nearestByParams(entries: ModelEntry[], target: number): ModelEntry {
  return entries.reduce((best, m) => {
    const dBest = Math.abs(best.parameterCount - target);
    const dM = Math.abs(m.parameterCount - target);
    if (dM < dBest) return m;
    if (dM === dBest && m.parameterCount < best.parameterCount) return m;
    return best;
  });
}

/** Validate + freeze a raw entry so a malformed catalog fails fast rather than mid-route. */
function normalizeEntry(raw: ModelEntry): ModelEntry {
  if (!raw.id) throw new Error('Catalog entry is missing an id.');
  if (typeof raw.parameterCount !== 'number' || raw.parameterCount <= 0) {
    throw new Error(`Catalog entry "${raw.id}" has an invalid parameterCount.`);
  }
  if (!raw.hosting) throw new Error(`Catalog entry "${raw.id}" is missing hosting.`);
  if (!raw.providerKind) throw new Error(`Catalog entry "${raw.id}" is missing providerKind.`);
  return {
    id: raw.id,
    displayName: raw.displayName ?? raw.id,
    parameterCount: raw.parameterCount,
    providerKind: raw.providerKind,
    hosting: raw.hosting,
    costMultiplier: raw.costMultiplier ?? 1.0,
    runsOn: raw.runsOn ?? [raw.hosting === 'cloud' ? 'openai_compatible' : raw.hosting, 'byok'],
  };
}
