import { allocateBudget, computeRoadmap, DEFAULT_ROADMAP_ASSUMPTIONS, priorFromScore, type PortfolioCandidate, type RoadmapAssumptions } from '@roos/analytics';
import type { Db } from '@roos/database';
import { clamp, round, type DecisionResult, type EstimatedValue, type ScoreBreakdown } from '@roos/shared';
import type { LeadService } from './leads';
import type { OrgService } from './orgs';
import type { RevenueService } from './revenue';

/** Portfolio KPIs, capital allocation and the Quadrillion Roadmap. */
export class PortfolioService {
  constructor(
    private db: Db,
    private orgs: OrgService,
    private revenue: RevenueService,
    private leads: LeadService,
  ) {}

  async kpis(orgId: string) {
    const org = await this.orgs.get(orgId);
    const c = await this.db.one<Record<string, number>>(
      `SELECT
        (SELECT COUNT(*) FROM opportunities WHERE org_id = $1 AND status <> 'archived')::int AS total_opportunities,
        (SELECT COUNT(*) FROM opportunities WHERE org_id = $1 AND status IN ('validated','built','launched','experimenting','scaling'))::int AS validated_opportunities,
        (SELECT COUNT(*) FROM experiments WHERE org_id = $1 AND status = 'running')::int AS active_experiments,
        (SELECT COUNT(*) FROM experiments WHERE org_id = $1 AND decision IN ('SCALE','KILL','ITERATE') AND status IN ('completed','killed'))::int AS decided_experiments,
        (SELECT COUNT(*) FROM experiments WHERE org_id = $1 AND decision = 'SCALE')::int AS winning_experiments,
        (SELECT COUNT(*) FROM products WHERE org_id = $1 AND status IN ('preview','live'))::int AS products_launched,
        (SELECT COUNT(DISTINCT anonymous_id) FROM tracking_events WHERE org_id = $1 AND NOT is_bot AND occurred_at > now() - interval '30 days')::int AS users_30d,
        (SELECT COUNT(*) FROM leads WHERE org_id = $1)::int AS leads,
        (SELECT COUNT(*) FROM agent_tasks WHERE org_id = $1 AND created_at > now() - interval '30 days' AND status IN ('succeeded','failed','timed_out','cancelled','waiting_approval'))::int AS tasks_30d,
        (SELECT COUNT(*) FROM agent_tasks WHERE org_id = $1 AND created_at > now() - interval '30 days' AND status = 'succeeded' AND approval_id IS NULL)::int AS autonomous_tasks_30d,
        (SELECT COUNT(*) FROM approvals WHERE org_id = $1 AND status = 'pending')::int AS pending_approvals`,
      [orgId],
    );
    const rev = await this.revenue.summary(orgId);
    const pipeline = await this.leads.pipeline(orgId);
    const primary = org.isDemo ? rev.reported : rev.verified;
    const portfolioValue = await this.portfolioValue(orgId);
    return {
      isDemo: org.isDemo,
      dataKind: org.isDemo ? 'DEMO' : 'OBSERVED',
      totalOpportunities: c!.total_opportunities,
      validatedOpportunities: c!.validated_opportunities,
      activeExperiments: c!.active_experiments,
      productsLaunched: c!.products_launched,
      users30d: c!.users_30d,
      customers: primary.activeCustomers,
      leads: c!.leads,
      mrr: primary.mrr,
      arr: primary.arr,
      verifiedMrr: rev.verified.mrr,
      reportedMrr: rev.reported.mrr,
      grossMargin: primary.grossMargin,
      cac: primary.cac,
      ltv: primary.ltv,
      ltvAssumedLifetime: primary.ltvAssumedLifetime,
      cashBurn30d: primary.burnLast30,
      pipelineWeighted: pipeline.weighted,
      pipelineTotal: pipeline.total,
      experimentWinRate: c!.decided_experiments ? round(c!.winning_experiments / c!.decided_experiments, 3) : null,
      experimentsDecided: c!.decided_experiments,
      portfolioValue,
      automationRate: c!.tasks_30d ? round(c!.autonomous_tasks_30d / c!.tasks_30d, 3) : null,
      pendingApprovals: c!.pending_approvals,
      revenueSeries: primary.series,
      notes: [
        org.isDemo ? 'DEMO DATA — synthetic, for demonstration only.' : 'MRR/ARR/customers use VERIFIED revenue only (payment-provider data).',
        'Portfolio value is a MODEL ESTIMATE (success probability × payoff range) — not an appraisal.',
        'Automation rate = agent tasks completed without a human approval step ÷ all finished agent tasks (30 days).',
      ],
    };
  }

