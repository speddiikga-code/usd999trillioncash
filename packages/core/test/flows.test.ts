import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider, ModelRouter } from '@roos/ai';
import { signStripePayload } from '@roos/billing';
import { clearConnectorCache } from '@roos/connectors';
import { createTestCore, fixtureFetcher, seedDemo, type Core } from '../src';
import { DISCOVERY_ROUTES } from './fixtures';

let core: Core;
let orgId: string;
let userId: string;
const actor = () => ({ type: 'user' as const, id: userId });

beforeAll(async () => {
  clearConnectorCache();
  core = await createTestCore({ connectorFetch: fixtureFetcher(DISCOVERY_ROUTES), env: { STRIPE_WEBHOOK_SECRET: 'whsec_test', COMPANY_POSTAL_ADDRESS: '1 Test Street, Testville' } });
  const r = await core.auth.register({ email: 'founder@example.com', password: 'correct horse battery', name: 'Founder', orgName: 'Real Co' });
  orgId = r.org.id;
  userId = r.userId;
});
afterAll(async () => core?.db.close());

describe('opportunity discovery (heuristic, no AI provider)', () => {
  let oppId: string;

  it('turns observed pain signals into scored opportunities with provenance', async () => {
    const r = await core.discovery.scan(orgId, { query: 'find underserved invoice reconciliation opportunities', sources: ['hackernews', 'stackexchange', 'federal_register'], limitPerSource: 20 }, { actor: actor(), router: null });
    expect(r.synthesis).toBe('heuristic');
    expect(r.queries[0]).toBe('invoice reconciliation');
    expect(r.documentsStored).toBeGreaterThanOrEqual(7);
    expect(r.suspiciousDocuments).toBe(1);
    expect(r.opportunitiesCreated.length).toBeGreaterThanOrEqual(1);

    const list = await core.opportunities.list(orgId);
    const invoice = list.items.find((o) => /invoice|reconcil/i.test(o.title + o.signals.keywords.join(' ')))!;
    expect(invoice).toBeTruthy();
    oppId = invoice.id;
    const d = await core.opportunities.detail(orgId, oppId);
    expect(d.score).toBeGreaterThan(0);
    expect(d.scoreBreakdown!.low).toBeLessThanOrEqual(d.score!);
    expect(d.scoreBreakdown!.high).toBeGreaterThanOrEqual(d.score!);
    // Observed evidence with full provenance; quotes are verbatim from the source text.
    const observed = d.evidence.filter((e) => e.kind === 'OBSERVED');
    expect(observed.length).toBeGreaterThanOrEqual(3);
    for (const e of observed) {
      expect(e.sourceUrl).toMatch(/^https:\/\//);
      expect(e.provenance.connector).toBeTruthy();
      expect(e.provenance.retrievedAt).toBeTruthy();
    }
    // The prompt-injection document is kept as data but down-weighted.
    const injected = d.evidence.find((e) => Number(e.provenance.injectionScore) >= 0.5);
    if (injected) expect(injected.confidence).toBeLessThanOrEqual(0.3);
    // Estimates are labelled as assumptions, never as observed facts.
    expect(d.estimatedMarketSize!.kind).toBe('MODEL_ASSUMPTION');
    expect(d.estimatedPrice!.kind).toBe('ESTIMATED'); // derived from "$49/month" mentions
    expect(d.regulatoryRisk!.kind).toBe('ESTIMATED');
  });

  it('de-duplicates on re-scan (updates rather than creating duplicates)', async () => {
    clearConnectorCache();
    const before = (await core.opportunities.list(orgId)).total;
    const r = await core.discovery.scan(orgId, { query: 'invoice reconciliation', sources: ['hackernews', 'stackexchange'], limitPerSource: 20 }, { actor: actor(), router: null });
    expect(r.opportunitiesUpdated.length).toBeGreaterThanOrEqual(1);
    expect((await core.opportunities.list(orgId)).total).toBe(before + r.opportunitiesCreated.length);
  });

  it('analyzes an opportunity into multiple business-model hypotheses with unit economics', async () => {
    const r = await core.analysis.analyze(orgId, oppId, { actor: actor(), router: null });
    expect(r.hypotheses.length).toBe(3);
    const models = r.hypotheses.map((h) => h.model);
    expect(models).toContain('automation_service');
    for (const h of r.hypotheses) {
      expect(h.unitEconomics.ltv.value).toBeGreaterThan(0);
      expect(h.unitEconomics.ltv.low!).toBeLessThanOrEqual(h.unitEconomics.ltv.value);
      expect(h.mvpSpec.entities.length).toBeGreaterThan(0);
    }
    expect((await core.opportunities.get(orgId, oppId)).status).toBe('analyzed');
    const g = await core.graph.graph(orgId);
    expect(g.nodes.some((n) => n.type === 'business_model')).toBe(true);
  });

  it('with a model: keeps only claims whose quotes are verbatim in the cited document', async () => {
    clearConnectorCache();
    const fresh = await core.orgs.create('Model test org');
    const quote = 'breaks our production deploys weekly';
    // Find which "[doc N]" block of the prompt contains a phrase (the mock cites it correctly).
    const docIndexOf = (prompt: string, phrase: string) => {
      const blocks = prompt.split('[doc ').slice(1);
      const i = blocks.findIndex((b) => b.includes(phrase));
      return i < 0 ? 0 : Number(blocks[i]!.split(']')[0]);
    };
    const mock = new MockProvider((req) => {
      if (req.prompt.includes('Research request')) return { queries: ['helm chart drift'] };
      const helm = req.prompt.includes(quote);
      return {
        title: helm ? 'Helm chart drift detection for platform teams' : 'Invoice reconciliation assistant',
        problem: helm ? 'Platform teams lose hours to helm chart drift breaking production deploys.' : 'Accounting firms reconcile invoices manually.',
        customer: helm ? 'Platform engineering teams' : 'Small accounting firms',
        market: helm ? 'Kubernetes tooling' : 'Accounting software',
        isB2B: true,
        tags: helm ? ['kubernetes', 'devops'] : ['accounting'],
        claims: helm
          ? [
              { doc: docIndexOf(req.prompt, quote), claim: 'Drift breaks deploys weekly', quote },
              { doc: 0, claim: 'Fabricated statistic', quote: '87% of companies lose $2M a year to drift' },
            ]
          : [],
        promptInjectionAttempt: false,
      };
    });
    const router = new ModelRouter({ providers: [mock] });
    const r = await core.discovery.scan(fresh.id, { query: 'kubernetes deploys', sources: ['hackernews'], limitPerSource: 20 }, { actor: actor(), router });
    expect(r.synthesis).toBe('model');
    const opp = (await core.opportunities.list(fresh.id)).items.find((o) => o.title.startsWith('Helm chart drift'))!;
    expect(opp).toBeTruthy();
    const ev = (await core.opportunities.detail(fresh.id, opp.id)).evidence;
    expect(ev.some((e) => e.quote === 'breaks our production deploys weekly' && e.provenance.quoteVerified === true)).toBe(true);
    expect(ev.some((e) => e.quote?.includes('87%'))).toBe(false);
    // Untrusted content reached the model fenced, never as instructions.
    expect(mock.calls.some((c) => c.prompt.includes('<untrusted_data'))).toBe(true);
  });
});

describe('experiments, tracking and decisions', () => {
  it('measures a funnel from tracked events and reaches a decision', async () => {
    const opp = (await core.opportunities.list(orgId)).items[0]!;
    const exp = await core.experiments.create(orgId, { opportunityId: opp.id, budgetUsd: 0, variants: ['a', 'b'], thresholds: { targetRate: 0.05, minSample: 100 }, funnel: 'landing_signup' }, actor());
    expect((await core.experiments.start(orgId, exp.id, actor())).status).toBe('running');
    const product = await core.products.getProduct(orgId, exp.productId!);
    const key = product.writeKey as string;
    for (let i = 0; i < 120; i++) {
      const variant = i % 2 ? 'a' : 'b';
      await core.tracking.ingest(key, { event: 'page_view', anonymousId: `v${i}`, experimentId: exp.id, variant }, { ip: '203.0.113.9', userAgent: 'Mozilla/5.0' });
      if (i % 5 === 0) await core.tracking.ingest(key, { event: 'signup', anonymousId: `v${i}`, experimentId: exp.id, variant, email: `user${i}@example.com`, name: `User ${i}` }, { userAgent: 'Mozilla/5.0' });
    }
    // Bots are recorded but excluded
    await core.tracking.ingest(key, { event: 'page_view', anonymousId: 'bot1', experimentId: exp.id, variant: 'a' }, { userAgent: 'Googlebot/2.1' });
    const stats = await core.experiments.funnelStats(orgId, exp.id);
    expect(stats.stages[0]!.count).toBe(120);
    const result = await core.experiments.evaluate(orgId, exp.id, actor());
    expect(result.stats.denominator).toBe(120);
    expect(result.stats.numerator).toBe(24);
    expect(result.decision).toBe('SCALE'); // 20% vs 5% target
    expect((await core.experiments.get(orgId, exp.id)).status).toBe('completed');
    expect((await core.opportunities.get(orgId, opp.id)).status).toBe('scaling');
    // Signups became inbound (consented) leads
    const leads = await core.leads.list(orgId);
    expect(leads.filter((l) => l.consentBasis === 'inbound').length).toBe(24);
    const alerts = await core.alerts.list(orgId);
    expect(alerts.some((a) => String(a.title).startsWith('Experiment SCALE'))).toBe(true);
  });

  it('rejects tracking with an unknown write key', async () => {
    await expect(core.tracking.ingest('pk_nope', { event: 'page_view', anonymousId: 'x' })).rejects.toThrow(/not found/);
  });
});

describe('revenue integrity', () => {
  it('keeps manual revenue unverified and counts only signature-verified Stripe events as verified', async () => {
    await core.revenue.recordManual(orgId, { type: 'charge', amountUsd: 500, note: 'invoice paid by bank transfer' }, actor());
    let s = await core.revenue.summary(orgId);
    expect(s.verified.revenueTotal).toBe(0);
    expect(s.reported.revenueTotal).toBe(500);

    const org = await core.orgs.get(orgId);
    const evt = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', created: Math.floor(Date.now() / 1000), data: { object: { id: 'in_1', amount_paid: 9900, currency: 'usd', customer: 'cus_1', subscription: 'sub_1' } } });
    await expect(core.revenue.handleStripeWebhook(org.slug, evt, 't=1,v1=bad')).rejects.toThrow(/signature/i);
    const ok = await core.revenue.handleStripeWebhook(org.slug, evt, signStripePayload(evt, 'whsec_test'));
    expect(ok.applied).toBe(true);
    // Replay of the same event is idempotent
    expect((await core.revenue.handleStripeWebhook(org.slug, evt, signStripePayload(evt, 'whsec_test'))).applied).toBe(false);
    const sub = JSON.stringify({ id: 'evt_2', type: 'customer.subscription.created', created: Math.floor(Date.now() / 1000), data: { object: { id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ quantity: 1, price: { unit_amount: 9900, recurring: { interval: 'month' } } }] } } } });
    await core.revenue.handleStripeWebhook(org.slug, sub, signStripePayload(sub, 'whsec_test'));
    s = await core.revenue.summary(orgId);
    expect(s.verified.revenueTotal).toBe(99);
    expect(s.verified.mrr).toBe(99);
    expect(s.reported.revenueTotal).toBe(599);

    const roadmap = await core.portfolio.roadmap(orgId);
    expect(roadmap.current.startingArrIsHypothetical).toBe(false);
    expect(roadmap.current.verifiedArrUsd).toBe(99 * 12);
  });
});

