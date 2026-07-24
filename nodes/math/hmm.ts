/**
 * nodes/math/hmm.ts — a small, discrete Hidden Markov Model.
 *
 * Models persona *state transitions* across matrix coordinates: the hidden states are
 * persona states (e.g. IDLE / WORKING / DEGRADED) and the observations are discrete symbols
 * emitted as a persona walks the 64×64 grid. Two classic inference routines are provided:
 *
 *   - `forward`  : the forward algorithm — P(observations | model) with the α trellis.
 *   - `viterbi`  : the most-likely hidden state path (a compact "Viterbi lite"), in log
 *                  space to stay numerically stable over longer observation sequences.
 *
 * Pure and deterministic. Probabilities are consumed as given (rows should sum to ~1); the
 * validator only checks shape and non-negativity, not exact normalization, so callers may
 * pass mildly unnormalized rows.
 */

/** A discrete HMM: N hidden states, M observation symbols. */
export interface DiscreteHMM {
  /** Number of hidden states (N). */
  states: number;
  /** Size of the observation alphabet (M). */
  symbols: number;
  /** Initial state distribution π, length N. */
  initial: number[];
  /** State transition matrix A, N×N. `transition[i][j]` = P(state j at t+1 | state i at t). */
  transition: number[][];
  /** Emission matrix B, N×M. `emission[i][k]` = P(symbol k | state i). */
  emission: number[][];
}

export interface ForwardResult {
  /** The α trellis: `alpha[t][i]` = P(o_0..o_t, state_t = i). Length T × N. */
  alpha: number[][];
  /** Total sequence likelihood P(observations | model). */
  likelihood: number;
}

export interface ViterbiResult {
  /** Most-likely hidden state index at each time step (length T). */
  path: number[];
  /** Log-probability of that best path. */
  logProb: number;
}

/** Validate the shape of an HMM and (optionally) an observation sequence. */
export function validateHMM(hmm: DiscreteHMM, observations?: readonly number[]): void {
  const { states: n, symbols: m, initial, transition, emission } = hmm;
  if (!Number.isInteger(n) || n <= 0) throw new Error('hmm: states must be a positive integer');
  if (!Number.isInteger(m) || m <= 0) throw new Error('hmm: symbols must be a positive integer');
  if (initial.length !== n) throw new Error('hmm: initial distribution length must equal states');
  if (transition.length !== n) throw new Error('hmm: transition must have one row per state');
  if (emission.length !== n) throw new Error('hmm: emission must have one row per state');
  for (let i = 0; i < n; i++) {
    if (transition[i].length !== n) throw new Error(`hmm: transition row ${i} must have ${n} columns`);
    if (emission[i].length !== m) throw new Error(`hmm: emission row ${i} must have ${m} columns`);
  }
  for (const v of [...initial, ...transition.flat(), ...emission.flat()]) {
    if (!Number.isFinite(v) || v < 0) throw new Error('hmm: probabilities must be finite and non-negative');
  }
  if (observations) {
    for (const o of observations) {
      if (!Number.isInteger(o) || o < 0 || o >= m) {
        throw new Error(`hmm: observation ${o} is out of range [0, ${m})`);
      }
    }
  }
}

/**
 * Forward algorithm. Returns the α trellis and the sequence likelihood P(O | model).
 * Runs in plain (non-log) space — fine for the short persona sequences we model.
 */
export function forward(hmm: DiscreteHMM, observations: readonly number[]): ForwardResult {
  validateHMM(hmm, observations);
  const n = hmm.states;
  const T = observations.length;
  if (T === 0) return { alpha: [], likelihood: 1 };

  const alpha: number[][] = Array.from({ length: T }, () => new Array<number>(n).fill(0));

  const o0 = observations[0];
  for (let i = 0; i < n; i++) {
    alpha[0][i] = hmm.initial[i] * hmm.emission[i][o0];
  }

  for (let t = 1; t < T; t++) {
    const ot = observations[t];
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += alpha[t - 1][i] * hmm.transition[i][j];
      alpha[t][j] = sum * hmm.emission[j][ot];
    }
  }

  const likelihood = alpha[T - 1].reduce((a, b) => a + b, 0);
  return { alpha, likelihood };
}

/**
 * Viterbi ("lite") — the single most-likely hidden state path for the observations, decoded
 * in log space. Ties break toward the lower state index for determinism.
 */
export function viterbi(hmm: DiscreteHMM, observations: readonly number[]): ViterbiResult {
  validateHMM(hmm, observations);
  const n = hmm.states;
  const T = observations.length;
  if (T === 0) return { path: [], logProb: 0 };

  const NEG_INF = -Infinity;
  const ln = (x: number): number => (x > 0 ? Math.log(x) : NEG_INF);

  const delta: number[][] = Array.from({ length: T }, () => new Array<number>(n).fill(NEG_INF));
  const psi: number[][] = Array.from({ length: T }, () => new Array<number>(n).fill(0));

  const o0 = observations[0];
  for (let i = 0; i < n; i++) {
    delta[0][i] = ln(hmm.initial[i]) + ln(hmm.emission[i][o0]);
  }

  for (let t = 1; t < T; t++) {
    const ot = observations[t];
    for (let j = 0; j < n; j++) {
      let best = NEG_INF;
      let arg = 0;
      for (let i = 0; i < n; i++) {
        const cand = delta[t - 1][i] + ln(hmm.transition[i][j]);
        if (cand > best) {
          best = cand;
          arg = i;
        }
      }
      delta[t][j] = best + ln(hmm.emission[j][ot]);
      psi[t][j] = arg;
    }
  }

  let bestLast = NEG_INF;
  let lastState = 0;
  for (let i = 0; i < n; i++) {
    if (delta[T - 1][i] > bestLast) {
      bestLast = delta[T - 1][i];
      lastState = i;
    }
  }

  const path = new Array<number>(T).fill(0);
  path[T - 1] = lastState;
  for (let t = T - 2; t >= 0; t--) {
    path[t] = psi[t + 1][path[t + 1]];
  }

  return { path, logProb: bestLast };
}
