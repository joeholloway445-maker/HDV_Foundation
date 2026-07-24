/**
 * tests/math_engines.test.ts — topology math engines (node:test).
 *
 * Covers Shannon entropy + entropySpike, the discrete HMM (forward + Viterbi), and the
 * Etalon/Adaline classifiers. Also exercises the KNOLL entropy_bridge helper.
 *
 * Run: node --import tsx --test tests/math_engines.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shannonEntropy,
  normalizeDistribution,
  normalizedEntropy,
  maxEntropy,
  entropySpike,
  forward,
  viterbi,
  validateHMM,
  EtalonClassifier,
  Adaline,
  flattenGrid,
  FEATURE_DIM,
  GRID_SIZE,
  type DiscreteHMM,
} from '../nodes/math/index.js';
import { evaluateEntropySpike } from '../knoll/entropy_bridge.js';

// --- Shannon ---------------------------------------------------------------

test('shannonEntropy: uniform distribution over n outcomes = log2(n)', () => {
  assert.equal(shannonEntropy([1, 1]), 1);
  assert.equal(shannonEntropy([1, 1, 1, 1]), 2);
  assert.ok(Math.abs(shannonEntropy([5, 5, 5, 5, 5, 5, 5, 5]) - 3) < 1e-9);
});

test('shannonEntropy: point mass has zero entropy', () => {
  assert.equal(shannonEntropy([1, 0, 0, 0]), 0);
  assert.equal(shannonEntropy({ only: 42 }), 0);
});

test('shannonEntropy accepts count maps and normalizes', () => {
  const h = shannonEntropy({ a: 1, b: 1 });
  assert.equal(h, 1);
});

test('normalizeDistribution sums to 1 (or empty for all-zero)', () => {
  const p = normalizeDistribution([2, 2, 4]);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.deepEqual(normalizeDistribution([0, 0]), []);
});

test('normalizedEntropy is 1 for uniform and 0 for point mass', () => {
  assert.equal(normalizedEntropy([1, 1, 1, 1]), 1);
  assert.equal(normalizedEntropy([9, 0, 0]), 0);
  assert.equal(maxEntropy(4), 2);
});

test('shannonEntropy rejects negative weights and bad base', () => {
  assert.throws(() => shannonEntropy([-1, 2]));
  assert.throws(() => shannonEntropy([1, 1], 1));
});

test('entropySpike flags a jump beyond the bound only', () => {
  assert.equal(entropySpike(1.0, 1.4, 0.3), true);
  assert.equal(entropySpike(1.0, 1.2, 0.3), false);
  // A drop in entropy is never a spike.
  assert.equal(entropySpike(2.0, 0.5, 0.3), false);
  assert.throws(() => entropySpike(1, 2, -0.1));
});

test('evaluateEntropySpike bridges distributions into a KNOLL signal', () => {
  // Baseline: concentrated. Current: uniform (high entropy) → spike.
  const signal = evaluateEntropySpike([10, 0, 0, 0], [1, 1, 1, 1], 0.5);
  assert.equal(signal.prevEntropy, 0);
  assert.equal(signal.currEntropy, 2);
  assert.equal(signal.delta, 2);
  assert.equal(signal.intervene, true);

  const calm = evaluateEntropySpike([1, 1, 1, 1], [1, 1, 1, 1], 0.5);
  assert.equal(calm.intervene, false);
});

// --- HMM -------------------------------------------------------------------

function twoStateHmm(): DiscreteHMM {
  // Two persona states (0 = STEADY, 1 = ERRATIC) emitting two symbols (0 = calm, 1 = noisy).
  return {
    states: 2,
    symbols: 2,
    initial: [0.6, 0.4],
    transition: [
      [0.7, 0.3],
      [0.4, 0.6],
    ],
    emission: [
      [0.9, 0.1], // STEADY mostly emits calm
      [0.2, 0.8], // ERRATIC mostly emits noisy
    ],
  };
}

test('validateHMM catches shape and range errors', () => {
  const hmm = twoStateHmm();
  assert.doesNotThrow(() => validateHMM(hmm, [0, 1, 0]));
  assert.throws(() => validateHMM(hmm, [0, 2])); // symbol out of range
  assert.throws(() => validateHMM({ ...hmm, initial: [1] })); // wrong length
});

test('forward returns a likelihood consistent with the emission structure', () => {
  const hmm = twoStateHmm();
  const { alpha, likelihood } = forward(hmm, [0, 0, 1]);
  assert.equal(alpha.length, 3);
  assert.ok(likelihood > 0 && likelihood < 1);
  // Empty observation sequence → trivial likelihood 1.
  assert.equal(forward(hmm, []).likelihood, 1);
});

test('viterbi decodes the intuitively most-likely persona state path', () => {
  const hmm = twoStateHmm();
  // calm, calm, noisy → STEADY, STEADY, ERRATIC.
  const { path, logProb } = viterbi(hmm, [0, 0, 1]);
  assert.deepEqual(path, [0, 0, 1]);
  assert.ok(Number.isFinite(logProb));
  assert.deepEqual(viterbi(hmm, []).path, []);
});

// --- Etalon / Adaline ------------------------------------------------------

function grid(fill: number): number[] {
  return flattenGrid(
    Array.from({ length: GRID_SIZE }, () => new Array<number>(GRID_SIZE).fill(fill)),
  );
}

test('flattenGrid produces a 64×64 = 4096 length feature vector', () => {
  const v = grid(0.5);
  assert.equal(v.length, FEATURE_DIM);
  assert.equal(FEATURE_DIM, 4096);
});

test('EtalonClassifier assigns a query to the nearest class template', () => {
  const clf = new EtalonClassifier();
  clf.fit([
    { features: grid(0), label: 'dark' },
    { features: grid(0.05), label: 'dark' },
    { features: grid(1), label: 'bright' },
    { features: grid(0.95), label: 'bright' },
  ]);
  assert.equal(clf.predict(grid(0.1)).label, 'dark');
  assert.equal(clf.predict(grid(0.9)).label, 'bright');
  assert.deepEqual(clf.labels(), ['bright', 'dark']);
  assert.throws(() => new EtalonClassifier().predict(grid(0))); // not fitted
});

test('Adaline (LMS) learns a linearly separable ±1 split and is deterministic', () => {
  const dim = 3;
  const opts = { dim, learningRate: 0.05, epochs: 40 };
  const samples = [
    { features: [2, 1, 0], target: 1 as const },
    { features: [3, 2, 1], target: 1 as const },
    { features: [-2, -1, 0], target: -1 as const },
    { features: [-3, -2, -1], target: -1 as const },
  ];

  const a = new Adaline(opts);
  const report = a.train(samples);
  // MSE should decrease over training.
  assert.ok(report.mseByEpoch[report.mseByEpoch.length - 1] < report.mseByEpoch[0]);
  assert.equal(a.predict([2.5, 1.5, 0.5]), 1);
  assert.equal(a.predict([-2.5, -1.5, -0.5]), -1);

  // Deterministic: an identically-configured unit trains to identical parameters.
  const b = new Adaline(opts);
  b.train(samples);
  assert.deepEqual(a.parameters(), b.parameters());
});

test('Adaline rejects wrong-dimension features', () => {
  const a = new Adaline({ dim: 4 });
  assert.throws(() => a.train([{ features: [1, 2, 3], target: 1 }]));
});
