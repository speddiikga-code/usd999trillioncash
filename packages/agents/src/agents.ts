import { scanForInjection } from '@roos/security';
import {
  ApprovalRequiredError,
  AppError,
  errorMessage,
  round,
  truncate,
  ValidationError,
  z,
  type AgentName,
  type BusinessHypothesis,
} from '@roos/shared';
import { regulatoryEstimate } from '@roos/core';
import type { AgentContext, AgentDefinition, NextTask, TaskHandler } from './types';

const DEFAULT_BUDGET = { maxCostPerTaskUsd: 0.5, dailyCostUsd: 2 };
const DEFAULT_RETRY = { maxAttempts: 3, backoffMs: 3000, factor: 3 };

async function resolveOpp(ctx: AgentContext, input: Record<string, any>): Promise<string> {
  const ref = String(input.opportunityId ?? input.ref ?? '');
  if (!ref) throw new ValidationError('opportunityId is required');
  return ctx.core.opportunities.resolveId(ctx.orgId, ref);
}

// ───────────────────────── ResearchAgent ─────────────────────────

const researchDiscover: TaskHandler = async (ctx, input) => {
  const query = String(input.query ?? '').trim();
  if (!query) throw new ValidationError('query is required');
  const past = await ctx.memory.recall(null, 20);
  const repeat = past.find((m) => m.kind === 'summary' && m.data.query === query && Date.now() - new Date(m.createdAt).getTime() < 3_600_000);
  const result = await ctx.tool('connectors.search', { query, sources: input.sources }, () =>
    ctx.core.discovery.scan(ctx.orgId, { query, sources: input.sources, limitPerSource: Number(input.limitPerSource ?? 30), industries: input.industries }, { router: ctx.router, callCtx: ctx.callCtx, actor: ctx.actor }),
  );
  const next: NextTask[] = result.opportunitiesCreated.map((opportunityId) => ({ agent: 'RiskAgent' as AgentName, kind: 'risk.assess', input: { opportunityId } }));
  return {
    output: { ...result, repeatedWithinHour: !!repeat },
    next,
    memory: [
      {
        kind: 'summary',
        content: `Scan "${query}": ${result.documentsStored} docs, ${result.opportunitiesCreated.length} new / ${result.opportunitiesUpdated.length} updated opportunities (${result.synthesis}).`,
        data: { query, created: result.opportunitiesCreated.length, failedSources: result.runs.filter((r) => r.error).map((r) => r.connector) },
        importance: 0.4,
      },
    ],
  };
};

// ───────────────────────── MarketAgent ─────────────────────────

const marketAnalyze: TaskHandler = async (ctx, input) => {
  const oppId = await resolveOpp(ctx, input);
  const r = await ctx.tool('analysis.run', { opportunityId: oppId }, () => ctx.core.analysis.analyze(ctx.orgId, oppId, { router: ctx.router, callCtx: ctx.callCtx, actor: ctx.actor }));
  return {
    output: {
      opportunityId: oppId,
      score: r.score.score,
      scoreRange: [r.score.low, r.score.high],
      hypotheses: r.hypotheses.map((h) => ({ id: h.id, model: h.model, title: h.title, score: h.score, ltvToCac: h.unitEconomics.ltvToCac.value })),
      competition: r.competition.level,
      notes: r.notes,
      generatedBy: r.generatedBy,
    },
    next: [
      { agent: 'RiskAgent', kind: 'risk.assess', input: { opportunityId: oppId } },
      { agent: 'FinanceAgent', kind: 'finance.review', input: { opportunityId: oppId } },
      { agent: 'CustomerAgent', kind: 'customer.profile', input: { opportunityId: oppId } },
    ],
    memory: [{ kind: 'fact', scope: oppId, content: `Analyzed: score ${round(r.score.score, 2)} (${round(r.score.low, 2)}–${round(r.score.high, 2)}), competition ${r.competition.level}.`, importance: 0.5 }],
  };
};

// ───────────────────────── RiskAgent ─────────────────────────

const RiskReviewSchema = z.object({
  risks: z.array(z.object({ area: z.string().max(80), severity: z.enum(['low', 'medium', 'high']), note: z.string().max(400) })).max(8),
  mitigations: z.array(z.string().max(300)).max(8),
});

