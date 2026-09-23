import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearConnectorCache } from '@roos/connectors';
import { createTestCore, fixtureFetcher, type Core } from '@roos/core';
import { AppError, sleep } from '@roos/shared';
import { AGENTS, CommandCenter, Orchestrator, parseCommand, Scheduler } from '../src';
import { DISCOVERY_ROUTES } from '../../core/test/fixtures';

let core: Core;
let orch: Orchestrator;
let cc: CommandCenter;
let orgId: string;
let userId: string;
const actor = () => ({ type: 'user' as const, id: userId });

beforeAll(async () => {
  clearConnectorCache();
  core = await createTestCore({ connectorFetch: fixtureFetcher(DISCOVERY_ROUTES) });
  const r = await core.auth.register({ email: 'ops@example.com', password: 'correct horse battery', name: 'Ops', orgName: 'Ops Co' });
  orgId = r.org.id;
  userId = r.userId;
  orch = new Orchestrator(core, { workerId: 'test-worker' });
  cc = new CommandCenter(core, orch);
});
afterAll(async () => {
  await core.products.deployer.stopAll();
  await core?.db.close();
});

describe('command parsing', () => {
  it('parses commands, quoted arguments and options', () => {
    expect(parseCommand('/research "find underserved B2B AI opportunities" sources=hackernews,github')).toMatchObject({ name: 'research', arg: 'find underserved B2B AI opportunities', options: { sources: 'hackernews,github' } });
    expect(parseCommand('/analyze opp_123')).toMatchObject({ name: 'analyze', arg: 'opp_123' });
    expect(parseCommand('/experiment opp_1 budget=300')).toMatchObject({ arg: 'opp_1', options: { budget: '300' } });
    expect(() => parseCommand('research x')).toThrow(/start with/);
    expect(() => parseCommand('/destroy everything')).toThrow(/Unknown command/);
  });
});

describe('end-to-end agent workflows', () => {
  let oppId: string;

  it('/research runs ResearchAgent then RiskAgent tasks in one workflow', async () => {
    const r = await cc.execute(orgId, parseCommand('/research "invoice reconciliation" sources=hackernews,stackexchange,federal_register'), actor());
    expect(r.tasks).toHaveLength(1);
    const done = await orch.drain();
    expect(done.map((t) => `${t.agent}:${t.status}`)).toContain('ResearchAgent:succeeded');
    expect(done.filter((t) => t.agent === 'RiskAgent').every((t) => t.status === 'succeeded')).toBe(true);
    expect(done.every((t) => t.workflowId === r.workflowId)).toBe(true);
    const opps = await core.opportunities.list(orgId);
    oppId = opps.items.find((o) => /invoice|reconcil/i.test(o.title + o.signals.keywords.join(' ')))!.id;
    const detail = await orch.detail(orgId, done[0]!.id);
    expect(detail.spans.some((s) => (s as { name: string }).name === 'tool:connectors.search')).toBe(true);
    const mem = await core.db.many('SELECT * FROM agent_memory WHERE org_id = $1 AND agent = $2', [orgId, 'ResearchAgent']);
    expect(mem.length).toBe(1);
  });

  it('/analyze fans out to Risk, Finance and Customer agents and selects a hypothesis', async () => {
    await cc.execute(orgId, parseCommand(`/analyze ${oppId}`), actor());
    const done = await orch.drain();
    expect(new Set(done.map((t) => t.agent))).toEqual(new Set(['MarketAgent', 'RiskAgent', 'FinanceAgent', 'CustomerAgent']));
    expect(done.every((t) => t.status === 'succeeded')).toBe(true);
    const finance = done.find((t) => t.agent === 'FinanceAgent')!;
    expect((finance.output as { recommended: { id: string } }).recommended.id).toBeTruthy();
  });

  it('/build generates, sandbox-tests and security-reviews an MVP', async () => {
    await cc.execute(orgId, parseCommand(`/build ${oppId}`), actor());
    const done = await orch.drain();
    expect(done.map((t) => t.kind)).toEqual(['product.spec', 'code.generate', 'security.review_build']);
    const code = done.find((t) => t.kind === 'code.generate')!;
    expect(code.status).toBe('succeeded');
    expect((code.output as { status: string }).status).toBe('tests_passed');
    expect((done[2]!.output as { approvedForPreview: boolean }).approvedForPreview).toBe(true);
  });

  it('/experiment with a budget pauses for approval, resumes after approval and deploys the preview', async () => {
    await cc.execute(orgId, parseCommand(`/experiment ${oppId} budget=150`), actor());
    let done = await orch.drain();
    const start = done.find((t) => t.kind === 'growth.start_experiment')!;
    expect(start.status).toBe('waiting_approval');
    const approval = await core.approvals.get(orgId, start.approvalId!);
    expect(approval).toMatchObject({ actionType: 'spend.commit', expectedCostUsd: 150, status: 'pending', taskId: start.id });

    await core.approvals.approve(orgId, approval.id, actor());
    done = await orch.drain();
    const resumed = done.find((t) => t.id === start.id)!;
    expect(resumed.status).toBe('succeeded');
    expect((resumed.output as { status: string }).status).toBe('running');
    const deploy = done.find((t) => t.kind === 'code.deploy_local')!;
    expect(deploy.status).toBe('succeeded');
    const url = (deploy.output as { url: string }).url;
    const page = await (await fetch(url)).text();
    expect(page).toContain('"variants":["a","b"]');
    await core.products.deployer.stopAll();
  });
});

