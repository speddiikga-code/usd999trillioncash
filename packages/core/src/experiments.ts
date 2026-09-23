import { DEFAULT_THRESHOLDS, evaluateExperiment, requiredSampleSize } from '@roos/analytics';
import type { Db } from '@roos/database';
import { json } from '@roos/database';
import {
  camelize,
  ConflictError,
  newId,
  NotFoundError,
  PolicyDeniedError,
  round,
  type DecisionResult,
  type Experiment,
  type ExperimentCreateInput,
  type ExperimentThresholds,
  type FunnelStage,
} from '@roos/shared';
import type { AlertService } from './alerts';
import type { ApprovalService } from './approvals';
import type { Actor, AuditService } from './audit';
import type { EventBus } from './events';
import type { PaperLedger } from './ledger';
import type { OpportunityService } from './opportunities';
import { markStep } from './orgs';
import type { PolicyEngine } from './policy';
import type { ProductService } from './products';
import type { StrategyService } from './strategy';

export const FUNNELS: Record<ExperimentCreateInput['funnel'], { stages: FunnelStage[]; numerator: string; denominator: string; defaultTarget: number; label: string }> = {
  landing_signup: {
    label: 'Landing page → signup',
    stages: [
      { key: 'visit', event: 'page_view', label: 'Visitors' },
      { key: 'signup', event: 'signup', label: 'Signups' },
      { key: 'activation', event: 'activation', label: 'Activated' },
      { key: 'payment', event: 'payment', label: 'Paying' },
    ],
    numerator: 'signup',
    denominator: 'page_view',
    defaultTarget: 0.05,
  },
  signup_paid: {
    label: 'Signup → paid',
    stages: [
      { key: 'signup', event: 'signup', label: 'Signups' },
      { key: 'checkout', event: 'checkout_started', label: 'Checkout started' },
      { key: 'payment', event: 'payment', label: 'Paying' },
    ],
    numerator: 'payment',
    denominator: 'signup',
    defaultTarget: 0.05,
  },
  landing_paid: {
    label: 'Landing page → paid',
    stages: [
      { key: 'visit', event: 'page_view', label: 'Visitors' },
      { key: 'checkout', event: 'checkout_started', label: 'Checkout started' },
      { key: 'payment', event: 'payment', label: 'Paying' },
    ],
    numerator: 'payment',
    denominator: 'page_view',
    defaultTarget: 0.01,
  },
};

const toExperiment = (r: Record<string, unknown>) => camelize<Experiment & { variantCopy: Record<string, string>; approvalId: string | null; lastEvaluatedAt: string | null; hypothesisId: string | null }>(r);

export class ExperimentService {
  constructor(
    private db: Db,
    private audit: AuditService,
    private events: EventBus,
    private policy: PolicyEngine,
    private approvals: ApprovalService,
    private ledger: PaperLedger,
    private alerts: AlertService,
    private opportunities: OpportunityService,
    private products: ProductService,
    private strategy: StrategyService,
  ) {}