const riskAssess: TaskHandler = async (ctx, input) => {
  const oppId = await resolveOpp(ctx, input);
  const d = await ctx.core.opportunities.detail(ctx.orgId, oppId);
  const text = [d.title, d.problem, ...d.evidence.map((e) => `${e.claim} ${e.quote ?? ''}`)].join('\n');
  const reg = regulatoryEstimate(text);
  const injected = d.evidence.filter((e) => scanForInjection(`${e.quote ?? ''}`).suspicious).length;
  let modelReview: z.infer<typeof RiskReviewSchema> | null = null;
  if (ctx.router && reg.flags.length) {
    try {
      const { data } = await ctx.router.generateJson(
        {
          purpose: 'risk.review',
          tier: 'balanced',
          system: 'You are a cautious compliance analyst. Identify legal/regulatory/ethical risks for launching this product. You are not giving legal advice; recommend professional review where appropriate.',
          prompt: `Opportunity: ${d.title}\nProblem: ${truncate(d.problem, 800)}\nKeyword screen flagged: ${reg.flags.map((f) => f.area).join(', ')}\nReturn {risks, mitigations}.`,
          maxOutputTokens: 3000,
        },
        RiskReviewSchema,
        ctx.callCtx,
      );
      modelReview = data;
    } catch (e) {
      ctx.log.warn('Model risk review failed', { error: errorMessage(e) });
    }
  }
  const { flags, ...regulatoryRisk } = reg;
  await ctx.tool('opportunity.write', { opportunityId: oppId, field: 'regulatoryRisk' }, async () => {
    await ctx.core.opportunities.update(ctx.orgId, oppId, { regulatoryRisk, tags: reg.value >= 0.6 ? [...new Set([...d.tags, 'regulated'])] : d.tags }, ctx.actor);
    await ctx.core.opportunities.rescore(ctx.orgId, oppId);
  });
  if (Number(reg.value) >= 0.7) {
    await ctx.tool('alerts.raise', { opportunityId: oppId }, () =>
      ctx.core.alerts.raise(ctx.orgId, { severity: 'warning', title: `Regulatory review needed: ${truncate(d.title, 80)}`, message: flags.map((f) => `${f.area}: ${f.note}`).join(' '), entityType: 'opportunity', entityId: oppId }),
    );
  }
  return {
    output: { opportunityId: oppId, regulatoryRisk: reg.value, flags, promptInjectionEvidence: injected, modelReview, disclaimer: 'Automated screening — not legal advice.' },
    memory: flags.length ? [{ kind: 'warning', scope: oppId, content: `Regulatory flags: ${flags.map((f) => f.area).join(', ')}`, importance: 0.8 }] : [],
  };
};

// ───────────────────────── FinanceAgent ─────────────────────────

const financeReview: TaskHandler = async (ctx, input) => {
  const oppId = await resolveOpp(ctx, input);
  const d = await ctx.core.opportunities.detail(ctx.orgId, oppId);
  const hyps = d.hypotheses as unknown as BusinessHypothesis[];
  if (!hyps.length) throw new ValidationError('No hypotheses to review — run /analyze first');
  const viable = hyps.filter((h) => Number(h.unitEconomics.ltvToCac.value) >= 1).sort((a, b) => b.score - a.score);
  const best = viable[0] ?? [...hyps].sort((a, b) => b.score - a.score)[0]!;
  let selected = false;
  if (!d.selectedHypothesisId && viable.length && (d.score ?? 0) >= 0.45) {
    await ctx.tool('hypothesis.select', { opportunityId: oppId, hypothesisId: best.id }, () => ctx.core.analysis.selectHypothesis(ctx.orgId, oppId, best.id, ctx.actor));
    selected = true;
  }
  return {
    output: {
      opportunityId: oppId,
      recommended: { id: best.id, title: best.title, model: best.model, ltvToCac: best.unitEconomics.ltvToCac, paybackMonths: best.unitEconomics.paybackMonths },
      viableCount: viable.length,
      selected,
      note: viable.length ? 'Unit economics are MODEL ASSUMPTIONS until measured by experiments.' : 'No hypothesis reaches LTV/CAC ≥ 1 under current assumptions — test pricing before building.',
    },
    memory: [{ kind: 'fact', scope: oppId, content: `Best hypothesis: ${best.title} (LTV/CAC ≈ ${round(Number(best.unitEconomics.ltvToCac.value), 1)}, assumption).`, importance: 0.5 }],
  };
};

