import type { Actor, Core } from '@roos/core';
import { newId, ValidationError, type AgentName } from '@roos/shared';
import type { Orchestrator } from './orchestrator';

export type CommandName = 'research' | 'analyze' | 'build' | 'launch' | 'experiment' | 'growth' | 'finance' | 'audit' | 'status' | 'report' | 'help';

export interface ParsedCommand {
  name: CommandName;
  arg?: string;
  options: Record<string, string>;
  raw: string;
}

/** Permission required to run each command (checked by the API layer). */
export const COMMAND_PERMISSIONS: Record<CommandName, string> = {
  research: 'research:run',
  analyze: 'research:run',
  build: 'build:run',
  launch: 'deploy:run',
  experiment: 'experiment:write',
  growth: 'campaign:write',
  finance: 'revenue:read',
  audit: 'audit:read',
  status: 'org:read',
  report: 'report:read',
  help: 'org:read',
};

export const COMMAND_HELP: Record<CommandName, string> = {
  research: '/research "topic or question"  [sources=hackernews,stackexchange,github,federal_register] — discover opportunities from public data',
  analyze: '/analyze <opportunity-id>  — market sizing, competition, business-model hypotheses, risk & unit economics',
  build: '/build <opportunity-id> [hypothesis=<id>]  — generate the MVP, scan it and run its tests in the sandbox',
  launch: '/launch <opportunity-id> [production=true]  — local preview deployment; production requires approval',
  experiment: '/experiment <opportunity-id> [budget=0] [minSample=200]  — design & start an A/B landing-page experiment',
  growth: '/growth <opportunity-id>  — score leads and draft consent-aware outreach (sending requires approval)',
  finance: '/finance [budget=1000]  — portfolio allocation (Thompson sampling) and cash-flow projection',
  audit: '/audit  — verify the audit hash-chain and review security posture',
  status: '/status  — system health, KPIs, queue and pending approvals',
  report: '/report  — generate the daily report now',
  help: '/help  — list commands',
};

export function parseCommand(text: string): ParsedCommand {
  const raw = text.trim();
  const m = raw.match(/^\/([a-z]+)\s*([\s\S]*)$/i);
  if (!m) throw new ValidationError('Commands start with "/", e.g. /research "B2B invoicing"');
  const name = m[1]!.toLowerCase() as CommandName;
  if (!(name in COMMAND_HELP)) throw new ValidationError(`Unknown command /${name}. Try /help`);
  let rest = m[2]!.trim();
  const options: Record<string, string> = {};
  rest = rest.replace(/(\w+)=("[^"]*"|\S+)/g, (_, k: string, v: string) => {
    options[k] = v.replace(/^"|"$/g, '');
    return '';
  });
  rest = rest.trim();
  const quoted = rest.match(/^["“](.+?)["”]$/s);
  const arg = quoted ? quoted[1]!.trim() : rest || undefined;
  return { name, arg, options, raw };
}

export interface CommandResult {
  command: CommandName;
  message: string;
  workflowId?: string;
  tasks?: { id: string; agent: AgentName; kind: string }[];
  data?: unknown;
}

/** Turns commands into structured agent workflows (or answers them synchronously). */
export class CommandCenter {
  constructor(
    private core: Core,
    private orchestrator: Orchestrator,
  ) {}

  private async start(orgId: string, actor: Actor, cmd: ParsedCommand, steps: { agent: AgentName; kind: string; input: Record<string, unknown>; priority?: number }[], message: string): Promise<CommandResult> {
    const workflowId = newId('workflow');
    const tasks = [];
    for (const s of steps) {
      const t = await this.orchestrator.enqueue(orgId, { ...s, workflowId, createdBy: actor.id, priority: s.priority ?? 10 });
      tasks.push({ id: t.id, agent: t.agent, kind: t.kind });
    }
    await this.core.audit.record({ orgId, actor, action: `command.${cmd.name}`, details: { raw: cmd.raw.slice(0, 500), workflowId } });
    return { command: cmd.name, message, workflowId, tasks };
  }