describe('guardrails', () => {
  it('denies tools that are not on the agent allow-list', async () => {
    await orch.updateAgent(orgId, 'RiskAgent', { tools: ['opportunity.read'] }, userId);
    const opp = (await core.opportunities.list(orgId)).items[0]!;
    await orch.enqueue(orgId, { agent: 'RiskAgent', kind: 'risk.assess', input: { opportunityId: opp.id }, createdBy: userId });
    const [t] = await orch.drain();
    expect(t!.status).toBe('failed');
    expect(t!.error).toMatch(/not permitted to use tool "opportunity.write"/);
    const denied = await core.audit.list(orgId, { action: 'tool.opportunity.write' });
    expect(denied.some((a) => a.outcome === 'denied')).toBe(true);
    await orch.updateAgent(orgId, 'RiskAgent', { tools: ['opportunity.write', 'opportunity.read', 'alerts.raise'] }, userId);
  });

  it('pauses generic tools whose policy requires approval, and cancels the task on rejection', async () => {
    await core.policy.apply(orgId, 'code.generate', 'REQUIRE_APPROVAL', {}, actor());
    const hyp = (await core.analysis.bestHypothesis(orgId, (await core.opportunities.list(orgId)).items[0]!.id))!;
    await orch.enqueue(orgId, { agent: 'CodeAgent', kind: 'code.generate', input: { opportunityId: hyp.opportunityId, hypothesisId: hyp.id }, createdBy: userId });
    let [t] = await orch.drain();
    expect(t!.status).toBe('waiting_approval');
    await core.approvals.reject(orgId, t!.approvalId!, actor(), 'not now');
    t = await orch.get(orgId, t!.id);
    expect(t.status).toBe('cancelled');
    await core.policy.apply(orgId, 'code.generate', 'AUTONOMOUS', {}, actor());
  });

  it('retries transient failures with backoff and fails permanently after max attempts', async () => {
    let calls = 0;
    AGENTS.get('AnalyticsAgent')!.handlers['test.flaky'] = async () => {
      calls++;
      if (calls < 2) throw new Error('transient network glitch');
      return { output: { ok: true, calls } };
    };
    AGENTS.get('AnalyticsAgent')!.handlers['test.broken'] = async () => {
      throw new AppError('bad input', { status: 400, retryable: false });
    };
    const flaky = await orch.enqueue(orgId, { agent: 'AnalyticsAgent', kind: 'test.flaky', input: {}, createdBy: userId });
    await orch.drain();
    let t = await orch.get(orgId, flaky.id);
    expect(t.status).toBe('queued');
    expect(t.error).toMatch(/transient/);
    await core.db.query(`UPDATE agent_tasks SET run_after = now() WHERE id = $1`, [flaky.id]);
    await orch.drain();
    t = await orch.get(orgId, flaky.id);
    expect(t.status).toBe('succeeded');
    expect(t.attempts).toBe(2);

    const broken = await orch.enqueue(orgId, { agent: 'AnalyticsAgent', kind: 'test.broken', input: {}, createdBy: userId });
    await orch.drain();
    expect((await orch.get(orgId, broken.id)).status).toBe('failed');
    expect((await orch.get(orgId, broken.id)).attempts).toBe(1);
  });

  it('times out long-running tasks', async () => {
    AGENTS.get('AnalyticsAgent')!.handlers['test.slow'] = async (ctx) => {
      await sleep(2000);
      return { output: { aborted: ctx.signal.aborted } };
    };
    await orch.updateAgent(orgId, 'AnalyticsAgent', { timeoutMs: 100 }, userId);
    await core.db.query(`UPDATE agents SET retry_policy = '{"maxAttempts":1,"backoffMs":10,"factor":1}' WHERE org_id = $1 AND name = 'AnalyticsAgent'`, [orgId]);
    const t0 = await orch.enqueue(orgId, { agent: 'AnalyticsAgent', kind: 'test.slow', input: {}, createdBy: userId });
    await orch.drain();
    const t = await orch.get(orgId, t0.id);
    expect(t.status).toBe('timed_out');
    expect(t.error).toMatch(/timed out/);
    await orch.updateAgent(orgId, 'AnalyticsAgent', { timeoutMs: 180_000 }, userId);
  });

  it('enforces per-agent daily budgets', async () => {
    await orch.updateAgent(orgId, 'SecurityAgent', { budget: { dailyCostUsd: 0 } }, userId);
    const t0 = await orch.enqueue(orgId, { agent: 'SecurityAgent', kind: 'security.audit', input: {}, createdBy: userId });
    await orch.drain();
    const t = await orch.get(orgId, t0.id);
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/budget exhausted/);
    await orch.updateAgent(orgId, 'SecurityAgent', { budget: { dailyCostUsd: 2 } }, userId);
  });

  it('recovers tasks whose worker died', async () => {
    const t0 = await orch.enqueue(orgId, { agent: 'SecurityAgent', kind: 'security.audit', input: {}, createdBy: userId });
    await core.db.query(`UPDATE agent_tasks SET status = 'running', attempts = 1, locked_at = now() - interval '1 hour', locked_by = 'dead-worker' WHERE id = $1`, [t0.id]);
    expect(await orch.requeueStale()).toBeGreaterThanOrEqual(1);
    await orch.drain();
    const t = await orch.get(orgId, t0.id);
    expect(t.status).toBe('succeeded');
    expect((t.output as { auditChain: { valid: boolean } }).auditChain.valid).toBe(true);
  });

  it('schedules periodic work idempotently', async () => {
    const s = new Scheduler(core, orch, core.cfg, core.logger);
    const at = new Date(Date.UTC(2026, 8, 23, core.cfg.scheduler.dailyReportHourUtc, 5));
    await s.tick(at);
    await s.tick(at);
    const reports = await orch.list(orgId, { agent: 'AnalyticsAgent' });
    expect(reports.filter((t) => t.kind === 'analytics.daily_report' && t.status === 'queued')).toHaveLength(1);
    expect(reports.filter((t) => t.kind === 'analytics.evaluate_experiments' && t.status === 'queued')).toHaveLength(1);
  });

  it('answers /status synchronously with health, KPIs and approvals', async () => {
    const r = await cc.execute(orgId, parseCommand('/status'), actor());
    expect(r.message).toMatch(/System:/);
    expect(r.message).toMatch(/Verified MRR/);
  });
});