const financeAllocate: TaskHandler = async (ctx, input) => {
  const org = await ctx.core.orgs.get(ctx.orgId);
  const budgetUsd = Number(input.budgetUsd ?? org.settings.constraints?.monthlyBudgetUsd ?? 1000);
  const allocation = await ctx.tool('finance.analyze', { budgetUsd }, () => ctx.core.portfolio.allocate(ctx.orgId, { budgetUsd, maxShare: 0.5, explorationFloor: 0.1 }));
  const cashflow = await ctx.tool('finance.analyze', { cashflow: true }, () => ctx.core.revenue.cashflow(ctx.orgId, { cashOnHandUsd: org.settings.constraints?.initialCapitalUsd }));
  return {
    output: { allocation, cashflow: { runwayMonthsP50: cashflow.runwayMonthsP50, probCashNegative: cashflow.probCashNegative, inputs: cashflow.inputs, month12: cashflow.months.at(-1) } },
    memory: [{ kind: 'summary', content: `Allocation of $${budgetUsd}: ${allocation.allocations.slice(0, 3).map((a) => `${truncate(a.name, 30)} $${a.amountUsd}`).join(', ')} (recommendation only).`, importance: 0.4 }],
  };
};

// ───────────────────────── CustomerAgent ─────────────────────────

const customerProfile: TaskHandler = async (ctx, input) => {
  const oppId = await resolveOpp(ctx, input);
  const d = await ctx.core.opportunities.get(ctx.orgId, oppId);
  const leads = await ctx.core.db.many<{ id: string }>('SELECT id FROM leads WHERE org_id = $1 AND opportunity_id = $2', [ctx.orgId, oppId]);
  await ctx.tool('leads.score', { opportunityId: oppId, count: leads.length }, async () => {
    for (const l of leads) await ctx.core.leads.rescore(ctx.orgId, l.id);
  });
  return {
    output: { opportunityId: oppId, idealCustomer: d.customer, icpKeywords: d.signals.keywords, leadsRescored: leads.length, note: 'ICP is inferred from evidence keywords — validate in customer interviews.' },
  };
};

const customerScoreLeads: TaskHandler = async (ctx, input) => {
  const leads = await ctx.core.db.many<{ id: string }>(`SELECT id FROM leads WHERE org_id = $1 ${input.opportunityId ? 'AND opportunity_id = $2' : ''} LIMIT 2000`, input.opportunityId ? [ctx.orgId, input.opportunityId] : [ctx.orgId]);
  await ctx.tool('leads.score', { count: leads.length }, async () => {
    for (const l of leads) await ctx.core.leads.rescore(ctx.orgId, l.id);
  });
  const top = await ctx.core.leads.list(ctx.orgId, { minScore: 1, limit: 10 });
  return { output: { rescored: leads.length, top: top.map((l) => ({ id: l.id, name: l.name, score: l.score, contactable: l.consentBasis !== 'unknown' && !!l.email })) } };
};

// ───────────────────────── ProductAgent & CodeAgent ─────────────────────────

const productSpec: TaskHandler = async (ctx, input) => {
  const oppId = await resolveOpp(ctx, input);
  let hyp = input.hypothesisId ? await ctx.core.analysis.getHypothesis(ctx.orgId, String(input.hypothesisId)) : await ctx.core.analysis.bestHypothesis(ctx.orgId, oppId);
  if (!hyp) throw new ValidationError('No business hypothesis exists — run /analyze first');
  if (hyp.status !== 'selected') hyp = await ctx.tool('hypothesis.select', { opportunityId: oppId, hypothesisId: hyp.id }, () => ctx.core.analysis.selectHypothesis(ctx.orgId, oppId, hyp!.id, ctx.actor));
  return {
    output: { opportunityId: oppId, hypothesisId: hyp.id, spec: hyp.mvpSpec, pricing: hyp.pricing, model: hyp.model },
    next: [{ agent: 'CodeAgent', kind: 'code.generate', input: { opportunityId: oppId, hypothesisId: hyp.id } }],
  };
};

