import type { DecisionResult, ExperimentDecision, ExperimentThresholds } from '@roos/shared';
import { hashSeed, round, seededRandom } from '@roos/shared';
import { conversionPosterior, probabilityBest } from './stats';

/**
 * Experiment decision engine. Decisions are made from Bayesian posteriors against thresholds that
 * are fixed BEFORE the experiment starts (no moving goalposts), with minimum sample sizes and
 * guardrails. Every decision carries its numbers and reasons.
 *
 *   SCALE    – P(rate > target) ≥ scaleProbability with enough data, and unit economics (if known) OK
 *   KILL     – confidently below killFraction × target, or time/budget exhausted with weak signal
 *   ITERATE  – demand signal is real but ambiguous, or demand OK but economics fail
 *   PAUSE    – guardrail breached (complaints, CAC) or not enough traffic within limits → human review
 *   CONTINUE – not enough evidence yet; keep collecting data
 */
export const DEFAULT_THRESHOLDS: ExperimentThresholds = {
  targetRate: 0.05,
  minSample: 200,
  scaleProbability: 0.9,
  killProbability: 0.05,
  killFraction: 0.5,
  maxDays: 30,
  maxBudgetUsd: 500,
  minLtvToCac: 3,
  maxComplaintRate: 0.01,
};

export interface ExperimentEvalInput {
  experimentId?: string;
  thresholds: Partial<ExperimentThresholds>;
  numerator: number;
  denominator: number;
  variants?: { variant: string; numerator: number; denominator: number }[];
  startedAt: string | Date | null;
  now?: Date;
  spentUsd: number;
  budgetUsd: number;
  customersAcquired?: number;
  ltvUsd?: number | null;
  complaints?: number;
}

