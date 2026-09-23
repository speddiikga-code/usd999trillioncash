import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { camelize, newId, round, type DecisionResult, type ScoreBreakdown } from '@roos/shared';
import type { EventBus } from './events';
import type { OrgService } from './orgs';
import type { RevenueService } from './revenue';

export interface Recommendation {
  priority: 'high' | 'medium' | 'low';
  action: string;
  command?: string;
  rationale: string;
  evidence: { type: string; id: string; detail: string }[];
}

/**
 * Daily report built exclusively from recorded data. Every recommendation cites the records
 * (opportunities, experiments, evaluations) that justify it; when there is no evidence, the report
 * says so instead of inventing activity.
 */
export class ReportService {
  constructor(
    private db: Db,
    private orgs: OrgService,
    private revenue: RevenueService,
    private events: EventBus,
  ) {}

  async generateDaily(orgId: string, periodEnd = new Date()) {
    const org = await this.orgs.get(orgId);
    const end = periodEnd;
    const start = new Date(end.getTime() - 86_400_000);
    const p = [orgId, start.toISOString(), end.toISOString()];

    const newOpps = await this.db.many<{ id: string; title: string; score: number | null; score_breakdown: ScoreBreakdown | null; evidence: number }>(
      `SELECT o.id, o.title, o.score, o.score_breakdown, (SELECT COUNT(*) FROM evidence e WHERE e.opportunity_id = o.id)::int AS evidence
       FROM opportunities o WHERE o.org_id = $1 AND o.created_at BETWEEN $2 AND $3 ORDER BY o.score DESC NULLS LAST LIMIT 10`,
      p,
    );
    const docsByConnector = await this.db.many<{ connector: string; n: number }>(`SELECT connector, COUNT(*)::int AS n FROM documents WHERE org_id = $1 AND fetched_at BETWEEN $2 AND $3 GROUP BY connector ORDER BY n DESC`, p);
    const regulatory = await this.db.many<{ title: string; url: string }>(
      `SELECT title, url FROM documents WHERE org_id = $1 AND fetched_at BETWEEN $2 AND $3 AND connector IN ('federal_register','sec_edgar') ORDER BY published_at DESC NULLS LAST LIMIT 5`,
      p,
    );
    const evaluations = await this.db.many<{ experiment_id: string; name: string; decision: string; result: DecisionResult }>(
      `SELECT DISTINCT ON (ev.experiment_id) ev.experiment_id, x.name, ev.decision, ev.result FROM experiment_evaluations ev JOIN experiments x ON x.id = ev.experiment_id
       WHERE ev.org_id = $1 AND ev.created_at BETWEEN $2 AND $3 ORDER BY ev.experiment_id, ev.created_at DESC`,
      p,
    );
    const verifiedOnly = !org.isDemo;
    const [mNow, mBefore] = await Promise.all([this.revenue.metrics(orgId, verifiedOnly, end), this.revenue.metrics(orgId, verifiedOnly, start)]);
    const custCounts = await this.db.one<{ leads: number; signups: number; customers: number; churned: number }>(
      `SELECT (SELECT COUNT(*) FROM leads WHERE org_id = $1 AND created_at BETWEEN $2 AND $3)::int AS leads,
              (SELECT COUNT(DISTINCT anonymous_id) FROM tracking_events WHERE org_id = $1 AND event = 'signup' AND NOT is_bot AND occurred_at BETWEEN $2 AND $3)::int AS signups,
              (SELECT COUNT(*) FROM customers WHERE org_id = $1 AND started_at BETWEEN $2 AND $3)::int AS customers,
              (SELECT COUNT(*) FROM customers WHERE org_id = $1 AND churned_at BETWEEN $2 AND $3)::int AS churned`,
      p,
    );
    const competitors = await this.db.many<{ label: string }>(`SELECT label FROM kg_nodes WHERE org_id = $1 AND type = 'competitor' AND created_at BETWEEN $2 AND $3 LIMIT 10`, p);
    const failures = await this.db.many<{ kind: string; error: string; n: number }>(
      `SELECT kind, MAX(error) AS error, COUNT(*)::int AS n FROM agent_tasks WHERE org_id = $1 AND status IN ('failed','timed_out') AND updated_at BETWEEN $2 AND $3 GROUP BY kind`,
      p,
    );
    const sourceErrors = await this.db.many<{ connector: string; last_error: string }>(`SELECT connector, last_error FROM sources WHERE org_id = $1 AND last_status = 'error' AND last_run_at BETWEEN $2 AND $3`, p);
    const modelErrors = Number(await this.db.value(`SELECT COUNT(*) FROM model_calls WHERE org_id = $1 AND status IN ('error','invalid_output') AND created_at BETWEEN $2 AND $3`, p));

    const recommendations = await this.recommendations(orgId);
    const content = {
      period: { start: start.toISOString(), end: end.toISOString() },
      isDemo: org.isDemo,
      marketChanges: { documentsByConnector: docsByConnector, regulatory },
      newOpportunities: newOpps.map((o) => ({ id: o.id, title: o.title, score: o.score, low: o.score_breakdown?.low ?? null, high: o.score_breakdown?.high ?? null, evidence: o.evidence })),
      experimentResults: evaluations.map((e) => ({ experimentId: e.experiment_id, name: e.name, decision: e.decision, rate: e.result.stats.rate, n: e.result.stats.denominator, reasons: e.result.reasons })),
      revenueChanges: {
        basis: verifiedOnly ? 'verified' : 'DEMO',
        mrrNow: mNow.mrr,
        mrr24hAgo: mBefore.mrr,
        mrrChange: round(mNow.mrr - mBefore.mrr, 2),
        revenueLast24h: round(mNow.revenueTotal - mBefore.revenueTotal, 2),
      },
      customerChanges: custCounts,
      competitiveChanges: competitors.map((c) => c.label),
      systemFailures: { tasks: failures, sources: sourceErrors, modelErrors },
      recommendations,
    };
    const markdown = this.toMarkdown(org.name, content);
    const id = newId('report');
    await this.db.query(`INSERT INTO reports (id, org_id, kind, period_start, period_end, title, content, markdown) VALUES ($1,$2,'daily',$3,$4,$5,$6,$7)`, [
      id,
      orgId,
      start.toISOString(),
      end.toISOString(),
      `Daily report — ${end.toISOString().slice(0, 10)}`,
      json(content),
      markdown,
    ]);
    await this.events.publish(orgId, 'report.generated', { entityType: 'report', entityId: id, payload: { kind: 'daily' } });
    return { id, content, markdown };
  }