const codeGenerate: TaskHandler = async (ctx, input) => {
  const oppId = await resolveOpp(ctx, input);
  const hyp = await ctx.core.analysis.getHypothesis(ctx.orgId, String(input.hypothesisId));
  const r = await ctx.tool('code.generate', { opportunityId: oppId, hypothesisId: hyp.id }, () => ctx.core.products.build(ctx.orgId, oppId, hyp, ctx.actor));
  return {
    output: { projectId: r.projectId, productId: r.productId, path: r.path, files: r.files, status: r.status, scanPassed: r.scan.passed, findings: r.scan.findings.slice(0, 20), tests: { status: r.tests.status, ...('stdout' in r.tests ? { summary: r.tests.stdout.split('\n').filter((l) => /^ℹ (tests|pass|fail)/.test(l)) } : { reason: r.tests.reason }) } },
    next: [{ agent: 'SecurityAgent', kind: 'security.review_build', input: { projectId: r.projectId } }],
    memory: [{ kind: 'fact', scope: oppId, content: `Built project ${r.projectId}: ${r.status}.`, importance: 0.4 }],
  };
};

const codeDeployLocal: TaskHandler = async (ctx, input) => {
  let projectId = input.projectId as string | undefined;
  if (!projectId) {
    const oppId = await resolveOpp(ctx, input);
    projectId = (await ctx.core.db.value<string>(`SELECT id FROM projects WHERE org_id = $1 AND opportunity_id = $2 ORDER BY created_at DESC LIMIT 1`, [ctx.orgId, oppId])) ?? undefined;
    if (!projectId) throw new ValidationError('No generated project for this opportunity — run /build first');
  }
  const r = await ctx.tool('deploy.local', { projectId }, () => ctx.core.products.deployLocal(ctx.orgId, projectId!, ctx.actor, { experimentId: input.experimentId }));
  return { output: r };
};

const codeRequestProduction: TaskHandler = async (ctx, input) => {
  const projectId = String(input.projectId);
  if (ctx.approvalId) {
    const a = await ctx.core.approvals.get(ctx.orgId, ctx.approvalId);
    return { output: { approvalId: a.id, status: a.status, result: a.result } };
  }
  const project = await ctx.core.products.getProject(ctx.orgId, projectId);
  const approval = await ctx.tool('deploy.production', { projectId }, () =>
    ctx.core.approvals.request(ctx.orgId, {
      actionType: 'deploy.production',
      title: `Deploy "${project.name}" to production`,
      what: `Prepare a production deployment bundle for project ${projectId} (Dockerfile, fly.toml example, checklist). Pushing to a host is performed by a human.`,
      why: 'Make the product reachable by real customers so experiments measure real demand.',
      expectedBenefit: 'Real traffic and signups instead of local previews.',
      expectedCostUsd: 10,
      risk: { level: 'high', description: 'Public exposure of generated code; hosting costs; brand risk if copy is wrong. Tests and static scan status are attached.' },
      dataSources: [{ name: `Project ${projectId} scan & test results` }],
      reversibility: 'reversible',
      payload: { projectId, scan: (project.scanResult as { passed?: boolean })?.passed, tests: (project.testResult as { status?: string })?.status },
      requestedBy: ctx.actor.id,
      taskId: ctx.task.id,
    }),
  );
  throw new ApprovalRequiredError(approval.id);
};

// ───────────────────────── SecurityAgent ─────────────────────────

const securityReviewBuild: TaskHandler = async (ctx, input) => {
  const p = await ctx.core.products.getProject(ctx.orgId, String(input.projectId));
  const scan = p.scanResult as { passed: boolean; findings: { severity: string; rule: string; file: string }[]; dependencyViolations: string[] };
  const tests = p.testResult as { status: string; isolation?: string[] };
  const problems = [...(scan?.passed ? [] : ['Static security scan failed']), ...(tests?.status === 'failed' ? ['Generated tests failed'] : []), ...(tests?.status === 'timeout' ? ['Tests timed out'] : [])];
  if (problems.length) {
    await ctx.tool('alerts.raise', { projectId: p.id }, () => ctx.core.alerts.raise(ctx.orgId, { severity: 'critical', title: `Build blocked: ${p.name}`, message: problems.join('; '), entityType: 'project', entityId: p.id }));
  }
  return { output: { projectId: p.id, approvedForPreview: !problems.length, problems, warnings: (scan?.findings ?? []).filter((f) => f.severity === 'warning'), isolation: tests?.isolation ?? [] } };
};

