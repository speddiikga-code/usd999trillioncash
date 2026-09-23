/**
 * End-to-end: the first-run experience over a real HTTP socket, driven the way the CLI and the
 * dashboard drive it. Nothing is called in-process except the worker loop (`orchestrator.drain()`,
 * the same code path the worker process runs).
 *
 *   register → onboarding → API key → /research → /analyze → /build (generated MVP, sandbox tests)
 *   → /experiment (budget → approval) → approve → preview deployed → simulated visitors hit the
 *   generated MVP, which forwards events to ROOS → evaluate → leads → Stripe-verified revenue
 *   → report → roadmap → audit chain verified.
 *
 * Offline: connectors are served from fixtures and the AI provider is the deterministic mock.
 */
import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Orchestrator } from '@roos/agents';
import { signStripePayload } from '@roos/billing';
import { clearConnectorCache } from '@roos/connectors';
import { createTestCore, fixtureFetcher, type Core } from '@roos/core';
import { createApi } from '../apps/api/src/app';
import { DISCOVERY_ROUTES } from '../packages/core/test/fixtures';

const WEBHOOK_SECRET = 'whsec_e2e';

let core: Core;
let orchestrator: Orchestrator;
let close: () => Promise<void>;
let base = '';
let apiKey = '';
let orgId = '';
let orgSlug = '';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Json = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, headers: res.headers };
}

/** Run a command through the API and let the worker loop finish its workflow. */
async function command(cmd: string) {
  const r = await call('POST', '/api/commands', { command: cmd });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  await orchestrator.drain();
  const wf = await call('GET', `/api/workflows/${r.json.workflowId}`);
  return wf.json.tasks as { id: string; agent: string; kind: string; status: string; output: Json; approvalId?: string }[];
}

beforeAll(async () => {
  clearConnectorCache();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  core = await createTestCore({
    connectorFetch: fixtureFetcher(DISCOVERY_ROUTES),
    env: {
      API_PUBLIC_URL: base, // the generated MVP forwards its funnel events here
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      DEPLOY_PORT_START: '5250',
      DEPLOY_PORT_END: '5269',
    },
  });
  const built = await createApi(core);
  orchestrator = built.orchestrator;
  close = built.close;
  await built.app.listen({ port, host: '127.0.0.1' });
});

afterAll(async () => {
  await close?.();
  await core?.db.close();
});