  async recommendations(orgId: string): Promise<Recommendation[]> {
    const recs: Recommendation[] = [];
    const untested = await this.db.many<{ id: string; title: string; score: number; score_breakdown: ScoreBreakdown | null; evidence: number }>(
      `SELECT o.id, o.title, o.score, o.score_breakdown, (SELECT COUNT(*) FROM evidence e WHERE e.opportunity_id = o.id AND e.data_kind IN ('OBSERVED','DEMO'))::int AS evidence
       FROM opportunities o WHERE o.org_id = $1 AND o.status IN ('analyzed','validated','built','launched') AND o.score >= 0.45
         AND NOT EXISTS (SELECT 1 FROM experiments x WHERE x.opportunity_id = o.id AND x.status IN ('running','pending_approval','completed'))
       ORDER BY o.score DESC LIMIT 3`,
      [orgId],
    );
    for (const o of untested) {
      recs.push({
        priority: 'high',
        action: `Start a landing-page experiment for "${o.title}"`,
        command: `/experiment ${o.id}`,
        rationale: `Score ${round(o.score, 2)} (80% range ${round(o.score_breakdown?.low ?? o.score, 2)}–${round(o.score_breakdown?.high ?? o.score, 2)}) backed by ${o.evidence} observed evidence item(s), but no experiment has tested it.`,
        evidence: [{ type: 'opportunity', id: o.id, detail: `${o.evidence} evidence items` }],
      });
    }
    const unanalyzed = await this.db.many<{ id: string; title: string; score: number }>(
      `SELECT id, title, score FROM opportunities WHERE org_id = $1 AND status = 'discovered' AND score IS NOT NULL ORDER BY score DESC LIMIT 3`,
      [orgId],
    );
    for (const o of unanalyzed) {
      recs.push({ priority: 'medium', action: `Analyze "${o.title}"`, command: `/analyze ${o.id}`, rationale: `Discovered with score ${round(o.score, 2)}; market size, competition and business models are still priors.`, evidence: [{ type: 'opportunity', id: o.id, detail: 'status: discovered' }] });
    }
    const experiments = await this.db.many<{ id: string; name: string; decision: string | null; decision_rationale: DecisionResult | null; thresholds: { minSample: number }; started_at: Date | null; opportunity_id: string | null }>(
      `SELECT id, name, decision, decision_rationale, thresholds, started_at, opportunity_id FROM experiments WHERE org_id = $1 AND status IN ('running','paused','completed') AND updated_at > now() - interval '14 days'`,
      [orgId],
    );
    for (const x of experiments) {
      const s = x.decision_rationale?.stats;
      const ev = [{ type: 'experiment', id: x.id, detail: s ? `${s.numerator}/${s.denominator} (${round(s.rate * 100, 2)}%)` : 'not evaluated' }];
      if (x.decision === 'CONTINUE' && s && s.daysRunning >= 3 && s.denominator < x.thresholds.minSample * 0.2) {
        recs.push({ priority: 'high', action: `Drive traffic to "${x.name}"`, command: `/growth ${x.opportunity_id ?? ''}`.trim(), rationale: `Only ${s.denominator}/${x.thresholds.minSample} required observations after ${round(s.daysRunning, 1)} days — distribution is the bottleneck, not demand.`, evidence: ev });
      }
      if (x.decision === 'ITERATE') recs.push({ priority: 'medium', action: `Iterate on "${x.name}"`, rationale: x.decision_rationale?.reasons.join(' ') ?? '', evidence: ev });
      if (x.decision === 'SCALE') recs.push({ priority: 'high', action: `Request budget approval to scale "${x.name}"`, command: `/finance`, rationale: x.decision_rationale?.reasons.join(' ') ?? '', evidence: ev });
      if (x.decision === 'PAUSE') recs.push({ priority: 'high', action: `Review the paused experiment "${x.name}"`, rationale: x.decision_rationale?.reasons.join(' ') ?? '', evidence: ev });
    }
    const recentDocs = Number(await this.db.value(`SELECT COUNT(*) FROM documents WHERE org_id = $1 AND fetched_at > now() - interval '7 days'`, [orgId]));
    if (!recentDocs) recs.push({ priority: 'medium', action: 'Run an opportunity scan', command: '/research "<topic>"', rationale: 'No new market documents collected in the last 7 days.', evidence: [] });
    return recs;
  }