const securityAudit: TaskHandler = async (ctx) => {
  const chain = await ctx.tool('security.audit', {}, () => ctx.core.audit.verifyChain(ctx.orgId));
  const db = ctx.core.db;
  const [denied, relaxed, stale, suspicious, failedLogins] = await Promise.all([
    db.value<number>(`SELECT COUNT(*) FROM audit_logs WHERE org_id = $1 AND outcome = 'denied' AND created_at > now() - interval '7 days'`, [ctx.orgId]),
    db.many<{ action: string; mode: string }>(`SELECT action, mode FROM policies WHERE org_id = $1 AND mode = 'AUTONOMOUS'`, [ctx.orgId]),
    db.value<number>(`SELECT COUNT(*) FROM approvals WHERE org_id = $1 AND status = 'pending' AND created_at < now() - interval '48 hours'`, [ctx.orgId]),
    db.value<number>(`SELECT COUNT(*) FROM documents WHERE org_id = $1 AND injection_score >= 0.5`, [ctx.orgId]),
    db.value<number>(`SELECT COUNT(*) FROM audit_logs WHERE action = 'auth.login' AND outcome = 'denied' AND created_at > now() - interval '1 day'`),
  ]);
  const findings: string[] = [];
  if (!chain.valid) findings.push(`Audit hash chain broken at ${chain.brokenAt}`);
  if (ctx.core.cfg.secrets.ephemeral) findings.push('APP_SECRET / ENCRYPTION_KEY are not configured (ephemeral)');
  if (ctx.core.cfg.sandbox.driver === 'process') findings.push('Sandbox uses the process driver (no network isolation) — use docker in production');
  if (Number(stale)) findings.push(`${stale} approval request(s) pending for more than 48h`);
  if (Number(failedLogins) > 20) findings.push(`${failedLogins} failed logins in 24h — possible credential stuffing`);
  const autonomous = relaxed.filter((r) => ['spend.commit', 'outreach.send'].includes(r.action));
  if (autonomous.length) findings.push(`Relaxed policies: ${autonomous.map((r) => r.action).join(', ')} are AUTONOMOUS`);
  if (findings.some((f) => /broken|credential/.test(f))) {
    await ctx.tool('alerts.raise', {}, () => ctx.core.alerts.raise(ctx.orgId, { severity: 'critical', title: 'Security audit findings', message: findings.join(' · ') }));
  }
  return { output: { auditChain: chain, deniedActions7d: Number(denied), autonomousPolicies: relaxed, suspiciousDocuments: Number(suspicious), findings, checkedAt: new Date().toISOString() } };
};

// ───────────────────────── GrowthAgent ─────────────────────────

const HeadlinesSchema = z.object({ headlines: z.array(z.string().min(8).max(90)).length(2) });

const growthDesignExperiment: TaskHandler = async (ctx, input) => {
  const oppId = await resolveOpp(ctx, input);
  const opp = await ctx.core.opportunities.get(ctx.orgId, oppId);
  const hyp = await ctx.core.analysis.bestHypothesis(ctx.orgId, oppId);
  const existing = await ctx.core.db.one<{ id: string }>(`SELECT id FROM experiments WHERE org_id = $1 AND opportunity_id = $2 AND status IN ('draft','pending_approval','running') ORDER BY created_at DESC LIMIT 1`, [ctx.orgId, oppId]);
  if (existing) return { output: { experimentId: existing.id, reused: true }, next: [{ agent: 'GrowthAgent', kind: 'growth.start_experiment', input: { experimentId: existing.id, opportunityId: oppId } }] };

  const kw = opp.signals.keywords[0] ?? 'this work';
  let copy = { a: hyp?.mvpSpec?.tagline || truncate(opp.title, 80), b: truncate(`Stop doing ${kw} by hand`, 90) };
  let copySource = 'heuristic';
  if (ctx.router) {
    try {
      const { data } = await ctx.router.generateJson(
        { purpose: 'growth.copy', tier: 'fast', system: 'Write two distinct landing-page headlines for an A/B test. No numbers, statistics, testimonials or claims that cannot be verified.', prompt: `Product: ${hyp?.title ?? opp.title}\nValue proposition: ${hyp?.valueProposition ?? opp.problem}\nReturn {"headlines": [a, b]}`, maxOutputTokens: 500 },
        HeadlinesSchema,
        ctx.callCtx,
      );
      copy = { a: data.headlines[0]!, b: data.headlines[1]! };
      copySource = 'model';
    } catch (e) {
      ctx.log.warn('Headline generation failed', { error: errorMessage(e) });
    }
  }
  const lessons = await ctx.memory.recall(null, 30);
  const budgetUsd = Number(input.budgetUsd ?? 0);
  const exp = await ctx.tool('experiment.manage', { opportunityId: oppId, create: true }, () =>
    ctx.core.experiments.create(
      ctx.orgId,
      {
        opportunityId: oppId,
        hypothesisId: hyp?.id,
        budgetUsd,
        variants: ['a', 'b'],
        variantCopy: copy,
        thresholds: { targetRate: 0.05, minSample: Number(input.minSample ?? 200) },
        funnel: 'landing_signup',
      },
      ctx.actor,
    ),
  );
  return {
    output: { experimentId: exp.id, copy, copySource, budgetUsd, thresholds: exp.thresholds, lessonsConsidered: lessons.filter((l) => l.kind === 'lesson').length },
    next: [{ agent: 'GrowthAgent', kind: 'growth.start_experiment', input: { experimentId: exp.id, opportunityId: oppId } }],
  };
};

