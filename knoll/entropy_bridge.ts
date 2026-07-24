/**
 * knoll/entropy_bridge.ts — a thin helper wiring the topology Shannon engine into a KNOLL
 * intervention signal, WITHOUT touching the sibling scorer (knoll/scoring.ts) or features.
 *
 * It imports only pure math from nodes/math (no peer-agent logic, no RoutingPacket minting).
 * KNOLL stays monitor-only: this produces a signal object describing whether the entropy of
 * observed activity spiked past a bound — a soft anomaly the six virtual laws cannot express
 * as a hard rule. Callers decide what to do with the flag; nothing here mutates a packet.
 */
import { shannonEntropy, entropySpike, type Distribution } from '../nodes/math/shannon.js';

export interface EntropySpikeSignal {
  /** Entropy (bits) of the baseline distribution. */
  prevEntropy: number;
  /** Entropy (bits) of the current distribution. */
  currEntropy: number;
  /** currEntropy − prevEntropy. */
  delta: number;
  /** The bound the delta was tested against. */
  bound: number;
  /** True when the entropy increase exceeds `bound` → KNOLL should take a look. */
  intervene: boolean;
}

/**
 * Compare two activity distributions and report whether their entropy spiked past `bound`.
 * Distributions may be raw counts/weights or probability vectors (they are normalized).
 */
export function evaluateEntropySpike(
  prev: Distribution,
  curr: Distribution,
  bound: number,
): EntropySpikeSignal {
  const prevEntropy = shannonEntropy(prev);
  const currEntropy = shannonEntropy(curr);
  return {
    prevEntropy,
    currEntropy,
    delta: currEntropy - prevEntropy,
    bound,
    intervene: entropySpike(prevEntropy, currEntropy, bound),
  };
}
