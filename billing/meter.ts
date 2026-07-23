/**
 * billing/meter.ts — the MeterService: bridges live APEX traffic to the billing layer.
 *
 * It plugs into APEX's read-only `DispatchObserver` seam (see apex/router.ts) — the SAME
 * out-of-band hook the observability MetricsCollector uses — and attributes each successful
 * dispatch to a tenant's allowance. It NEVER routes, gates, mutates a packet, or influences a
 * KNOLL verdict; if it throws, APEX swallows it and routing is unaffected.
 *
 * Cost attribution (per the product spec):
 *   - When an ACTIVE-persona estimate is available (a successful route to an ephemeral agent
 *     spins up a node's personas), attribute cost = personas × MODEL_PARAMS × duration through
 *     the PricingBook (billing/allowance.consume).
 *   - Otherwise, fall back to the APEX ledger's own `cost_usd` for the dispatch.
 *
 * The meter is observation, not enforcement: it records what already happened. Over-cap
 * occurrences are logged (accepted:false) and counted, but the meter cannot un-route a packet.
 */
import { AgentRole } from '../config/routing_schema.js';
import { EPHEMERAL_AGENTS, MODEL_PARAMS, MODEL_SIZE } from '../nodes/index.js';
import type { DispatchEvent, DispatchObserver } from '../apex/router.js';
import type { AllowanceStore } from './allowance.js';
import type { OccurrenceKind } from './types.js';

/** Ephemeral roles whose successful dispatch conceptually spins up personas. */
const EPHEMERAL_SET: ReadonlySet<AgentRole> = new Set(EPHEMERAL_AGENTS);

export interface MeterServiceOptions {
  /** The allowance store to attribute usage against. */
  store: AllowanceStore;
  /** Tenant every metered dispatch is billed to. Defaults to 'demo'. */
  tenantId?: string;
  /**
   * Personas assumed to spin up per successful ephemeral dispatch. Multiplied by MODEL_PARAMS
   * to get the ACTIVE parameter footprint. Default 1 (one conceptual 7B persona per dispatch).
   */
  personasPerDispatch?: number;
  /**
   * Override the active-persona estimate for an event. Return a positive number to price via
   * activeParams×duration; return 0/undefined to fall back to the ledger cost_usd.
   */
  personaEstimator?: (event: DispatchEvent) => number | undefined;
  /** Provider label recorded on occurrences. Default 'big5-matrix'. */
  provider?: string;
  /** Model label recorded on occurrences. Default MODEL_SIZE ('7B'). */
  model?: string;
  /** Floor for the per-dispatch duration (dispatches are sub-millisecond). Default 0.001s. */
  minDurationSec?: number;
  /** When true (default) only SUCCESS dispatches are metered (billable executions). */
  onlySuccess?: boolean;
}

export interface MeterStats {
  tenantId: string;
  /** Events the meter attempted to bill. */
  metered: number;
  /** Events skipped (e.g. non-SUCCESS when onlySuccess). */
  skipped: number;
  /** Metered via the active-persona estimate. */
  estimated: number;
  /** Metered via the ledger cost_usd fallback. */
  fallback: number;
  /** Occurrences the allowance rejected (over hard cap). */
  rejected: number;
  /** Total USD the meter attributed (accepted occurrences only). */
  attributedUsd: number;
  personasPerDispatch: number;
  provider: string;
  model: string;
}

export class MeterService {
  readonly store: AllowanceStore;
  readonly tenantId: string;
  private readonly personasPerDispatch: number;
  private readonly personaEstimator: (event: DispatchEvent) => number | undefined;
  private readonly provider: string;
  private readonly model: string;
  private readonly minDurationSec: number;
  private readonly onlySuccess: boolean;

  private metered = 0;
  private skipped = 0;
  private estimated = 0;
  private fallback = 0;
  private rejected = 0;
  private attributedUsd = 0;

  constructor(options: MeterServiceOptions) {
    this.store = options.store;
    this.tenantId = (options.tenantId ?? 'demo').trim() || 'demo';
    this.personasPerDispatch = options.personasPerDispatch && options.personasPerDispatch > 0 ? options.personasPerDispatch : 1;
    this.provider = (options.provider ?? 'big5-matrix').trim() || 'big5-matrix';
    this.model = (options.model ?? MODEL_SIZE).trim() || MODEL_SIZE;
    this.minDurationSec = options.minDurationSec && options.minDurationSec > 0 ? options.minDurationSec : 0.001;
    this.onlySuccess = options.onlySuccess ?? true;
    this.personaEstimator = options.personaEstimator ?? ((event) => this.defaultEstimator(event));
  }

  /** Bind this meter as a router `DispatchObserver`. Errors are swallowed — never breaks routing. */
  observer(): DispatchObserver {
    return (event) => {
      try {
        this.observe(event);
      } catch {
        // Metering is best-effort and strictly out-of-band; never surface into the transport.
      }
    };
  }

  /** Attribute a single dispatch to the configured tenant's allowance. */
  observe(event: DispatchEvent): void {
    if (this.onlySuccess && event.status !== 'SUCCESS') {
      this.skipped += 1;
      return;
    }

    const personas = this.personaEstimator(event) ?? 0;
    const kind = kindForDestination(event.destination);

    let result;
    if (personas > 0) {
      const activeParams = Math.round(personas * MODEL_PARAMS);
      const durationSec = Math.max(event.durationMs / 1000, this.minDurationSec);
      result = this.store.consume(this.tenantId, {
        activeParams,
        durationSec,
        kind,
        provider: this.provider,
        model: this.model,
      });
      this.estimated += 1;
    } else {
      // No persona estimate — fall back to the APEX ledger's own cost for this dispatch.
      result = this.store.consume(this.tenantId, {
        activeParams: 0,
        durationSec: 0,
        kind,
        provider: this.provider,
        model: this.model,
        costOverrideUsd: event.cost_usd,
      });
      this.fallback += 1;
    }

    this.metered += 1;
    if (result.accepted) {
      this.attributedUsd = round6(this.attributedUsd + result.costUsd);
    } else {
      this.rejected += 1;
    }
  }

  /** A read-only snapshot of what the meter has done so far. */
  stats(): MeterStats {
    return {
      tenantId: this.tenantId,
      metered: this.metered,
      skipped: this.skipped,
      estimated: this.estimated,
      fallback: this.fallback,
      rejected: this.rejected,
      attributedUsd: this.attributedUsd,
      personasPerDispatch: this.personasPerDispatch,
      provider: this.provider,
      model: this.model,
    };
  }

  reset(): void {
    this.metered = this.skipped = this.estimated = this.fallback = this.rejected = 0;
    this.attributedUsd = 0;
  }

  /**
   * Default estimate: a successful route to an ephemeral agent (DREAM/VISION) spins up
   * `personasPerDispatch` personas; anything else has no persona footprint (→ ledger fallback).
   */
  private defaultEstimator(event: DispatchEvent): number | undefined {
    if (event.status === 'SUCCESS' && EPHEMERAL_SET.has(event.destination)) return this.personasPerDispatch;
    return 0;
  }
}

/** Map a destination agent to the occurrence kind it represents. */
export function kindForDestination(destination: AgentRole): OccurrenceKind {
  switch (destination) {
    case AgentRole.DREAM:
      return 'SIMULATION';
    case AgentRole.VISION:
      return 'EXECUTION';
    default:
      return 'DISPATCH';
  }
}

function round6(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}
