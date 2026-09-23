import { clamp, round } from '@roos/shared';

/**
 * Self-improvement from empirical outcomes. When experiments conclude (SCALE = success,
 * KILL = failure) we learn which scoring criteria actually predicted success, via L2-regularised
 * logistic regression, and blend the learned weights with the prior weights (shrinkage) so a
 * handful of outcomes cannot swing the strategy. A new weight set is only accepted if it improves
 * the Brier score on the observed outcomes.
 */
export interface Outcome {
  criteria: Record<string, number>;
  success: 0 | 1;
}

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function trainLogistic(X: number[][], y: number[], opts: { l2?: number; lr?: number; epochs?: number } = {}): { weights: number[]; bias: number } {
  const l2 = opts.l2 ?? 0.1;
  const lr = opts.lr ?? 0.5;
  const epochs = opts.epochs ?? 800;
  const d = X[0]?.length ?? 0;
  const w = new Array(d).fill(0);
  let b = 0;
  const n = X.length;
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = X[i]!.reduce((acc, x, j) => acc + x * w[j]!, b);
      const err = sigmoid(z) - y[i]!;
      for (let j = 0; j < d; j++) gw[j] += err * X[i]![j]!;
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j]! / n + l2 * w[j]!);
    b -= lr * (gb / n);
  }
  return { weights: w, bias: b };
}

export function brierScore(preds: number[], y: number[]): number {
  return preds.reduce((acc, p, i) => acc + (p - y[i]!) ** 2, 0) / Math.max(1, preds.length);
}

export interface RecalibrationResult {
  accepted: boolean;
  weights: Record<string, number>;
  metrics: { n: number; successes: number; brierPrior: number; brierNew: number; shrinkage: number };
  reason: string;
}

export function recalibrateWeights(outcomes: Outcome[], prior: Record<string, number>, opts: { minOutcomes?: number; shrinkageK?: number } = {}): RecalibrationResult {
  const keys = Object.keys(prior);
  const n = outcomes.length;
  const successes = outcomes.filter((o) => o.success === 1).length;
  const minOutcomes = opts.minOutcomes ?? 8;
  const base = { n, successes, brierPrior: NaN, brierNew: NaN, shrinkage: 0 };
  if (n < minOutcomes || successes === 0 || successes === n) {
    return { accepted: false, weights: prior, metrics: base, reason: `Need ≥ ${minOutcomes} concluded experiments with both successes and failures (have ${n}, ${successes} successes).` };
  }
  const X = outcomes.map((o) => keys.map((k) => o.criteria[k] ?? 0.5));
  const y = outcomes.map((o) => o.success);
  const model = trainLogistic(X, y);

  const positive = model.weights.map((w) => Math.max(0.005, w));
  const sumPos = positive.reduce((a, b) => a + b, 0);
  const learned = Object.fromEntries(keys.map((k, i) => [k, positive[i]! / sumPos]));
  const k = opts.shrinkageK ?? 20;
  const lambda = n / (n + k);
  const blended = Object.fromEntries(keys.map((key) => [key, (1 - lambda) * prior[key]! + lambda * learned[key]!]));
  const sumB = Object.values(blended).reduce((a, b) => a + b, 0);
  for (const key of keys) blended[key] = round(blended[key]! / sumB, 4);

  // Evaluate: calibrate a 1-D logistic on the weighted score for both weight sets, compare Brier.
  const evalWeights = (wts: Record<string, number>) => {
    const scores = X.map((row) => row.reduce((acc, x, j) => acc + x * wts[keys[j]!]!, 0));
    const m = trainLogistic(scores.map((s) => [s]), y, { l2: 0.01, epochs: 600 });
    return brierScore(scores.map((s) => sigmoid(s * m.weights[0]! + m.bias)), y);
  };
  const brierPrior = evalWeights(prior);
  const brierNew = evalWeights(blended);
  const accepted = brierNew < brierPrior - 1e-4;
  return {
    accepted,
    weights: accepted ? blended : prior,
    metrics: { n, successes, brierPrior: round(brierPrior, 4), brierNew: round(brierNew, 4), shrinkage: round(clamp(lambda, 0, 1), 3) },
    reason: accepted
      ? `Recalibrated weights improve Brier score ${round(brierPrior, 4)} → ${round(brierNew, 4)} on ${n} outcomes.`
      : `Learned weights did not improve predictive accuracy (Brier ${round(brierPrior, 4)} → ${round(brierNew, 4)}); keeping current weights.`,
  };
}