const growthStartExperiment: TaskHandler = async (ctx, input) => {
  const expId = String(input.experimentId);
  let exp = await ctx.core.experiments.get(ctx.orgId, expId);
  if (exp.status === 'draft' || (exp.status === 'pending_approval' && !ctx.approvalId)) {
    if (exp.status === 'draft') {
      const r = await ctx.tool('experiment.manage', { experimentId: expId, start: true }, () => ctx.core.experiments.start(ctx.orgId, expId, ctx.actor, { taskId: ctx.task.id }));
      if (r.status === 'pending_approval') throw new ApprovalRequiredError(r.approvalId);
    } else throw new ApprovalRequiredError(exp.approvalId ?? 'unknown');
  }
  exp = await ctx.core.experiments.get(ctx.orgId, expId);
  if (exp.status !== 'running') return { output: { experimentId: expId, status: exp.status, note: 'Experiment did not start (approval rejected or cancelled).' } };
  const project = await ctx.core.db.one<{ id: string }>(`SELECT id FROM projects WHERE org_id = $1 AND opportunity_id = $2 AND status IN ('tests_passed','generated','deployed') ORDER BY created_at DESC LIMIT 1`, [ctx.orgId, exp.opportunityId]);
  return {
    output: { experimentId: expId, status: exp.status, productId: exp.productId, deploy: project ? 'queued' : 'no generated project — share the product write key with your landing page or run /build' },
    next: project ? [{ agent: 'CodeAgent', kind: 'code.deploy_local', input: { projectId: project.id, experimentId: expId } }] : [],
  };
};

// ───────────────────────── SalesAgent ─────────────────────────

const TemplateSchema = z.object({ subject: z.string().min(5).max(120), body: z.string().min(40).max(1500) });

const salesDraftCampaign: TaskHandler = async (ctx, input) => {
  const oppId = await resolveOpp(ctx, input);
  const opp = await ctx.core.opportunities.get(ctx.orgId, oppId);
  const product = await ctx.core.products.productForOpportunity(ctx.orgId, oppId);
  let subject = `Quick question about ${opp.signals.keywords[0] ?? 'your workflow'}, {{first_name}}`;
  let body = `Hi {{first_name}},\n\nYou recently showed interest in {{product}}. We're working on ${truncate(opp.problem, 200)}\n\nWould a 15-minute call to hear how you handle this today be useful? No sales pitch — we're validating the problem.\n\nThanks,\n{{sender}}`;
  let source = 'heuristic';
  if (ctx.router) {
    try {
      const { data } = await ctx.router.generateJson(
        {
          purpose: 'sales.draft',
          tier: 'fast',
          system: 'Write a short, honest, non-pushy outreach email to someone who opted in. Use merge fields {{first_name}}, {{product}}, {{sender}}. No false claims, no fake urgency, no statistics.',
          prompt: `Problem: ${truncate(opp.problem, 600)}\nCustomer: ${opp.customer}\nReturn {subject, body}.`,
          maxOutputTokens: 1200,
        },
        TemplateSchema,
        ctx.callCtx,
      );
      if (!scanForInjection(`${data.subject} ${data.body}`).suspicious) ({ subject, body } = data);
      source = 'model';
    } catch (e) {
      ctx.log.warn('Template generation failed', { error: errorMessage(e) });
    }
  }
  const campaign = await ctx.tool('campaign.draft', { opportunityId: oppId }, () =>
    ctx.core.campaigns.create(ctx.orgId, { name: `Outreach — ${truncate(opp.title, 60)}`, opportunityId: oppId, productId: product?.id as string | undefined, minLeadScore: Number(input.minLeadScore ?? 0), subjectTemplate: subject, bodyTemplate: body }, ctx.actor),
  );
  return {
    output: { campaignId: campaign.id, drafted: campaign.messages.length, stats: campaign.stats, templateSource: source },
    next: campaign.messages.length ? [{ agent: 'SalesAgent', kind: 'sales.request_send', input: { campaignId: campaign.id } }] : [],
  };
};