  async create(orgId: string, input: ExperimentCreateInput & { hypothesisId?: string; variantCopy?: Record<string, string> }, actor: Actor) {
    const funnel = FUNNELS[input.funnel];
    let opportunityTitle = input.name ?? 'Experiment';
    let productId = input.productId ?? null;
    if (input.opportunityId) {
      const opp = await this.opportunities.get(orgId, input.opportunityId);
      opportunityTitle = opp.title;
      if (!productId) {
        const p = (await this.products.productForOpportunity(orgId, opp.id)) ?? (await this.products.createProduct(orgId, { name: opp.title.slice(0, 80), opportunityId: opp.id, description: 'Landing-page smoke test' }));
        productId = p.id as string;
      }
    }
    if (productId) await this.products.getProduct(orgId, productId);
    const thresholds: ExperimentThresholds = {
      ...DEFAULT_THRESHOLDS,
      targetRate: funnel.defaultTarget,
      maxBudgetUsd: input.budgetUsd || DEFAULT_THRESHOLDS.maxBudgetUsd,
      ...Object.fromEntries(Object.entries(input.thresholds ?? {}).filter(([, v]) => v !== undefined)),
    };
    const hypothesis = input.hypothesis ?? `At least ${round(thresholds.targetRate * 100, 2)}% of ${funnel.stages[0]!.label.toLowerCase()} convert (${funnel.label}).`;
    const id = newId('experiment');
    const row = await this.db.one(
      `INSERT INTO experiments (id, org_id, opportunity_id, product_id, hypothesis_id, name, hypothesis, funnel, primary_numerator, primary_denominator, variants, variant_copy, thresholds, budget_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        id,
        orgId,
        input.opportunityId ?? null,
        productId,
        input.hypothesisId ?? null,
        input.name ?? `${opportunityTitle.slice(0, 120)} — ${funnel.label}`,
        hypothesis,
        json(funnel.stages),
        funnel.numerator,
        funnel.denominator,
        json(input.variants),
        json(input.variantCopy ?? {}),
        json(thresholds),
        input.budgetUsd,
      ],
    );
    await this.audit.record({ orgId, actor, action: 'experiment.create', targetType: 'experiment', targetId: id, details: { budgetUsd: input.budgetUsd, funnel: input.funnel } });
    await this.events.publish(orgId, 'experiment.created', { entityType: 'experiment', entityId: id, payload: { name: row!.name } });
    return toExperiment(row!);
  }

  async get(orgId: string, id: string) {
    const row = await this.db.one('SELECT * FROM experiments WHERE id = $1 AND org_id = $2', [id, orgId]);
    if (!row) throw new NotFoundError('Experiment', id);
    return toExperiment(row);
  }

  async list(orgId: string, status?: string) {
    const rows = await this.db.many(
      `SELECT x.*, p.name AS product_name, p.url AS product_url, o.title AS opportunity_title FROM experiments x
       LEFT JOIN products p ON p.id = x.product_id LEFT JOIN opportunities o ON o.id = x.opportunity_id
       WHERE x.org_id = $1 ${status ? 'AND x.status = $2' : ''} ORDER BY (x.status = 'running') DESC, x.created_at DESC LIMIT 200`,
      status ? [orgId, status] : [orgId],
    );
    return rows.map(toExperiment);
  }

  /** Start: spend-bearing experiments go through the spend.commit policy (approval by default). */
  async start(orgId: string, id: string, actor: Actor, opts: { taskId?: string } = {}) {
    const exp = await this.get(orgId, id);
    if (!['draft', 'paused'].includes(exp.status)) throw new ConflictError(`Experiment is ${exp.status}`);
    if (exp.budgetUsd > 0) {
      const d = await this.policy.evaluate(orgId, 'spend.commit', { amountUsd: exp.budgetUsd });
      if (d.decision === 'deny') throw new PolicyDeniedError(d.reason);
      if (d.decision === 'require_approval') {
        const evidence = exp.opportunityId ? (await this.opportunities.detail(orgId, exp.opportunityId)).evidence.slice(0, 5) : [];
        const approval = await this.approvals.request(orgId, {
          actionType: 'spend.commit',
          title: `Commit $${exp.budgetUsd} to experiment "${exp.name}"`,
          what: `Start experiment ${exp.id} and allow up to $${exp.budgetUsd} of acquisition spend (e.g. ads) while it runs. Spend is recorded as expenses against the experiment.`,
          why: `Test the hypothesis: ${exp.hypothesis}`,
          expectedBenefit: `A decision (SCALE / ITERATE / KILL) after ≥ ${exp.thresholds.minSample} observations instead of guessing. Required sample for a 20% lift at the target rate ≈ ${requiredSampleSize(exp.thresholds.targetRate, 0.2).toLocaleString('en-US')} per arm.`,
          expectedCostUsd: exp.budgetUsd,
          risk: { level: exp.budgetUsd > 1000 ? 'high' : 'medium', description: 'Money may be spent without validating demand. Automatic PAUSE if CAC or complaint guardrails are breached.' },
          dataSources: evidence.map((e) => ({ name: e.sourceName, url: e.sourceUrl ?? undefined, retrievedAt: e.observedAt })),
          reversibility: 'partially_reversible',
          payload: { experimentId: exp.id },
          requestedBy: actor.id,
          taskId: opts.taskId ?? null,
        });
        await this.db.query(`UPDATE experiments SET status = 'pending_approval', approval_id = $3, updated_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId, approval.id]);
        return { status: 'pending_approval' as const, approvalId: approval.id };
      }
      if (d.decision === 'simulate') {
        await this.ledger.record(orgId, { account: 'experiments', entryType: 'budget_commit', amountUsd: -exp.budgetUsd, memo: `Simulated budget for ${exp.name}`, experimentId: id });
      } else await this.policy.recordAutonomous(orgId, 'spend.commit', actor, { experimentId: id, amountUsd: exp.budgetUsd });
    } else {
      const d = await this.policy.evaluate(orgId, 'experiment.start');
      if (d.decision === 'deny') throw new PolicyDeniedError(d.reason);
      if (d.decision === 'require_approval') throw new PolicyDeniedError('Starting experiments requires approval in this workspace; request it from the approval center.');
    }
    return this.markRunning(orgId, id, actor);
  }

  async markRunning(orgId: string, id: string, actor: Actor) {
    const row = await this.db.one(`UPDATE experiments SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *`, [id, orgId]);
    const exp = toExperiment(row!);
    if (exp.opportunityId) await this.opportunities.setStatus(orgId, exp.opportunityId, 'experimenting', actor);
    if (exp.hypothesisId) await this.db.query(`UPDATE business_hypotheses SET status = 'testing', updated_at = now() WHERE id = $1`, [exp.hypothesisId]);
    await this.audit.record({ orgId, actor, action: 'experiment.start', targetType: 'experiment', targetId: id, details: { budgetUsd: exp.budgetUsd } });
    await this.events.publish(orgId, 'experiment.started', { entityType: 'experiment', entityId: id, payload: { name: exp.name } });
    await markStep(this.db, orgId, 'launch_experiment');
    return { status: 'running' as const, experiment: exp };
  }

  async stop(orgId: string, id: string, actor: Actor) {
    await this.db.query(`UPDATE experiments SET status = 'cancelled', ended_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2 AND status IN ('draft','pending_approval','running','paused')`, [id, orgId]);
    await this.audit.record({ orgId, actor, action: 'experiment.stop', targetType: 'experiment', targetId: id });
  }

  async funnelStats(orgId: string, id: string) {
    const exp = await this.get(orgId, id);
    const since = exp.startedAt ?? exp.createdAt;
    const rows = await this.db.many<{ event: string; variant: string | null; n: number }>(
      `SELECT event, COALESCE(variant, 'control') AS variant, COUNT(DISTINCT anonymous_id)::int AS n FROM tracking_events
       WHERE org_id = $1 AND experiment_id = $2 AND NOT is_bot AND occurred_at >= $3 GROUP BY 1, 2`,
      [orgId, id, since],
    );
    const daily = await this.db.many<{ day: string; event: string; n: number }>(
      `SELECT to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') AS day, event, COUNT(DISTINCT anonymous_id)::int AS n FROM tracking_events
       WHERE org_id = $1 AND experiment_id = $2 AND NOT is_bot AND occurred_at >= $3 GROUP BY 1, 2 ORDER BY 1`,
      [orgId, id, since],
    );
    const total = (event: string) => rows.filter((r) => r.event === event).reduce((a, r) => a + r.n, 0);
    const stages = exp.funnel.map((s) => ({ ...s, count: total(s.event) }));
    const variants = exp.variants.map((v) => ({
      variant: v,
      numerator: rows.find((r) => r.event === exp.primaryNumerator && r.variant === v)?.n ?? 0,
      denominator: rows.find((r) => r.event === exp.primaryDenominator && r.variant === v)?.n ?? 0,
    }));
    const spent = Number((await this.db.value('SELECT COALESCE(SUM(amount_usd), 0) FROM expenses WHERE org_id = $1 AND experiment_id = $2', [orgId, id])) ?? 0);
    return { experiment: exp, stages, variants, daily, spentUsd: spent, customers: total('payment'), complaints: total('unsubscribe') + total('complaint') };
  }

  async evaluate(orgId: string, id: string, actor: Actor, opts: { now?: Date; ltvUsd?: number | null } = {}): Promise<DecisionResult> {
    const stats = await this.funnelStats(orgId, id);
    const exp = stats.experiment;
    const result = evaluateExperiment({
      experimentId: id,
      thresholds: exp.thresholds,
      numerator: stats.variants.reduce((a, v) => a + v.numerator, 0),
      denominator: stats.variants.reduce((a, v) => a + v.denominator, 0),
      variants: stats.variants.length > 1 ? stats.variants : undefined,
      startedAt: exp.startedAt,
      now: opts.now,
      spentUsd: stats.spentUsd,
      budgetUsd: exp.budgetUsd,
      customersAcquired: stats.customers,
      ltvUsd: opts.ltvUsd ?? null,
      complaints: stats.complaints,
    });
    await this.db.query(`UPDATE experiments SET decision = $3, decision_rationale = $4, spent_usd = $5, last_evaluated_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2`, [
      id,
      orgId,
      result.decision,
      json(result),
      stats.spentUsd,
    ]);
    const last = await this.db.one<{ decision: string }>('SELECT decision FROM experiment_evaluations WHERE experiment_id = $1 ORDER BY created_at DESC LIMIT 1', [id]);
    if (!last || last.decision !== result.decision || result.decision !== 'CONTINUE') {
      await this.db.query('INSERT INTO experiment_evaluations (org_id, experiment_id, decision, result) VALUES ($1,$2,$3,$4)', [orgId, id, result.decision, json(result)]);
    }
    await this.events.publish(orgId, 'experiment.evaluated', { entityType: 'experiment', entityId: id, payload: { decision: result.decision, rate: result.stats.rate, n: result.stats.denominator } });
    if (exp.status === 'running' && result.decision !== 'CONTINUE') await this.applyDecision(orgId, exp, result, actor);
    return result;
  }

  private async applyDecision(orgId: string, exp: Experiment & { hypothesisId: string | null }, r: DecisionResult, actor: Actor) {
    const map = {
      SCALE: { status: 'completed', opp: 'scaling', hyp: 'validated', sev: 'info' },
      KILL: { status: 'killed', opp: 'killed', hyp: 'invalidated', sev: 'warning' },
      ITERATE: { status: 'completed', opp: 'analyzed', hyp: 'proposed', sev: 'info' },
      PAUSE: { status: 'paused', opp: null, hyp: null, sev: 'warning' },
    } as const;
    const m = map[r.decision as keyof typeof map];
    await this.db.query(`UPDATE experiments SET status = $3, ended_at = CASE WHEN $3 IN ('completed','killed') THEN now() ELSE ended_at END, updated_at = now() WHERE id = $1 AND org_id = $2`, [exp.id, orgId, m.status]);
    if (exp.opportunityId && m.opp) await this.opportunities.setStatus(orgId, exp.opportunityId, m.opp, actor);
    if (exp.hypothesisId && m.hyp) await this.db.query('UPDATE business_hypotheses SET status = $2, updated_at = now() WHERE id = $1', [exp.hypothesisId, m.hyp]);
    await this.alerts.raise(orgId, {
      severity: m.sev,
      title: `Experiment ${r.decision}: ${exp.name}`,
      message: r.reasons.join(' '),
      entityType: 'experiment',
      entityId: exp.id,
    });
    await this.audit.record({ orgId, actor, action: 'experiment.decide', targetType: 'experiment', targetId: exp.id, details: { decision: r.decision, reasons: r.reasons, stats: r.stats } });
    await this.events.publish(orgId, 'experiment.decided', { entityType: 'experiment', entityId: exp.id, payload: { decision: r.decision } });
    if (r.decision === 'SCALE' || r.decision === 'KILL') {
      // LEARN: every concluded experiment is an outcome for recalibrating scoring weights and source quality.
      await this.strategy.recalibrate(orgId, actor);
      await this.strategy.updateSourceQuality(orgId);
    }
  }

  async evaluateAllRunning(orgId: string, actor: Actor, ltvUsd?: number | null) {
    const running = await this.db.many<{ id: string }>(`SELECT id FROM experiments WHERE org_id = $1 AND status = 'running'`, [orgId]);
    const out: { id: string; decision: string }[] = [];
    for (const r of running) out.push({ id: r.id, decision: (await this.evaluate(orgId, r.id, actor, { ltvUsd })).decision });
    return out;
  }

  async recordSpend(orgId: string, id: string, amountUsd: number, description: string, actor: Actor, source: 'manual' | 'simulation' = 'manual') {
    const exp = await this.get(orgId, id);
    await this.db.query(`INSERT INTO expenses (id, org_id, product_id, experiment_id, category, amount_usd, occurred_at, description, source) VALUES ($1,$2,$3,$4,'ads',$5,now(),$6,$7)`, [
      newId('expense'),
      orgId,
      exp.productId,
      id,
      amountUsd,
      description,
      source,
    ]);
    await this.audit.record({ orgId, actor, action: 'experiment.spend', targetType: 'experiment', targetId: id, details: { amountUsd, source } });
    await this.events.publish(orgId, 'expense.recorded', { entityType: 'experiment', entityId: id, payload: { amountUsd } });
    const spent = Number((await this.db.value('SELECT COALESCE(SUM(amount_usd),0) FROM expenses WHERE experiment_id = $1', [id])) ?? 0);
    if (exp.budgetUsd > 0 && spent > exp.budgetUsd) {
      await this.alerts.raise(orgId, { severity: 'critical', title: `Budget exceeded: ${exp.name}`, message: `Spent $${round(spent)} of a $${exp.budgetUsd} budget.`, entityType: 'experiment', entityId: id });
    }
    return { spentUsd: spent };
  }

  async evaluations(orgId: string, id: string) {
    return (await this.db.many('SELECT decision, result, created_at FROM experiment_evaluations WHERE org_id = $1 AND experiment_id = $2 ORDER BY created_at DESC LIMIT 50', [orgId, id])).map((r) => camelize(r));
  }
}
