import { describe, expect, it } from 'vitest';
import { seededRandom } from '@roos/shared';
import { betaCdf, betaQuantile, conversionPosterior, lnGamma, probabilityBest, quantiles, sampleBeta, wilsonInterval } from '../src/stats';
import { requiredSampleSize } from '../src/experiments';

describe('special functions', () => {
  it('lnGamma matches known factorials', () => {
    expect(lnGamma(5)).toBeCloseTo(Math.log(24), 8);
    expect(lnGamma(10)).toBeCloseTo(Math.log(362880), 8);
    expect(lnGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 8);
  });

  it('betaCdf matches closed forms', () => {
    // Beta(2,3) CDF = 6x² − 8x³ + 3x⁴
    for (const x of [0.1, 0.25, 0.5, 0.8]) expect(betaCdf(x, 2, 3)).toBeCloseTo(6 * x ** 2 - 8 * x ** 3 + 3 * x ** 4, 10);
    expect(betaCdf(0.3, 1, 1)).toBeCloseTo(0.3, 12);
    expect(betaCdf(0, 5, 5)).toBe(0);
    expect(betaCdf(1, 5, 5)).toBe(1);
  });

  it('betaQuantile inverts betaCdf', () => {
    const q = betaQuantile(0.9, 12, 88);
    expect(betaCdf(q, 12, 88)).toBeCloseTo(0.9, 6);
  });
});

describe('intervals and posteriors', () => {
  it('computes the Wilson interval', () => {
    const w = wilsonInterval(0, 10);
    expect(w.low).toBe(0);
    expect(w.high).toBeCloseTo(0.2775, 3);
    const w2 = wilsonInterval(50, 100);
    expect(w2.low).toBeCloseTo(0.4038, 3);
    expect(w2.high).toBeCloseTo(0.5962, 3);
  });

  it('posterior mean and tail probability behave sensibly', () => {
    const p = conversionPosterior(30, 300);
    expect(p.mean).toBeCloseTo(31 / 302, 10);
    expect(p.probAbove(0.05)).toBeGreaterThan(0.99);
    expect(p.probAbove(0.2)).toBeLessThan(0.001);
    const ci = p.interval(0.9);
    expect(ci.low).toBeLessThan(0.1);
    expect(ci.high).toBeGreaterThan(0.1);
  });

  it('Beta sampler has the right mean (seeded, reproducible)', () => {
    const rng = seededRandom(42);
    const xs = Array.from({ length: 20000 }, () => sampleBeta(3, 7, rng));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean).toBeCloseTo(0.3, 2);
    const [p50] = quantiles(xs, [0.5]);
    expect(p50).toBeGreaterThan(0.25);
    expect(p50).toBeLessThan(0.32);
  });

  it('probabilityBest favours the clearly better arm', () => {
    const pb = probabilityBest([{ successes: 10, trials: 200 }, { successes: 30, trials: 200 }], seededRandom(7));
    expect(pb[1]).toBeGreaterThan(0.99);
    expect(pb[0]! + pb[1]!).toBeCloseTo(1, 10);
  });

  it('required sample size is in the textbook range for 5% → 6%', () => {
    const n = requiredSampleSize(0.05, 0.2);
    expect(n).toBeGreaterThan(7000);
    expect(n).toBeLessThan(9500);
  });
});
