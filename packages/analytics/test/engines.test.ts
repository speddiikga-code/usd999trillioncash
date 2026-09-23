import { describe, expect, it } from 'vitest';
import type { OpportunitySignals } from '@roos/shared';
import { assumption, estimated } from '@roos/shared';
import { evaluateExperiment } from '../src/experiments';
import { buildCriteria, DEFAULT_WEIGHTS, scoreOpportunity } from '../src/scoring';
import { allocateBudget, priorFromScore, type PortfolioCandidate } from '../src/portfolio';
import { computeRoadmap, requiredCagr } from '../src/roadmap';
import { computeRevenueMetrics, pipelineValue } from '../src/saas';
import { computeUnitEconomics } from '../src/economics';
import { projectCashFlow } from '../src/projections';
import { recalibrateWeights } from '../src/learning';
import { scoreLead } from '../src/leads';

const now = new Date('2026-09-01T00:00:00Z');
const started = new Date('2026-08-20T00:00:00Z');

describe('experiment decision engine', () => {
  const base = { thresholds: { targetRate: 0.05, minSample: 200 }, startedAt: started, now, spentUsd: 0, budgetUsd: 500 };

  it('CONTINUEs until the minimum sample is reached', () => {
    const r = evaluateExperiment({ ...base, numerator: 5, denominator: 50 });
    expect(r.decision).toBe('CONTINUE');
    expect(r.reasons[0]).toMatch(/50\/200/);
  });

  it('SCALEs when the posterior clearly exceeds target', () => {
    const r = evaluateExperiment({ ...base, numerator: 40, denominator: 400 });
    expect(r.decision).toBe('SCALE');
    expect(r.stats.probAboveTarget).toBeGreaterThan(0.99);
    expect(r.stats.rateLow).toBeLessThan(0.1);
    expect(r.stats.rateHigh).toBeGreaterThan(0.1);
  });

  it('KILLs when confidently below the kill line', () => {
    const r = evaluateExperiment({ ...base, numerator: 1, denominator: 400 });
    expect(r.decision).toBe('KILL');
  });

  it('ITERATEs when demand is validated but LTV/CAC fails', () => {
    const r = evaluateExperiment({ ...base, numerator: 40, denominator: 400, spentUsd: 500, customersAcquired: 5, ltvUsd: 100 });
    expect(r.decision).toBe('ITERATE');
    expect(r.stats.ltvToCac).toBe(1);
  });

  it('PAUSEs on complaint guardrail breach', () => {
    const r = evaluateExperiment({ ...base, numerator: 20, denominator: 300, complaints: 10 });
    expect(r.decision).toBe('PAUSE');
  });

  it('PAUSEs (not KILL) when traffic never arrived within the time limit', () => {
    const r = evaluateExperiment({ ...base, thresholds: { ...base.thresholds, maxDays: 5 }, numerator: 2, denominator: 30 });
    expect(r.decision).toBe('PAUSE');
    expect(r.reasons.join(' ')).toMatch(/untested, not disproven/);
  });

  it('reports variant probabilities', () => {
    const r = evaluateExperiment({
      ...base,
      experimentId: 'exp_test',
      numerator: 50,
      denominator: 600,
      variants: [
        { variant: 'a', numerator: 10, denominator: 300 },
        { variant: 'b', numerator: 40, denominator: 300 },
      ],
    });
    const b = r.stats.variants!.find((v) => v.variant === 'b')!;
    expect(b.probBest).toBeGreaterThan(0.99);
  });
});

const signals = (docs: number, eng: number, pain: number, wtp: number): OpportunitySignals => ({
  documentCount: docs,
  distinctSources: Math.min(4, docs),
  totalEngagement: eng,
  painScore: pain,
  willingnessToPayMentions: wtp,
  competitorMentions: 1,
  newestEvidenceAt: '2026-08-25T00:00:00Z',
  keywords: ['invoice', 'reconciliation'],
});

