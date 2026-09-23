import { hashSeed, round, seededRandom } from '@roos/shared';
import { quantiles, sampleBeta, sampleLogTriangular } from './stats';

/**
 * Portfolio capital allocation under uncertainty (Thompson sampling).
 *
 * Each candidate has a Beta posterior over "reaches the next milestone" (from experiment data when
 * available, otherwise a weak prior centred on the opportunity score) and a wide log-scale payoff
 * range. For each Monte-Carlo draw we sample success probability and payoff, compute expected
 * return per dollar of next-milestone cost and record which candidate wins. Budget is split in
 * proportion to win probability plus an exploration floor, subject to a concentration cap.
 * This naturally shifts money toward what the evidence says works while still exploring.
 */
export interface PortfolioCandidate {
  id: string;
  name: string;
  /** Beta posterior parameters for P(success at next milestone). */
  alpha: number;
  beta: number;
  /** Payoff if successful (e.g. 24-month gross profit), low/mode/high in USD. */
  payoffLowUsd: number;
  payoffModeUsd: number;
  payoffHighUsd: number;
  /** Cost to reach the next decision milestone. */
  costToMilestoneUsd: number;
  timeToRevenueMonths: number;
  /** 0..1 multiplicative haircut for regulatory / execution risk. */
  riskPenalty: number;
  /** 0..1 bonus for synergy with the rest of the portfolio. */
  synergy: number;
  evidenceBasis: 'experiment' | 'score_prior';
}

export interface Allocation {
  id: string;
  name: string;
  amountUsd: number;
  share: number;
  probBest: number;
  successProbMean: number;
  evMeanUsd: number;
  evLowUsd: number;
  evHighUsd: number;
  roiMedian: number;
  evidenceBasis: PortfolioCandidate['evidenceBasis'];
  rationale: string;
}

export interface AllocationResult {
  budgetUsd: number;
  allocations: Allocation[];
  unallocatedUsd: number;
  method: string;
  draws: number;
  notes: string[];
}

export function priorFromScore(score: number, strength = 4): { alpha: number; beta: number } {
  return { alpha: 1 + score * strength, beta: 1 + (1 - score) * strength };
}

export function allocateBudget(
  candidates: PortfolioCandidate[],
  opts: { budgetUsd: number; minPerOpportunityUsd?: number; maxShare?: number; explorationFloor?: number; draws?: number; seed?: string },
): AllocationResult {
  const draws = opts.draws ?? 4000;
  const maxShare = opts.maxShare ?? 0.5;
  const floor = opts.explorationFloor ?? 0.05;
  const notes: string[] = [];
  if (!candidates.length || opts.budgetUsd <= 0) {
    return { budgetUsd: opts.budgetUsd, allocations: [], unallocatedUsd: opts.budgetUsd, method: 'thompson_sampling', draws, notes: ['No candidates or zero budget.'] };
  }
  const rng = seededRandom(hashSeed(opts.seed ?? candidates.map((c) => c.id).join('|')));
  const wins = new Array(candidates.length).fill(0);
  const evSamples: number[][] = candidates.map(() => []);
  const roiSamples: number[][] = candidates.map(() => []);
  const pSamples: number[] = new Array(candidates.length).fill(0);

  for (let d = 0; d < draws; d++) {
    let best = 0;
    let bestRoi = -Infinity;
    candidates.forEach((c, i) => {
      const p = sampleBeta(c.alpha, c.beta, rng);
      const payoff = sampleLogTriangular(c.payoffLowUsd, c.payoffModeUsd, c.payoffHighUsd, rng);
      const timeDiscount = 1 / (1 + c.timeToRevenueMonths / 24);
      const ev = p * payoff * (1 - c.riskPenalty) * (1 + 0.2 * c.synergy) * timeDiscount;
      const roi = ev / Math.max(1, c.costToMilestoneUsd);
      evSamples[i]!.push(ev);
      roiSamples[i]!.push(roi);
      pSamples[i]! += p;
      if (roi > bestRoi) {
        bestRoi = roi;
        best = i;
      }
    });
    wins[best]++;
  }

  const probBest = wins.map((w) => w / draws);
  const k = candidates.length;
  let shares = probBest.map((p) => floor / k + (1 - floor) * p);

  // Cap concentration and redistribute the excess proportionally.
  for (let iter = 0; iter < 10; iter++) {
    const excess = shares.reduce((a, s) => a + Math.max(0, s - maxShare), 0);
    if (excess <= 1e-9) break;
    const under = shares.map((s) => (s < maxShare ? s : 0));
    const underTotal = under.reduce((a, b) => a + b, 0);
    shares = shares.map((s) => (s >= maxShare ? maxShare : underTotal > 0 ? s + (excess * s) / underTotal : s));
  }
  if (shares.every((s) => s >= maxShare - 1e-9) && maxShare * k < 1) notes.push(`Concentration cap ${maxShare * 100}% × ${k} candidates < 100% — part of the budget stays unallocated.`);

  const min = opts.minPerOpportunityUsd ?? 0;
  let amounts = shares.map((s) => Math.floor(s * opts.budgetUsd));
  if (min > 0) {
    amounts = amounts.map((a) => (a < min ? 0 : a));
    const dropped = amounts.filter((a) => a === 0).length;
    if (dropped) notes.push(`${dropped} candidate(s) fell below the $${min} minimum ticket and received $0.`);
  }
  const allocated = amounts.reduce((a, b) => a + b, 0);

  const allocations: Allocation[] = candidates.map((c, i) => {
    const [evLow, evMid, evHigh] = quantiles(evSamples[i]!, [0.1, 0.5, 0.9]);
    const [roiMed] = quantiles(roiSamples[i]!, [0.5]);
    const evMean = evSamples[i]!.reduce((a, b) => a + b, 0) / draws;
    const pMean = pSamples[i]! / draws;
    return {
      id: c.id,
      name: c.name,
      amountUsd: amounts[i]!,
      share: round(amounts[i]! / opts.budgetUsd, 4),
      probBest: round(probBest[i]!, 3),
      successProbMean: round(pMean, 3),
      evMeanUsd: round(evMean, 0),
      evLowUsd: round(evLow!, 0),
      evHighUsd: round(evHigh!, 0),
      roiMedian: round(roiMed!, 2),
      evidenceBasis: c.evidenceBasis,
      rationale:
        `${round(probBest[i]! * 100, 1)}% chance of best return per dollar; success probability ≈ ${round(pMean * 100, 1)}% ` +
        `(${c.evidenceBasis === 'experiment' ? 'from experiment data' : 'weak prior from opportunity score — no experiment data yet'}); ` +
        `EV 80% range $${Math.round(evLow!).toLocaleString()}–$${Math.round(evHigh!).toLocaleString()} (median $${Math.round(evMid!).toLocaleString()}).`,
    };
  });
  allocations.sort((a, b) => b.amountUsd - a.amountUsd);
  notes.push('Payoff ranges and success priors are model assumptions until replaced by observed experiment and revenue data.');
  return { budgetUsd: opts.budgetUsd, allocations, unallocatedUsd: opts.budgetUsd - allocated, method: 'thompson_sampling', draws, notes };
}
