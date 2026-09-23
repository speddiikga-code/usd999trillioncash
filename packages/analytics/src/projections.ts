import { hashSeed, round, seededRandom } from '@roos/shared';
import { quantiles, sampleTriangular } from './stats';

/**
 * Cash-flow projection with uncertainty bands (Monte Carlo over growth and churn ranges).
 * Returns P10/P50/P90 for MRR and cash per month, runway and probability of running out of cash.
 */
export interface Range {
  low: number;
  mode: number;
  high: number;
}

export interface CashFlowInput {
  currentMrrUsd: number;
  monthlyGrowth: Range;
  monthlyChurn: Range;
  grossMargin: Range;
  monthlyFixedExpensesUsd: number;
  monthlyAcquisitionSpendUsd: number;
  cashOnHandUsd: number;
  months?: number;
  draws?: number;
  seed?: string;
}

export interface CashFlowMonth {
  month: number;
  mrrP10: number;
  mrrP50: number;
  mrrP90: number;
  cashP10: number;
  cashP50: number;
  cashP90: number;
}

export function projectCashFlow(input: CashFlowInput): { months: CashFlowMonth[]; runwayMonthsP50: number | null; probCashNegative: number; assumptions: string[] } {
  const months = input.months ?? 12;
  const draws = input.draws ?? 2000;
  const rng = seededRandom(hashSeed(input.seed ?? 'cashflow'));
  const mrr: number[][] = Array.from({ length: months }, () => []);
  const cash: number[][] = Array.from({ length: months }, () => []);
  const runway: number[] = [];
  let negative = 0;

  for (let d = 0; d < draws; d++) {
    const g = sampleTriangular(input.monthlyGrowth.low, input.monthlyGrowth.mode, input.monthlyGrowth.high, rng);
    const c = sampleTriangular(input.monthlyChurn.low, input.monthlyChurn.mode, input.monthlyChurn.high, rng);
    const gm = sampleTriangular(input.grossMargin.low, input.grossMargin.mode, input.grossMargin.high, rng);
    let m = input.currentMrrUsd;
    let cashBal = input.cashOnHandUsd;
    let ranOut = -1;
    for (let t = 0; t < months; t++) {
      m = Math.max(0, m * (1 + g - c));
      cashBal += m * gm - input.monthlyFixedExpensesUsd - input.monthlyAcquisitionSpendUsd;
      mrr[t]!.push(m);
      cash[t]!.push(cashBal);
      if (cashBal < 0 && ranOut < 0) ranOut = t + 1;
    }
    if (ranOut > 0) {
      negative++;
      runway.push(ranOut);
    } else runway.push(Infinity);
  }

  const out: CashFlowMonth[] = [];
  for (let t = 0; t < months; t++) {
    const [m10, m50, m90] = quantiles(mrr[t]!, [0.1, 0.5, 0.9]);
    const [c10, c50, c90] = quantiles(cash[t]!, [0.1, 0.5, 0.9]);
    out.push({ month: t + 1, mrrP10: round(m10!), mrrP50: round(m50!), mrrP90: round(m90!), cashP10: round(c10!), cashP50: round(c50!), cashP90: round(c90!) });
  }
  const sortedRunway = [...runway].sort((a, b) => a - b);
  const med = sortedRunway[Math.floor(sortedRunway.length / 2)]!;
  return {
    months: out,
    runwayMonthsP50: Number.isFinite(med) ? med : null,
    probCashNegative: round(negative / draws, 3),
    assumptions: [
      `Monthly growth ${pctR(input.monthlyGrowth)}, churn ${pctR(input.monthlyChurn)}, gross margin ${pctR(input.grossMargin)} (triangular ranges).`,
      `Fixed expenses $${input.monthlyFixedExpensesUsd}/mo, acquisition spend $${input.monthlyAcquisitionSpendUsd}/mo, starting cash $${input.cashOnHandUsd}.`,
    ],
  };
}

const pctR = (r: Range) => `${round(r.low * 100, 1)}–${round(r.high * 100, 1)}% (mode ${round(r.mode * 100, 1)}%)`;
