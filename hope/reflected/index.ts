/**
 * hope/reflected/index.ts — public surface of the Reflected Hopes subsystem.
 * Per-user, isolated mirror containers that can never write into Core/Prime Hope.
 */
export {
  ReflectedHope,
  ReflectedHopeRegistry,
  CoreHopeStore,
} from './reflected_hope.js';
export type {
  ReflectedObservation,
  RecordOptions,
  ReflectedHopeOptions,
  ReflectedHopeRegistryOptions,
} from './reflected_hope.js';

export {
  reflectedId,
  containerPath,
  isReflectedPath,
  isCoreOrPrimePath,
  assertIsolation,
  CORE_HOPE_ROOT,
  PRIME_HOPE_ROOT,
  REFLECTED_ROOT,
} from './segmentation.js';

export { OptInConsent, DEFAULT_OPT_IN } from './privacy.js';
export type { ConsentState, OptInConsentOptions } from './privacy.js';

export { TacticalIntelException } from './intel_exception.js';
export type {
  IntelPurpose,
  IntelExceptionEntry,
  TacticalIntelExceptionOptions,
  ManipulationContext,
} from './intel_exception.js';
