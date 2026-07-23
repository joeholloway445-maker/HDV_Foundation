/**
 * observability/index.ts — public surface of the Phase 5 observability layer.
 *
 * This layer is strictly out-of-band: it consumes the router's read-only `DispatchObserver`
 * seam and never routes, gates, executes, creates, or interprets. Nothing here can influence
 * a KNOLL verdict or a routing decision — it only meters and traces what already happened, so
 * the constitution's separation of concerns is preserved.
 */
import type { DispatchObserver } from '../apex/router.js';

export { MetricsCollector, LATENCY_BUCKETS_MS, DEFAULT_ACTIVE_WINDOW_MS } from './metrics.js';
export type {
  MetricsSnapshot,
  HistogramSnapshot,
  MetricsCollectorOptions,
} from './metrics.js';

export { PacketTracer, DEFAULT_TRACE_CAPACITY } from './trace.js';
export type { TraceSpan, PacketTracerOptions } from './trace.js';

export type { DispatchEvent, DispatchObserver } from '../apex/router.js';

/**
 * Fan a single dispatch event out to several observers. Handy when both metrics and tracing
 * (or more) must observe the same router, which only accepts ONE observer. Each observer is
 * isolated: one throwing never starves the others.
 */
export function combineObservers(...observers: (DispatchObserver | undefined)[]): DispatchObserver {
  const active = observers.filter((o): o is DispatchObserver => typeof o === 'function');
  return (event) => {
    for (const observe of active) {
      try {
        observe(event);
      } catch {
        // Best-effort metering: never let one sink break another (or the router).
      }
    }
  };
}
