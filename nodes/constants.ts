/**
 * nodes/constants.ts — the invariant matrix math.
 *
 * Under each of the 5 Big AI: 64 managers x 64 nodes = 4,096 nodes.
 * Across the Big 5: 20,480 nodes. Each node hosts 100 ephemeral personas, each tied to a
 * conceptual 7B model -> ~14.3 quadrillion parameters.
 */
export const MANAGERS_PER_AGENT = 64;
export const NODES_PER_MANAGER = 64;
export const NODES_PER_AGENT = MANAGERS_PER_AGENT * NODES_PER_MANAGER; // 4096
export const BIG_FIVE_COUNT = 5;
export const TOTAL_NODES = NODES_PER_AGENT * BIG_FIVE_COUNT; // 20480
export const PERSONAS_PER_NODE = 100;
export const MODEL_SIZE = '7B' as const;
export const MODEL_PARAMS = 7_000_000_000;

/** Conceptual total parameters across the whole fleet: ~1.4336e16 (~14.3 quadrillion). */
export const TOTAL_CONCEPTUAL_PARAMETERS = TOTAL_NODES * PERSONAS_PER_NODE * MODEL_PARAMS;

// Compile-time-ish sanity checks (throw at import if the math is ever broken).
if (NODES_PER_AGENT !== 4096) throw new Error('matrix invariant broken: NODES_PER_AGENT !== 4096');
if (TOTAL_NODES !== 20480) throw new Error('matrix invariant broken: TOTAL_NODES !== 20480');