describe('first-run experience over HTTP', () => {
  let oppId = '';
  let experimentId = '';
  let previewUrl = '';
  let deploymentId = '';

  it('1. registers the first user, completes onboarding and issues an API key', async () => {
    expect((await call('GET', '/api/auth/state')).json).toMatchObject({ hasUsers: false, authenticated: false });
    const reg = await call('POST', '/api/auth/register', { email: 'founder@example.com', password: 'correct horse battery', name: 'Founder', orgName: 'E2E Ventures' });
    expect(reg.status).toBe(201);
    orgId = reg.json.orgId;
    const cookie = (reg.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const session = { cookie, 'x-csrf-token': reg.json.csrfToken, 'x-org-id': orgId };

    const org = await call('PATCH', '/api/org', { constraints: { initialCapitalUsd: 2000, monthlyBudgetUsd: 300, hoursPerWeek: 10, riskTolerance: 'low' }, industries: ['finance operations'] }, session);
    expect(org.status).toBe(200);
    expect(org.json.onboarding).toBeTruthy();

    const key = await call('POST', '/api/api-keys', { name: 'e2e-cli', role: 'admin' }, session);
    expect(key.status).toBe(201);
    apiKey = key.json.key;
    expect(apiKey).toMatch(/^roos_/);
    orgSlug = (await call('GET', '/api/org')).json.slug;
    expect(orgSlug).toBeTruthy();
  });

  it('2. /research discovers opportunities with provenance-labelled evidence', async () => {
    const tasks = await command('/research "invoice reconciliation" sources=hackernews,stackexchange,federal_register');
    expect(tasks.find((t) => t.agent === 'ResearchAgent')!.status).toBe('succeeded');
    const list = (await call('GET', '/api/opportunities')).json;
    const opp = list.items.find((o: Json) => /invoice|reconcil/i.test(o.title + ' ' + o.signals.keywords.join(' ')));
    expect(opp).toBeTruthy();
    oppId = opp.id;

    const d = (await call('GET', `/api/opportunities/${oppId}`)).json;
    const observed = d.evidence.filter((e: Json) => e.kind === 'OBSERVED');
    expect(observed.length).toBeGreaterThan(0);
    for (const e of observed) {
      expect(e.sourceUrl).toMatch(/^https:\/\//);
      expect(e.provenance.retrievedAt).toBeTruthy();
      expect(e.confidence).toBeGreaterThan(0);
    }
    // Estimates are never presented as observations.
    expect(['MODEL_ASSUMPTION', 'ESTIMATED']).toContain(d.estimatedMarketSize.kind);
    expect(d.scoreBreakdown.low).toBeLessThanOrEqual(d.score);
    expect(d.scoreBreakdown.high).toBeGreaterThanOrEqual(d.score);
  });

  it('3. /analyze produces several business hypotheses and selects one', async () => {
    const tasks = await command(`/analyze ${oppId}`);
    expect(tasks.every((t) => t.status === 'succeeded')).toBe(true);
    const d = (await call('GET', `/api/opportunities/${oppId}`)).json;
    expect(d.hypotheses.length).toBeGreaterThanOrEqual(2);
    expect(d.selectedHypothesisId).toBeTruthy();
  });

  it('4. /build generates an MVP that passes its own tests in the sandbox', async () => {
    const tasks = await command(`/build ${oppId}`);
    expect(tasks.map((t) => `${t.kind}:${t.status}`)).toEqual(['product.spec:succeeded', 'code.generate:succeeded', 'security.review_build:succeeded']);
    const projects = (await call('GET', '/api/projects')).json;
    const project = projects.find((p: Json) => p.opportunityId === oppId);
    expect(project.status).toBe('tests_passed');
  });

  it('5. /experiment with a budget waits for human approval, then deploys the preview', async () => {
    const tasks = await command(`/experiment ${oppId} budget=60 minSample=40`);
    const start = tasks.find((t) => t.kind === 'growth.start_experiment')!;
    expect(start.status).toBe('waiting_approval');

    const pending = (await call('GET', '/api/approvals?status=pending')).json;
    const approval = pending.find((a: Json) => a.id === start.approvalId);
    // The approval center shows WHAT / WHY / BENEFIT / COST / RISK / DATA SOURCES / REVERSIBILITY.
    expect(approval).toMatchObject({ actionType: 'spend.commit', expectedCostUsd: 60 });
    for (const field of ['what', 'why', 'expectedBenefit', 'risk', 'reversibility']) expect(approval[field], field).toBeTruthy();
    expect(Array.isArray(approval.dataSources)).toBe(true);

    // Nothing ran before the decision.
    expect((await call('GET', '/api/deployments')).json.filter((d: Json) => d.status === 'running')).toHaveLength(0);

    const decided = await call('POST', `/api/approvals/${approval.id}/approve`, { note: 'e2e approve' });
    expect(decided.json.status).toBe('executed');
    await orchestrator.drain();
    const resumed = (await call('GET', `/api/tasks/${start.id}`)).json;
    expect((resumed.task ?? resumed).status).toBe('succeeded');
    const deployments = (await call('GET', '/api/deployments')).json.filter((d: Json) => d.status === 'running');
    expect(deployments).toHaveLength(1);
    previewUrl = deployments[0].url;
    deploymentId = deployments[0].id;
    experimentId = (await call('GET', '/api/experiments')).json.find((e: Json) => e.opportunityId === oppId).id;
    expect((await call('GET', `/api/experiments/${experimentId}`)).json.experiment.status).toBe('running');
  });

  it('6. real HTTP traffic to the generated MVP is measured by ROOS (bots excluded)', async () => {
    const page = await (await fetch(previewUrl)).text();
    expect(page).toContain('"variants":["a","b"]');
    const ua = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) e2e' };
    for (let i = 0; i < 60; i++) {
      const variant = i % 2 ? 'a' : 'b';
      const ev = await fetch(`${previewUrl}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...ua }, body: JSON.stringify({ event: 'page_view', anonymousId: `visitor-${i}`, variant }) });
      expect(ev.status).toBe(202);
      if (i % 5 === 0) {
        const su = await fetch(`${previewUrl}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json', ...ua }, body: JSON.stringify({ email: `visitor${i}@example.com`, name: `Visitor ${i}`, anonymousId: `visitor-${i}`, variant }) });
        expect(su.status).toBe(201);
      }
    }
    // A crawler hitting the MVP is forwarded with its user agent and excluded.
    await fetch(`${previewUrl}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Googlebot/2.1' }, body: JSON.stringify({ event: 'page_view', anonymousId: 'crawler', variant: 'a' }) });

    const detail = (await call('GET', `/api/experiments/${experimentId}`)).json;
    expect(detail.stages[0].count).toBe(60);

    const evaluated = (await call('POST', `/api/experiments/${experimentId}/evaluate`)).json;
    expect(evaluated.stats.denominator).toBe(60);
    expect(evaluated.stats.numerator).toBe(12);
    expect(evaluated.decision).toBe('SCALE'); // 20% observed vs a pre-registered 5% target
    expect(evaluated.reasons.length).toBeGreaterThan(0);

    // Signups became consented inbound leads — no scraped or invented contacts.
    const leads = (await call('GET', '/api/leads')).json;
    const inbound = leads.filter((l: Json) => l.consentBasis === 'inbound');
    expect(inbound).toHaveLength(12);
  });

  it('7. only signature-verified payment events count as verified revenue', async () => {
    const manual = await call('POST', '/api/revenue/events', { type: 'charge', amountUsd: 300, description: 'bank transfer (self-reported)' });
    expect(manual.status).toBe(201);
    let summary = (await call('GET', '/api/revenue')).json;
    expect(summary.verified.revenueTotal).toBe(0);
    expect(summary.reported.revenueTotal).toBe(300);

    const evt = JSON.stringify({ id: 'evt_e2e_1', type: 'invoice.paid', created: Math.floor(Date.now() / 1000), data: { object: { id: 'in_e2e_1', amount_paid: 4900, currency: 'usd', customer: 'cus_e2e' } } });
    const forged = await call('POST', `/api/webhooks/stripe/${orgSlug}`, evt, { 'stripe-signature': signStripePayload(evt, 'whsec_wrong') });
    expect(forged.status).toBe(403);
    const ok = await call('POST', `/api/webhooks/stripe/${orgSlug}`, evt, { 'stripe-signature': signStripePayload(evt, WEBHOOK_SECRET) });
    expect(ok.status).toBe(200);
    summary = (await call('GET', '/api/revenue')).json;
    expect(summary.verified.revenueTotal).toBe(49);
    expect(summary.reported.revenueTotal).toBe(349);
  });

  it('8. financial actions cannot be raised above their policy ceiling', async () => {
    const trade = await call('PUT', '/api/policies', { action: 'financial.trade', mode: 'AUTONOMOUS' });
    expect(trade.status).toBeGreaterThanOrEqual(400);
    const payment = await call('PUT', '/api/policies', { action: 'financial.payment', mode: 'AUTONOMOUS' });
    expect(payment.status).toBeGreaterThanOrEqual(400);
  });

  it('9. /report, the roadmap and the audit chain reflect what happened', async () => {
    const tasks = await command('/report');
    expect(tasks[0]!.status).toBe('succeeded');
    const reports = (await call('GET', '/api/reports')).json;
    expect(reports.length).toBeGreaterThanOrEqual(1);

    const roadmap = (await call('GET', '/api/roadmap')).json;
    // A one-off verified payment is not extrapolated into ARR: with no verified subscription the
    // starting point stays an explicitly hypothetical assumption.
    expect(roadmap.current.verifiedArrUsd).toBe(0);
    expect(roadmap.current.startingArrIsHypothetical).toBe(true);
    expect(JSON.stringify(roadmap)).toMatch(/not a (forecast|guarantee|promise)/i);

    const audit = (await call('GET', '/api/audit')).json;
    const actions = new Set(audit.map((a: Json) => a.action));
    for (const a of ['command.research', 'command.build', 'deploy.local']) expect(actions, a).toContain(a);
    expect((await call('GET', '/api/audit/verify')).json.valid).toBe(true);

    expect((await call('POST', `/api/deployments/${deploymentId}/stop`)).status).toBe(200);
    await expect(fetch(previewUrl, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  });
});