describe('opportunity scoring', () => {
  it('produces a score within its uncertainty interval, with normalised weights', () => {
    const criteria = buildCriteria({ signals: signals(12, 800, 0.6, 3), now, isB2B: true });
    const s = scoreOpportunity(criteria, { seed: 'x' });
    expect(s.score).toBeGreaterThan(0);
    expect(s.score).toBeLessThan(1);
    expect(s.low).toBeLessThanOrEqual(s.score + 1e-9);
    expect(s.high).toBeGreaterThanOrEqual(s.score - 1e-9);
    expect(s.criteria.reduce((a, c) => a + c.weight, 0)).toBeCloseTo(1, 3);
    expect(s.criteria).toHaveLength(Object.keys(DEFAULT_WEIGHTS).length);
  });

  it('marks unassessed criteria as MODEL_ASSUMPTION and rewards stronger evidence', () => {
    const weak = scoreOpportunity(buildCriteria({ signals: signals(1, 2, 0.1, 0), now }), { seed: 'w' });
    const strong = scoreOpportunity(buildCriteria({ signals: signals(25, 5000, 0.8, 8), now, isB2B: true }), { seed: 's' });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(weak.criteria.find((c) => c.key === 'market_size')!.kind).toBe('MODEL_ASSUMPTION');
    expect(strong.criteria.find((c) => c.key === 'demand_evidence')!.kind).toBe('OBSERVED');
  });

  it('is deterministic for a given seed', () => {
    const c = buildCriteria({ signals: signals(5, 100, 0.5, 1), now });
    expect(scoreOpportunity(c, { seed: 'a' })).toMatchObject({ low: scoreOpportunity(c, { seed: 'a' }).low });
  });

  it('labels demo criteria as DEMO', () => {
    const c = buildCriteria({ signals: signals(5, 100, 0.5, 1), now, demo: true });
    expect(c.every((x) => x.kind === 'DEMO')).toBe(true);
  });
});

describe('portfolio allocation', () => {
  const cand = (id: string, a: number, b: number, payoff: number): PortfolioCandidate => ({
    id,
    name: id,
    alpha: a,
    beta: b,
    payoffLowUsd: payoff / 10,
    payoffModeUsd: payoff,
    payoffHighUsd: payoff * 5,
    costToMilestoneUsd: 1000,
    timeToRevenueMonths: 3,
    riskPenalty: 0.1,
    synergy: 0,
    evidenceBasis: 'experiment',
  });

  it('allocates more to the stronger candidate, respects caps and budget, and keeps exploring', () => {
    const r = allocateBudget([cand('strong', 30, 70, 100_000), cand('weak', 3, 97, 100_000), cand('mid', 10, 90, 100_000)], { budgetUsd: 10_000, maxShare: 0.6, explorationFloor: 0.1, seed: 't' });
    const byId = Object.fromEntries(r.allocations.map((a) => [a.id, a]));
    expect(byId.strong!.amountUsd).toBeGreaterThan(byId.mid!.amountUsd);
    expect(byId.mid!.amountUsd).toBeGreaterThanOrEqual(byId.weak!.amountUsd);
    expect(byId.weak!.amountUsd).toBeGreaterThan(0);
    for (const a of r.allocations) expect(a.share).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(r.allocations.reduce((s, a) => s + a.amountUsd, 0) + r.unallocatedUsd).toBeCloseTo(10_000, 6);
    expect(byId.strong!.evLowUsd).toBeLessThanOrEqual(byId.strong!.evHighUsd);
  });

  it('builds weak priors from scores', () => {
    const p = priorFromScore(0.75);
    expect(p.alpha / (p.alpha + p.beta)).toBeCloseTo(4 / 6, 5);
  });
});