describe('outreach safety', () => {
  it('never drafts to unknown-consent leads and requires approval to send; outbox does not deliver', async () => {
    await core.leads.importCsv(orgId, { csv: 'name,email,consent\nAna,ana@example.com,opt_in\nBo,bo@example.com,\nCy,cy@example.com,unknown', source: 'csv_import', defaultConsentBasis: 'unknown' }, actor());
    const c = await core.campaigns.create(orgId, { name: 'Hello', subjectTemplate: 'Hi {{first_name}}', bodyTemplate: 'Hello {{name}}' }, actor());
    const recipients = c.messages.map((m) => m.toAddress);
    expect(recipients).toContain('ana@example.com');
    expect(recipients).not.toContain('bo@example.com');
    expect(recipients).not.toContain('cy@example.com');
    expect(c.messages[0]!.body).toMatch(/Unsubscribe: http/);
    expect(c.messages[0]!.body).toContain('1 Test Street');
    const r = await core.campaigns.requestSend(orgId, c.id, actor());
    expect(r.status).toBe('pending_approval');
    const done = await core.approvals.approve(orgId, (r as { approvalId: string }).approvalId, actor());
    expect(done.result).toMatchObject({ sent: 0, notDelivered: recipients.length });
    const after = await core.campaigns.get(orgId, c.id);
    expect(after.messages.every((m) => m.status === 'approved' && m.provider === 'outbox')).toBe(true);
    // Unsubscribe link works and suppresses future sends
    const url = new URL(core.campaigns.unsubscribeUrl(orgId, 'ana@example.com'));
    expect(await core.campaigns.unsubscribe(orgId, 'ana@example.com', url.searchParams.get('t')!)).toBe(true);
    expect(await core.leads.isSuppressed(orgId, 'ana@example.com')).toBe(true);
    expect(await core.campaigns.unsubscribe(orgId, 'ana@example.com', 'forged')).toBe(false);
  });
});