const salesRequestSend: TaskHandler = async (ctx, input) => {
  const id = String(input.campaignId);
  if (ctx.approvalId) {
    const c = await ctx.core.campaigns.get(ctx.orgId, id);
    return { output: { campaignId: id, status: c.status, stats: c.stats } };
  }
  const r = await ctx.tool('campaign.send', { campaignId: id }, () => ctx.core.campaigns.requestSend(ctx.orgId, id, ctx.actor, { taskId: ctx.task.id }));
  if (r.status === 'pending_approval') throw new ApprovalRequiredError(r.approvalId);
  return { output: { campaignId: id, ...r } };
};

// ───────────────────────── AnalyticsAgent ─────────────────────────

const analyticsEvaluate: TaskHandler = async (ctx) => {
  const org = await ctx.core.orgs.get(ctx.orgId);
  const m = await ctx.core.revenue.metrics(ctx.orgId, !org.isDemo);
  const results = await ctx.tool('experiment.evaluate', {}, () => ctx.core.experiments.evaluateAllRunning(ctx.orgId, ctx.actor, m.ltv));
  const decided = results.filter((r) => r.decision !== 'CONTINUE');
  const memory = [];
  for (const d of decided) {
    const exp = await ctx.core.experiments.get(ctx.orgId, d.id);
    const s = exp.decisionRationale?.stats;
    memory.push({ kind: 'lesson' as const, scope: exp.opportunityId ?? undefined, content: `${d.decision}: "${exp.name}" converted ${s ? `${round(s.rate * 100, 2)}% of ${s.denominator}` : 'n/a'}. ${exp.decisionRationale?.reasons[0] ?? ''}`, importance: 0.9 });
  }
  return { output: { evaluated: results.length, decisions: results }, memory };
};

const analyticsReport: TaskHandler = async (ctx) => {
  const r = await ctx.tool('report.generate', {}, () => ctx.core.reports.generateDaily(ctx.orgId));
  return { output: { reportId: r.id, recommendations: r.content.recommendations.length } };
};

const analyticsLearn: TaskHandler = async (ctx) => {
  const r = await ctx.tool('strategy.learn', {}, () => ctx.core.strategy.recalibrate(ctx.orgId, ctx.actor));
  const sources = await ctx.core.strategy.updateSourceQuality(ctx.orgId);
  return { output: { recalibration: r, sourceQuality: sources } };
};