describe('quadrillion roadmap', () => {
  it('solves the required CAGR exactly', () => {
    const g = requiredCagr(12_000, 9.999e15, 30)!;
    let arr = 12_000;
    let cum = 0;
    for (let t = 0; t < 30; t++) {
      arr *= 1 + g;
      cum += arr;
    }
    expect(cum / 9.999e15).toBeCloseTo(1, 6);
  });

  it('flags hypothetical starting points and never reports progress without verified revenue', () => {
    const r = computeRoadmap({}, { verifiedArrUsd: 0, verifiedCumulativeRevenueUsd: 0, observedMonthlyGrowth: null, monthsOfData: 0 });
    expect(r.current.startingArrIsHypothetical).toBe(true);
    expect(r.current.progressFraction).toBe(0);
    expect(r.milestones.every((m) => !m.reached)).toBe(true);
    expect(r.required.finalArrToWorldGdp!).toBeGreaterThan(1);
    expect(r.feasibility[0]).toMatch(/HYPOTHETICAL/);
    expect(r.scenarios.map((s) => s.name)).toContain('Base');
  });

  it('uses verified ARR and marks reached milestones', () => {
    const r = computeRoadmap({ horizonYears: 20 }, { verifiedArrUsd: 150_000, verifiedCumulativeRevenueUsd: 90_000, observedMonthlyGrowth: 0.05, monthsOfData: 6 });
    expect(r.current.startingArrIsHypothetical).toBe(false);
    expect(r.milestones.find((m) => m.label === '$10k MRR')!.reached).toBe(true);
    expect(r.milestones.find((m) => m.label === '$100k MRR')!.reached).toBe(false);
    expect(r.current.observedAnnualGrowth).toBeCloseTo(Math.pow(1.05, 12) - 1, 4);
    expect(r.observedGrowthProjection).not.toBeNull();
  });
});

describe('revenue metrics', () => {
  it('computes MRR, churn, LTV and CAC from the ledger', () => {
    const d = (s: string) => new Date(s).toISOString();
    const events = [
      { type: 'subscription_started' as const, amountUsd: 0, mrrDeltaUsd: 100, occurredAt: d('2026-06-01'), customerId: 'c1', verified: true },
      { type: 'subscription_started' as const, amountUsd: 0, mrrDeltaUsd: 100, occurredAt: d('2026-07-01'), customerId: 'c2', verified: true },
      { type: 'subscription_started' as const, amountUsd: 0, mrrDeltaUsd: 100, occurredAt: d('2026-08-10'), customerId: 'c3', verified: false },
      { type: 'subscription_canceled' as const, amountUsd: 0, mrrDeltaUsd: -100, occurredAt: d('2026-08-15'), customerId: 'c1', verified: true },
      { type: 'charge' as const, amountUsd: 100, mrrDeltaUsd: 0, occurredAt: d('2026-08-01'), customerId: 'c2', verified: true },
      { type: 'charge' as const, amountUsd: 100, mrrDeltaUsd: 0, occurredAt: d('2026-08-10'), customerId: 'c3', verified: false },
    ];
    const customers = [
      { id: 'c1', status: 'churned' as const, startedAt: d('2026-06-01'), churnedAt: d('2026-08-15'), mrrUsd: 0 },
      { id: 'c2', status: 'active' as const, startedAt: d('2026-07-01'), mrrUsd: 100 },
      { id: 'c3', status: 'active' as const, startedAt: d('2026-08-10'), mrrUsd: 100 },
    ];
    const expenses = [
      { category: 'ads', amountUsd: 300, occurredAt: d('2026-08-05') },
      { category: 'infrastructure', amountUsd: 20, occurredAt: d('2026-08-05') },
    ];
    const all = computeRevenueMetrics({ events, customers, expenses, now });
    expect(all.mrr).toBe(200);
    expect(all.arr).toBe(2400);
    expect(all.revenueTotal).toBe(200);
    expect(all.grossMargin).toBeCloseTo(0.9, 5);
    expect(all.activeCustomers).toBe(2);
    expect(all.customerChurnRate).toBeCloseTo(0.5, 5); // 1 of 2 active at start of window churned
    expect(all.cac).toBeCloseTo(300 / 2, 5); // c1 started 92 days ago → outside the 90-day window
    expect(all.ltv).toBeCloseTo((100 * 0.9) / 0.5, 5);

    const verified = computeRevenueMetrics({ events, customers, expenses, now, verifiedOnly: true });
    expect(verified.mrr).toBe(100);
    expect(verified.revenueTotal).toBe(100);
  });

  it('computes weighted pipeline value', () => {
    const p = pipelineValue([
      { status: 'demo', expectedValueUsd: 1000 },
      { status: 'new', expectedValueUsd: 1000 },
    ]);
    expect(p.total).toBe(2000);
    expect(p.weighted).toBeCloseTo(370, 5);
  });
});