export function evaluateExperiment(input: ExperimentEvalInput): DecisionResult {
  const th: ExperimentThresholds = { ...DEFAULT_THRESHOLDS, ...stripUndefined(input.thresholds) };
  const now = input.now ?? new Date();
  const n = Math.max(0, input.denominator);
  const s = Math.min(Math.max(0, input.numerator), n);
  const post = conversionPosterior(s, n);
  const interval = post.interval(0.9);
  const probAboveTarget = post.probAbove(th.targetRate);
  const killLine = th.targetRate * th.killFraction;
  const probAboveKillLine = post.probAbove(killLine);
  const daysRunning = input.startedAt ? Math.max(0, (now.getTime() - new Date(input.startedAt).getTime()) / 86_400_000) : 0;
  const budget = input.budgetUsd > 0 ? input.budgetUsd : th.maxBudgetUsd;
  const budgetExhausted = budget > 0 && input.spentUsd >= budget;
  const timeExhausted = daysRunning >= th.maxDays;
  const customers = input.customersAcquired ?? 0;
  const cacUsd = customers > 0 ? input.spentUsd / customers : input.spentUsd > 0 ? null : null;
  const ltvToCac = input.ltvUsd && cacUsd && cacUsd > 0 ? input.ltvUsd / cacUsd : null;
  const complaintRate = n > 0 ? (input.complaints ?? 0) / n : 0;
  const rate = n > 0 ? s / n : 0;
  const pct = (x: number) => `${round(x * 100, 2)}%`;

  const reasons: string[] = [];
  let decision: ExperimentDecision;

  const variants =
    input.variants && input.variants.length > 1
      ? (() => {
          const rng = seededRandom(hashSeed(input.experimentId ?? 'exp'));
          const pb = probabilityBest(
            input.variants.map((v) => ({ successes: v.numerator, trials: v.denominator })),
            rng,
          );
          return input.variants.map((v, i) => ({
            variant: v.variant,
            numerator: v.numerator,
            denominator: v.denominator,
            rate: v.denominator > 0 ? round(v.numerator / v.denominator, 4) : 0,
            probBest: round(pb[i]!, 3),
          }));
        })()
      : undefined;

  // 1. Guardrails first.
  if (th.maxComplaintRate !== undefined && n >= 20 && complaintRate > th.maxComplaintRate) {
    decision = 'PAUSE';
    reasons.push(`Complaint/unsubscribe rate ${pct(complaintRate)} exceeds guardrail ${pct(th.maxComplaintRate)} — pausing for human review.`);
  } else if (th.maxCacUsd !== undefined && customers >= 3 && cacUsd !== null && cacUsd > th.maxCacUsd) {
    decision = 'PAUSE';
    reasons.push(`CAC $${round(cacUsd)} exceeds guardrail $${th.maxCacUsd} after ${customers} customers.`);
  } else if (n < th.minSample) {
    // 2. Not enough data for a demand decision.
    if (n >= th.minSample / 2 && probAboveKillLine < th.killProbability / 2) {
      decision = 'KILL';
      reasons.push(
        `Early futility stop: with ${n} observations, P(rate > ${pct(killLine)}) is only ${pct(probAboveKillLine)} (< ${pct(th.killProbability / 2)}).`,
      );
    } else if (timeExhausted || budgetExhausted) {
      decision = 'PAUSE';
      reasons.push(
        `Only ${n}/${th.minSample} required observations after ${round(daysRunning, 1)} days and $${round(input.spentUsd)} spent — ` +
          `distribution failed to deliver traffic. Demand is untested, not disproven. Human review needed.`,
      );
    } else {
      decision = 'CONTINUE';
      reasons.push(`Collecting data: ${n}/${th.minSample} observations (minimum sample not reached).`);
    }
  } else if (probAboveTarget >= th.scaleProbability) {
    // 3. Enough data.
    if (th.minLtvToCac !== undefined && ltvToCac !== null && ltvToCac < th.minLtvToCac) {
      decision = 'ITERATE';
      reasons.push(`Demand validated (P(rate > ${pct(th.targetRate)}) = ${pct(probAboveTarget)}) but LTV/CAC ${round(ltvToCac, 2)} < ${th.minLtvToCac}. Fix pricing or acquisition cost.`);
    } else {
      decision = 'SCALE';
      reasons.push(`P(rate > ${pct(th.targetRate)}) = ${pct(probAboveTarget)} ≥ ${pct(th.scaleProbability)} with ${n} observations.`);
      if (ltvToCac === null) reasons.push('Unit economics not yet measured — scale cautiously and verify LTV/CAC with paying customers.');
    }
  } else if (probAboveKillLine < th.killProbability) {
    decision = 'KILL';
    reasons.push(`Confidently below ${pct(killLine)} (${th.killFraction}× target): P(rate > ${pct(killLine)}) = ${pct(probAboveKillLine)} < ${pct(th.killProbability)}.`);
  } else if (timeExhausted || budgetExhausted) {
    decision = rate >= killLine ? 'ITERATE' : 'KILL';
    reasons.push(
      `${timeExhausted ? `Time limit (${th.maxDays}d)` : `Budget ($${budget})`} reached with an inconclusive result: rate ${pct(rate)} ` +
        `(90% CI ${pct(interval.low)}–${pct(interval.high)}), target ${pct(th.targetRate)}.`,
    );
    reasons.push(decision === 'ITERATE' ? 'Signal above the kill line — change one variable (message, price, channel) and re-test.' : 'Signal below the kill line — stop investing.');
  } else if (n >= th.minSample * 3) {
    decision = 'ITERATE';
    reasons.push(`Large sample (${n}) but still ambiguous: rate ${pct(rate)}, P(rate > target) = ${pct(probAboveTarget)}. Iterate on the offer.`);
  } else {
    decision = 'CONTINUE';
    reasons.push(`Inconclusive so far: rate ${pct(rate)} (90% CI ${pct(interval.low)}–${pct(interval.high)}); P(rate > target) = ${pct(probAboveTarget)}.`);
  }

  if (variants) {
    const leader = [...variants].sort((a, b) => b.probBest - a.probBest)[0]!;
    reasons.push(`Variant "${leader.variant}" has ${pct(leader.probBest)} probability of being best.`);
  }

  return {
    decision,
    reasons,
    stats: {
      numerator: s,
      denominator: n,
      rate: round(rate, 4),
      rateLow: round(interval.low, 4),
      rateHigh: round(interval.high, 4),
      probAboveTarget: round(probAboveTarget, 4),
      probAboveKillLine: round(probAboveKillLine, 4),
      daysRunning: round(daysRunning, 2),
      spentUsd: round(input.spentUsd, 2),
      cacUsd: cacUsd === null ? null : round(cacUsd, 2),
      ltvToCac: ltvToCac === null ? null : round(ltvToCac, 2),
      complaintRate: round(complaintRate, 4),
      variants,
    },
    evaluatedAt: now.toISOString(),
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Sample size needed to detect `rate` vs `baseline` (two-sided, normal approximation). */
export function requiredSampleSize(baseline: number, minDetectableLift: number, alpha = 0.05, power = 0.8): number {
  const zA = alpha === 0.05 ? 1.96 : 2.576;
  const zB = power === 0.8 ? 0.8416 : 1.2816;
  const p1 = baseline;
  const p2 = baseline * (1 + minDetectableLift);
  const pBar = (p1 + p2) / 2;
  const n = Math.pow(zA * Math.sqrt(2 * pBar * (1 - pBar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2)), 2) / Math.pow(p2 - p1, 2);
  return Math.ceil(n);
}