// ───────────────────────── Registry ─────────────────────────

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  { name: 'ResearchAgent', description: 'Collects public market data from configured sources and turns pain signals into opportunities.', tools: ['connectors.search', 'opportunity.write', 'opportunity.read'], budget: { maxCostPerTaskUsd: 0.5, dailyCostUsd: 3 }, timeoutMs: 300_000, retry: { maxAttempts: 3, backoffMs: 5000, factor: 3 }, modelTier: 'balanced', handlers: { 'research.discover': researchDiscover } },
  { name: 'MarketAgent', description: 'Market sizing, competition and business-model hypotheses.', tools: ['analysis.run', 'opportunity.read', 'opportunity.write'], budget: DEFAULT_BUDGET, timeoutMs: 180_000, retry: DEFAULT_RETRY, modelTier: 'deep', handlers: { 'market.analyze': marketAnalyze } },
  { name: 'CustomerAgent', description: 'Ideal-customer profiles and transparent lead scoring (never contacts anyone).', tools: ['leads.score', 'opportunity.read'], budget: DEFAULT_BUDGET, timeoutMs: 120_000, retry: DEFAULT_RETRY, modelTier: 'fast', handlers: { 'customer.profile': customerProfile, 'customer.score_leads': customerScoreLeads } },
  { name: 'ProductAgent', description: 'Turns the selected hypothesis into an MVP specification.', tools: ['hypothesis.select', 'opportunity.read'], budget: DEFAULT_BUDGET, timeoutMs: 120_000, retry: DEFAULT_RETRY, modelTier: 'deep', handlers: { 'product.spec': productSpec } },
  { name: 'CodeAgent', description: 'Generates MVP code from vetted templates, tests it in the sandbox, deploys local previews and requests production deploys.', tools: ['code.generate', 'deploy.local', 'deploy.production'], budget: DEFAULT_BUDGET, timeoutMs: 240_000, retry: { maxAttempts: 2, backoffMs: 5000, factor: 2 }, modelTier: 'deep', handlers: { 'code.generate': codeGenerate, 'code.deploy_local': codeDeployLocal, 'code.request_production': codeRequestProduction } },
  { name: 'GrowthAgent', description: 'Designs and starts experiments with pre-registered thresholds; spend is approval-gated.', tools: ['experiment.manage', 'opportunity.read'], budget: DEFAULT_BUDGET, timeoutMs: 120_000, retry: DEFAULT_RETRY, modelTier: 'fast', handlers: { 'growth.design_experiment': growthDesignExperiment, 'growth.start_experiment': growthStartExperiment } },
  { name: 'SalesAgent', description: 'Drafts consent-aware outreach; sending always goes through the approval policy.', tools: ['campaign.draft', 'campaign.send', 'leads.score'], budget: DEFAULT_BUDGET, timeoutMs: 120_000, retry: DEFAULT_RETRY, modelTier: 'fast', handlers: { 'sales.draft_campaign': salesDraftCampaign, 'sales.request_send': salesRequestSend } },
  { name: 'FinanceAgent', description: 'Unit-economics review, portfolio allocation and cash-flow projections (recommendations only; never moves money).', tools: ['finance.analyze', 'hypothesis.select', 'opportunity.read'], budget: DEFAULT_BUDGET, timeoutMs: 120_000, retry: DEFAULT_RETRY, modelTier: 'balanced', handlers: { 'finance.review': financeReview, 'finance.allocate': financeAllocate } },
  { name: 'AnalyticsAgent', description: 'Evaluates experiments, writes daily reports and recalibrates strategy from outcomes.', tools: ['experiment.evaluate', 'report.generate', 'strategy.learn', 'alerts.raise'], budget: DEFAULT_BUDGET, timeoutMs: 180_000, retry: DEFAULT_RETRY, modelTier: 'fast', handlers: { 'analytics.evaluate_experiments': analyticsEvaluate, 'analytics.daily_report': analyticsReport, 'analytics.learn': analyticsLearn } },
  { name: 'RiskAgent', description: 'Regulatory / ethical risk screening and prompt-injection review of evidence.', tools: ['opportunity.write', 'opportunity.read', 'alerts.raise'], budget: DEFAULT_BUDGET, timeoutMs: 120_000, retry: DEFAULT_RETRY, modelTier: 'balanced', handlers: { 'risk.assess': riskAssess } },
  { name: 'SecurityAgent', description: 'Reviews generated builds, verifies the audit chain and reports security posture.', tools: ['security.audit', 'alerts.raise'], budget: DEFAULT_BUDGET, timeoutMs: 120_000, retry: DEFAULT_RETRY, modelTier: 'fast', handlers: { 'security.review_build': securityReviewBuild, 'security.audit': securityAudit } },
];

export const AGENTS = new Map<AgentName, AgentDefinition>(AGENT_DEFINITIONS.map((d) => [d.name, d]));

export function agentForKind(kind: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS.find((d) => kind in d.handlers);
}

export class NonRetryableError extends AppError {
  constructor(message: string) {
    super(message, { status: 400, code: 'NON_RETRYABLE', retryable: false });
  }
}