describe('unit economics, projections, learning, leads', () => {
  it('propagates ranges into LTV/CAC', () => {
    const ue = computeUnitEconomics({
      price: assumption(50, 30, 80, 'price'),
      cac: estimated(150, 80, 300, 'cac'),
      grossMargin: assumption(0.8, 0.7, 0.9, 'gm'),
      monthlyChurn: assumption(0.04, 0.02, 0.08, 'churn'),
    });
    expect(ue.ltv.value).toBeCloseTo((50 * 0.8) / 0.04, 5);
    expect(ue.ltv.low!).toBeLessThan(ue.ltv.value);
    expect(ue.ltv.high!).toBeGreaterThan(ue.ltv.value);
    expect(ue.ltv.kind).toBe('MODEL_ASSUMPTION');
    expect(ue.ltvToCac.value).toBeCloseTo(1000 / 150, 2);
  });

  it('projects cash flow with ordered percentiles', () => {
    const r = projectCashFlow({
      currentMrrUsd: 1000,
      monthlyGrowth: { low: 0, mode: 0.05, high: 0.15 },
      monthlyChurn: { low: 0.02, mode: 0.04, high: 0.08 },
      grossMargin: { low: 0.7, mode: 0.8, high: 0.9 },
      monthlyFixedExpensesUsd: 500,
      monthlyAcquisitionSpendUsd: 500,
      cashOnHandUsd: 2000,
      seed: 't',
    });
    expect(r.months).toHaveLength(12);
    for (const m of r.months) {
      expect(m.mrrP10).toBeLessThanOrEqual(m.mrrP50);
      expect(m.mrrP50).toBeLessThanOrEqual(m.mrrP90);
    }
    expect(r.probCashNegative).toBeGreaterThanOrEqual(0);
  });

  it('learns that a predictive criterion matters and only accepts improvements', () => {
    const prior = { a: 0.5, b: 0.5 };
    const outcomes = Array.from({ length: 40 }, (_, i) => {
      const a = (i % 10) / 10;
      const b = ((i * 7) % 10) / 10;
      return { criteria: { a, b }, success: (a > 0.5 ? 1 : 0) as 0 | 1 };
    });
    const r = recalibrateWeights(outcomes, prior);
    expect(r.accepted).toBe(true);
    expect(r.weights.a!).toBeGreaterThan(r.weights.b!);
    const tooFew = recalibrateWeights(outcomes.slice(0, 3), prior);
    expect(tooFew.accepted).toBe(false);
  });

  it('scores leads transparently and never marks unknown consent as contactable', () => {
    const hot = scoreLead({ title: 'Founder', company: 'Acme Dental', email: 'a@acme.com', consentBasis: 'inbound', icpKeywords: ['dental'], events: { signup: 1, page_view: 3 }, b2b: true });
    expect(hot.score).toBeGreaterThan(60);
    expect(hot.contactable).toBe(true);
    const cold = scoreLead({ title: 'Founder', email: 'x@gmail.com', consentBasis: 'unknown', b2b: true });
    expect(cold.contactable).toBe(false);
  });
});