  /** Candidates for capital allocation, built from opportunity scores and experiment evidence. */
  async candidates(orgId: string): Promise<PortfolioCandidate[]> {
    const rows = await this.db.many<{
      id: string;
      title: string;
      score: number | null;
      score_breakdown: ScoreBreakdown | null;
      estimated_market_size: EstimatedValue | null;
      gross_margin_estimate: EstimatedValue | null;
      time_to_mvp: EstimatedValue | null;
      regulatory_risk: EstimatedValue | null;
      decision_rationale: DecisionResult | null;
      budget_usd: number | null;
      spent_usd: number | null;
    }>(
      `SELECT o.id, o.title, o.score, o.score_breakdown, o.estimated_market_size, o.gross_margin_estimate, o.time_to_mvp, o.regulatory_risk,
              x.decision_rationale, x.budget_usd, x.spent_usd
       FROM opportunities o
       LEFT JOIN LATERAL (SELECT decision_rationale, budget_usd, spent_usd FROM experiments WHERE opportunity_id = o.id ORDER BY created_at DESC LIMIT 1) x ON true
       WHERE o.org_id = $1 AND o.status NOT IN ('killed','archived','paused') AND o.score IS NOT NULL
       ORDER BY o.score DESC LIMIT 25`,
      [orgId],
    );
    return rows.map((r) => {
      const score = r.score ?? 0.4;
      let alpha: number;
      let beta: number;
      let basis: PortfolioCandidate['evidenceBasis'] = 'score_prior';
      const stats = r.decision_rationale?.stats;
      if (stats && stats.denominator > 0) {
        // Evidence strength grows with sample size; P(rate > target) is the success signal.
        const k = clamp(stats.denominator / 20, 2, 60);
        alpha = 1 + stats.probAboveTarget * k;
        beta = 1 + (1 - stats.probAboveTarget) * k;
        basis = 'experiment';
      } else ({ alpha, beta } = priorFromScore(score));
      const ms = r.estimated_market_size;
      const tam = Number(ms?.value ?? 1e6);
      const gm = Number(r.gross_margin_estimate?.value ?? 0.8);
      // Payoff if successful: 24 months of gross profit at 0.1% / 0.5% / 2% capture of the serviceable market.
      const payoff = (m: number, share: number) => Math.max(1_000, m * share * 2 * gm);
      const weeks = Number(r.time_to_mvp?.value ?? 6);
      const fit = r.score_breakdown?.criteria.find((c) => c.key === 'strategic_fit')?.value ?? 0.5;
      const remaining = r.budget_usd ? Math.max(100, (r.budget_usd ?? 0) - (r.spent_usd ?? 0)) : 500;
      return {
        id: r.id,
        name: r.title,
        alpha,
        beta,
        payoffLowUsd: payoff(ms?.low ?? tam / 10, 0.001),
        payoffModeUsd: payoff(tam, 0.005),
        payoffHighUsd: payoff(ms?.high ?? tam * 10, 0.02),
        costToMilestoneUsd: remaining,
        timeToRevenueMonths: weeks / 4 + 1,
        riskPenalty: clamp(Number(r.regulatory_risk?.value ?? 0.3) * 0.5, 0, 0.9),
        synergy: fit,
        evidenceBasis: basis,
      };
    });
  }

  async allocate(orgId: string, input: { budgetUsd: number; minPerOpportunityUsd?: number; maxShare?: number; explorationFloor?: number }) {
    const candidates = await this.candidates(orgId);
    const result = allocateBudget(candidates, { ...input, seed: `${orgId}:${input.budgetUsd}` });
    return {
      ...result,
      recommendationOnly: true,
      notes: [...result.notes, 'This is a recommendation. Committing any spend is the approval-gated `spend.commit` action.'],
    };
  }

  private async portfolioValue(orgId: string) {
    const cands = await this.candidates(orgId);
    if (!cands.length) return { mid: 0, low: 0, high: 0, kind: 'MODEL_ASSUMPTION' as const };
    const r = allocateBudget(cands, { budgetUsd: 1, seed: `pv:${orgId}`, draws: 1500 });
    return {
      mid: Math.round(r.allocations.reduce((a, x) => a + x.evMeanUsd, 0)),
      low: Math.round(r.allocations.reduce((a, x) => a + x.evLowUsd, 0)),
      high: Math.round(r.allocations.reduce((a, x) => a + x.evHighUsd, 0)),
      kind: 'MODEL_ASSUMPTION' as const,
    };
  }

  async roadmap(orgId: string, overrides: Partial<RoadmapAssumptions> = {}) {
    const org = await this.orgs.get(orgId);
    // Real workspaces: verified revenue only. Demo workspace: demo figures, clearly labelled.
    const m = await this.revenue.metrics(orgId, !org.isDemo);
    const saved = (org.settings.roadmapAssumptions ?? {}) as Partial<RoadmapAssumptions>;
    const result = computeRoadmap(
      { ...saved, ...overrides },
      {
        verifiedArrUsd: m.arr,
        verifiedCumulativeRevenueUsd: m.revenueTotal,
        observedMonthlyGrowth: m.momGrowth,
        monthsOfData: m.series.filter((s) => s.mrr > 0).length,
      },
    );
    return { ...result, isDemo: org.isDemo, dataKind: org.isDemo ? 'DEMO' : 'OBSERVED', defaults: DEFAULT_ROADMAP_ASSUMPTIONS };
  }

  async saveRoadmapAssumptions(orgId: string, a: Partial<RoadmapAssumptions>) {
    const org = await this.orgs.get(orgId);
    await this.orgs.updateSettings(orgId, { roadmapAssumptions: { ...(org.settings.roadmapAssumptions ?? {}), ...a } as Record<string, number> });
    return this.roadmap(orgId);
  }
}