  private toMarkdown(orgName: string, c: any): string {
    const lines: string[] = [`# Daily report — ${orgName}`, `Period: ${c.period.start} → ${c.period.end}`, ''];
    if (c.isDemo) lines.push('> **DEMO DATA** — synthetic workspace. Figures are not real.', '');
    lines.push('## Market changes');
    lines.push(c.marketChanges.documentsByConnector.length ? c.marketChanges.documentsByConnector.map((d: any) => `- ${d.connector}: ${d.n} new documents`).join('\n') : '- No new documents collected.');
    if (c.marketChanges.regulatory.length) lines.push('', 'Regulatory activity:', ...c.marketChanges.regulatory.map((r: any) => `- [${r.title}](${r.url})`));
    lines.push('', '## New opportunities');
    lines.push(c.newOpportunities.length ? c.newOpportunities.map((o: any) => `- **${o.title}** — score ${o.score ?? 'n/a'} (${o.low ?? '?'}–${o.high ?? '?'}), ${o.evidence} evidence items (\`${o.id}\`)`).join('\n') : '- None.');
    lines.push('', '## Experiment results');
    lines.push(c.experimentResults.length ? c.experimentResults.map((e: any) => `- **${e.name}**: ${e.decision} — ${round(e.rate * 100, 2)}% of ${e.n}. ${e.reasons[0] ?? ''}`).join('\n') : '- No evaluations in this period.');
    lines.push('', `## Revenue changes (${c.revenueChanges.basis})`);
    lines.push(`- MRR: $${c.revenueChanges.mrr24hAgo} → $${c.revenueChanges.mrrNow} (${c.revenueChanges.mrrChange >= 0 ? '+' : ''}${c.revenueChanges.mrrChange})`, `- Revenue in period: $${c.revenueChanges.revenueLast24h}`);
    lines.push('', '## Customer changes', `- New leads: ${c.customerChanges.leads} · signups: ${c.customerChanges.signups} · new customers: ${c.customerChanges.customers} · churned: ${c.customerChanges.churned}`);
    lines.push('', '## Competitive changes', c.competitiveChanges.length ? c.competitiveChanges.map((x: string) => `- New competitor observed: ${x}`).join('\n') : '- None observed.');
    lines.push('', '## System failures');
    const f = c.systemFailures;
    if (!f.tasks.length && !f.sources.length && !f.modelErrors) lines.push('- None.');
    for (const t of f.tasks) lines.push(`- ${t.n}× task \`${t.kind}\` failed: ${String(t.error ?? '').slice(0, 160)}`);
    for (const s of f.sources) lines.push(`- Source ${s.connector}: ${String(s.last_error ?? '').slice(0, 160)}`);
    if (f.modelErrors) lines.push(`- ${f.modelErrors} model call error(s)`);
    lines.push('', '## Recommended next experiments / actions');
    lines.push(c.recommendations.length ? c.recommendations.map((r: Recommendation) => `- [${r.priority}] **${r.action}**${r.command ? ` — \`${r.command}\`` : ''}: ${r.rationale}`).join('\n') : '- No evidence-backed recommendation today.');
    return lines.join('\n') + '\n';
  }

  async list(orgId: string, limit = 30) {
    return (await this.db.many('SELECT id, kind, title, period_start, period_end, created_at FROM reports WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2', [orgId, limit])).map((r) => camelize(r));
  }

  async get(orgId: string, id: string) {
    const row = await this.db.one('SELECT * FROM reports WHERE id = $1 AND org_id = $2', [id, orgId]);
    return row ? camelize(row) : null;
  }
}