  async execute(orgId: string, cmd: ParsedCommand, actor: Actor): Promise<CommandResult> {
    const needOpp = async () => {
      if (!cmd.arg) throw new ValidationError(`/${cmd.name} needs an opportunity id. Try: ${COMMAND_HELP[cmd.name]}`);
      return this.core.opportunities.resolveId(orgId, cmd.arg);
    };
    switch (cmd.name) {
      case 'help':
        return { command: 'help', message: Object.values(COMMAND_HELP).join('\n'), data: COMMAND_HELP };
      case 'research': {
        if (!cmd.arg) throw new ValidationError('Usage: /research "topic or question"');
        const sources = cmd.options.sources?.split(',').map((s) => s.trim()).filter(Boolean);
        return this.start(orgId, actor, cmd, [{ agent: 'ResearchAgent', kind: 'research.discover', input: { query: cmd.arg, sources, limitPerSource: Number(cmd.options.limit ?? 30) } }], `Research started for "${cmd.arg}". New opportunities will appear as agents finish.`);
      }
      case 'analyze': {
        const id = await needOpp();
        return this.start(orgId, actor, cmd, [{ agent: 'MarketAgent', kind: 'market.analyze', input: { opportunityId: id } }], 'Analysis workflow started (market → risk → finance → customer).');
      }
      case 'build': {
        const id = await needOpp();
        return this.start(orgId, actor, cmd, [{ agent: 'ProductAgent', kind: 'product.spec', input: { opportunityId: id, hypothesisId: cmd.options.hypothesis } }], 'Build workflow started (spec → code generation → sandbox tests → security review).');
      }
      case 'launch': {
        const id = await needOpp();
        const project = await this.core.db.value<string>(`SELECT id FROM projects WHERE org_id = $1 AND opportunity_id = $2 ORDER BY created_at DESC LIMIT 1`, [orgId, id]);
        if (!project) throw new ValidationError('Nothing to launch yet — run /build first.');
        const steps: { agent: AgentName; kind: string; input: Record<string, unknown> }[] = [{ agent: 'CodeAgent', kind: 'code.deploy_local', input: { projectId: project } }];
        if (cmd.options.production === 'true') steps.push({ agent: 'CodeAgent', kind: 'code.request_production', input: { projectId: project } });
        return this.start(orgId, actor, cmd, steps, cmd.options.production === 'true' ? 'Local preview launching; production deployment requested (needs approval).' : 'Local preview deployment started.');
      }
      case 'experiment': {
        const id = await needOpp();
        return this.start(orgId, actor, cmd, [{ agent: 'GrowthAgent', kind: 'growth.design_experiment', input: { opportunityId: id, budgetUsd: Number(cmd.options.budget ?? 0), minSample: Number(cmd.options.minSample ?? 200) } }], 'Experiment design started. Budgets above $0 require approval before the experiment runs.');
      }
      case 'growth': {
        const id = await needOpp();
        return this.start(
          orgId,
          actor,
          cmd,
          [
            { agent: 'CustomerAgent', kind: 'customer.score_leads', input: { opportunityId: id } },
            { agent: 'SalesAgent', kind: 'sales.draft_campaign', input: { opportunityId: id, minLeadScore: Number(cmd.options.minScore ?? 0) } },
          ],
          'Lead scoring and outreach drafting started. Nothing is sent without approval.',
        );
      }
      case 'finance':
        return this.start(orgId, actor, cmd, [{ agent: 'FinanceAgent', kind: 'finance.allocate', input: { budgetUsd: cmd.options.budget ? Number(cmd.options.budget) : undefined } }], 'Portfolio allocation and cash-flow projection started (recommendations only).');
      case 'audit':
        return this.start(orgId, actor, cmd, [{ agent: 'SecurityAgent', kind: 'security.audit', input: {} }], 'Security audit started.');
      case 'report':
        return this.start(orgId, actor, cmd, [{ agent: 'AnalyticsAgent', kind: 'analytics.daily_report', input: {} }], 'Daily report generation started.');
      case 'status': {
        const [health, kpis, approvals, tasks] = await Promise.all([
          this.core.system.health(orgId),
          this.core.portfolio.kpis(orgId),
          this.core.approvals.list(orgId, 'pending'),
          this.orchestrator.list(orgId, { limit: 10 }),
        ]);
        const lines = [
          `System: ${health.status.toUpperCase()} · db ${health.database.kind} (${health.database.latencyMs}ms) · workers alive ${health.workers.filter((w) => w.alive).length} · queue ${health.queue?.queued ?? 0} queued / ${health.queue?.running ?? 0} running`,
          `${kpis.isDemo ? '[DEMO DATA] ' : ''}Opportunities ${kpis.totalOpportunities} (validated ${kpis.validatedOpportunities}) · experiments running ${kpis.activeExperiments} · products live ${kpis.productsLaunched}`,
          `${kpis.isDemo ? 'Demo' : 'Verified'} MRR $${kpis.mrr} · ARR $${kpis.arr} · customers ${kpis.customers} · pending approvals ${approvals.length}`,
          ...health.warnings.map((w) => `⚠ ${w}`),
        ];
        return { command: 'status', message: lines.join('\n'), data: { health, kpis, pendingApprovals: approvals.length, recentTasks: tasks } };
      }
    }
  }
}