describe('demo workspace', () => {
  it('seeds a clearly-labelled synthetic workspace that never mixes with real data', async () => {
    const r = await seedDemo(core);
    const demoId = r.orgId;
    const flags = await core.db.many<{ t: string; bad: number }>(
      `SELECT 'opportunities' AS t, COUNT(*) FILTER (WHERE NOT is_demo)::int AS bad FROM opportunities WHERE org_id = $1
       UNION ALL SELECT 'revenue_events', COUNT(*) FILTER (WHERE NOT is_demo OR verified)::int FROM revenue_events WHERE org_id = $1
       UNION ALL SELECT 'tracking_events', COUNT(*) FILTER (WHERE NOT is_demo)::int FROM tracking_events WHERE org_id = $1
       UNION ALL SELECT 'evidence', COUNT(*) FILTER (WHERE data_kind <> 'DEMO' AND data_kind <> 'ESTIMATED')::int FROM evidence WHERE org_id = $1`,
      [demoId],
    );
    expect(flags.every((f) => f.bad === 0)).toBe(true);
    // Estimates computed by the real analysis engine on synthetic inputs are labelled DEMO too.
    const analyzed = (await core.opportunities.list(demoId, { status: 'analyzed' })).items[0]!;
    const detail = await core.opportunities.detail(demoId, analyzed.id);
    expect(detail.estimatedMarketSize!.kind).toBe('DEMO');
    expect(detail.scoreBreakdown!.criteria.every((c) => c.kind === 'DEMO')).toBe(true);
    expect(JSON.stringify(detail.hypotheses)).not.toMatch(/"kind":"(MODEL_ASSUMPTION|ESTIMATED|OBSERVED)"/);
    const exps = await core.experiments.list(demoId);
    const decisions = Object.fromEntries(exps.map((e) => [e.name, e.decision]));
    expect(decisions['StockSync landing page A/B (demo)']).toBe('SCALE');
    expect(decisions['KubeCost Lite smoke test (demo)']).toBe('KILL');
    expect(decisions['RecoDesk waitlist smoke test (demo)']).toBe('CONTINUE');
    const kpis = await core.portfolio.kpis(demoId);
    expect(kpis.isDemo).toBe(true);
    expect(kpis.mrr).toBeGreaterThan(0);
    expect(kpis.verifiedMrr).toBe(0);
    expect((await core.approvals.list(demoId, 'pending')).length).toBeGreaterThanOrEqual(2);
    // The real workspace is untouched by demo data
    const realKpis = await core.portfolio.kpis(orgId);
    expect(realKpis.isDemo).toBe(false);
    expect(realKpis.verifiedMrr).toBe(99);
  });

  it('generates a daily report whose recommendations cite evidence', async () => {
    const r = await core.reports.generateDaily(orgId);
    expect(r.markdown).toMatch(/## Recommended next experiments/);
    for (const rec of r.content.recommendations) expect(Array.isArray(rec.evidence)).toBe(true);
  });

  it('allocates a budget across the portfolio with uncertainty ranges', async () => {
    const a = await core.portfolio.allocate(orgId, { budgetUsd: 5000, maxShare: 0.6, explorationFloor: 0.1 });
    expect(a.recommendationOnly).toBe(true);
    expect(a.allocations.length).toBeGreaterThan(0);
    for (const x of a.allocations) expect(x.evLowUsd).toBeLessThanOrEqual(x.evHighUsd);
  });
});
