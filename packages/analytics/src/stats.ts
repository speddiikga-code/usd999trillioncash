/**
 * Statistical primitives (no dependencies): log-gamma, regularised incomplete beta, Beta CDF /
 * quantiles, Wilson intervals, seeded samplers for Monte Carlo.
 */

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function lnGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = LANCZOS[0]!;
  for (let i = 1; i < 9; i++) x += LANCZOS[i]! / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 300;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta function I_x(a, b) = CDF of Beta(a, b) at x. */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

export function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Posterior Beta(1+s, 1+n-s) for a conversion rate under a uniform prior. */
export function conversionPosterior(successes: number, trials: number, prior: { alpha: number; beta: number } = { alpha: 1, beta: 1 }) {
  const a = prior.alpha + successes;
  const b = prior.beta + Math.max(0, trials - successes);
  return {
    alpha: a,
    beta: b,
    mean: a / (a + b),
    /** P(rate > threshold) */
    probAbove: (threshold: number) => 1 - betaCdf(threshold, a, b),
    interval: (level = 0.9) => ({ low: betaQuantile((1 - level) / 2, a, b), high: betaQuantile(1 - (1 - level) / 2, a, b) }),
  };
}

export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export type Rng = () => number;

export function sampleNormal(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) return sampleGamma(shape + 1, rng) * Math.pow(rng() || 1e-12, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(a: number, b: number, rng: Rng): number {
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  return x / (x + y);
}

/** Triangular distribution sample (low ≤ mode ≤ high). */
export function sampleTriangular(low: number, mode: number, high: number, rng: Rng): number {
  if (high <= low) return mode;
  const m = Math.min(high, Math.max(low, mode));
  const u = rng();
  const f = (m - low) / (high - low);
  return u < f ? low + Math.sqrt(u * (high - low) * (m - low)) : high - Math.sqrt((1 - u) * (high - low) * (high - m));
}

/** Sample a quantity whose uncertainty spans orders of magnitude (triangular in log space). */
export function sampleLogTriangular(low: number, mode: number, high: number, rng: Rng): number {
  const lo = Math.log(Math.max(low, 1e-9));
  const hi = Math.log(Math.max(high, low, 1e-9));
  const md = Math.log(Math.max(mode, 1e-9));
  return Math.exp(sampleTriangular(lo, Math.min(hi, Math.max(lo, md)), hi, rng));
}

export function quantiles(samples: number[], ps: number[]): number[] {
  const s = [...samples].sort((a, b) => a - b);
  return ps.map((p) => {
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
  });
}

/** Probability that each arm has the highest rate, by Monte Carlo over Beta posteriors. */
export function probabilityBest(arms: { successes: number; trials: number }[], rng: Rng, draws = 4000): number[] {
  const wins = new Array(arms.length).fill(0);
  for (let i = 0; i < draws; i++) {
    let best = -1;
    let bestVal = -Infinity;
    arms.forEach((arm, j) => {
      const v = sampleBeta(1 + arm.successes, 1 + Math.max(0, arm.trials - arm.successes), rng);
      if (v > bestVal) {
        bestVal = v;
        best = j;
      }
    });
    wins[best]++;
  }
  return wins.map((w) => w / draws);
}
