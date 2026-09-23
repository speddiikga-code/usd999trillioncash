import { json, type Db } from '@roos/database';
import { demoValue, newId, seededRandom, sha256Hex, type CompetitionAssessment } from '@roos/shared';
import type { Actor } from './audit';
import type { Core } from './core';
import { DEMO_ORG_SLUG } from './orgs';

/**
 * Synthetic demo workspace. EVERYTHING here is fake and labelled DEMO DATA: the organisation is
 * flagged is_demo, a database trigger stamps is_demo on every row, evidence has data_kind DEMO and
 * revenue has source 'demo' (which can never be marked verified). Demo data lives in its own
 * workspace, so it can never mix with a real workspace's metrics.
 */
const DEMO_ACTOR: Actor = { type: 'system', id: 'demo-seeder' };
const DAY = 86_400_000;

async function bulkInsert(db: Db, table: string, columns: string[], rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const params: unknown[] = [];
    const values = chunk.map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(',')})`).join(',');
    await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values}`, params);
  }
}

interface DemoOpp {
  key: string;
  title: string;
  problem: string;
  customer: string;
  market: string;
  tags: string[];
  keywords: string[];
  quotes: string[];
  docs: number;
  engagement: number;
  pain: number;
  wtp: number;
  status: string;
  price: [number, number, number];
  marketSize: [number, number, number];
  complexity: number;
  regulatory: number;
  competition: CompetitionAssessment['level'];
  competitors: string[];
  segment: string;
}

const OPPS: DemoOpp[] = [
  {
    key: 'invoice',
    title: 'Invoice reconciliation for small accounting firms',
    problem: 'Small accounting practices reconcile client invoices against bank feeds by hand in spreadsheets every month-end.',
    customer: 'Small accounting & bookkeeping firms (2–20 staff)',
    market: 'Accounting practice software',
    tags: ['b2b', 'accounting', 'automation'],
    keywords: ['invoice reconciliation', 'bank feed', 'month end'],
    quotes: ['[DEMO] "We lose two days every month-end matching invoices to bank lines."', '[DEMO] "I would pay for something that just flags the mismatches."', '[DEMO] "Our current tool does not handle partial payments."'],
    docs: 14, engagement: 1850, pain: 0.72, wtp: 4, status: 'analyzed', price: [39, 79, 199], marketSize: [2e7, 1.2e8, 6e8], complexity: 0.45, regulatory: 0.25, competition: 'medium', competitors: ['LedgerSync (fictional)', 'RecoBot (fictional)'], segment: 'Accountants & bookkeepers',
  },
  {
    key: 'inventory',
    title: 'Inventory sync across Shopify and marketplaces',
    problem: 'Merchants selling on Shopify plus two marketplaces oversell because stock levels drift between channels.',
    customer: 'E-commerce merchants with 100–5,000 SKUs',
    market: 'Multichannel e-commerce operations',
    tags: ['b2b', 'e-commerce', 'shopify'],
    keywords: ['inventory sync', 'oversell', 'shopify'],
    quotes: ['[DEMO] "We oversold 40 orders during a sale because the marketplace did not update."', '[DEMO] "Happy to pay $50/month if it just works."'],
    docs: 22, engagement: 4200, pain: 0.8, wtp: 6, status: 'experimenting', price: [29, 59, 149], marketSize: [5e7, 2.5e8, 1.2e9], complexity: 0.5, regulatory: 0.15, competition: 'high', competitors: ['StockFlow (fictional)', 'ChannelKit (fictional)', 'SyncHero (fictional)'], segment: 'E-commerce merchants',
  },
  {
    key: 'k8scost',
    title: 'Kubernetes cost reports for small platform teams',
    problem: 'Small platform teams cannot attribute cloud spend to namespaces without heavy tooling.',
    customer: 'Platform / DevOps teams at startups',
    market: 'Cloud cost management',
    tags: ['b2b', 'devtools', 'kubernetes'],
    keywords: ['kubernetes cost', 'namespace', 'cloud bill'],
    quotes: ['[DEMO] "Our AWS bill doubled and nobody knows which namespace did it."'],
    docs: 9, engagement: 900, pain: 0.55, wtp: 1, status: 'experimenting', price: [49, 99, 299], marketSize: [3e7, 1.5e8, 8e8], complexity: 0.65, regulatory: 0.1, competition: 'high', competitors: ['KubeBill (fictional)'], segment: 'Software developers & engineering teams',
  },
  {
    key: 'aicompliance',
    title: 'Compliance checklist for new AI transparency rules',
    problem: 'Small SaaS vendors are unsure which new AI disclosure obligations apply to them.',
    customer: 'SaaS founders shipping AI features',
    market: 'Regulatory compliance tooling',
    tags: ['b2b', 'compliance', 'ai'],
    keywords: ['ai transparency', 'compliance checklist', 'disclosure'],
    quotes: ['[DEMO] "Is there a simple checklist for what we need to disclose?"'],
    docs: 7, engagement: 640, pain: 0.5, wtp: 2, status: 'analyzed', price: [19, 49, 149], marketSize: [1e7, 6e7, 3e8], complexity: 0.35, regulatory: 0.55, competition: 'low', competitors: [], segment: 'Startup founders',
  },
  {
    key: 'bids',
    title: 'Contractor bid estimates from job-site photos',
    problem: 'Small contractors spend evenings turning site photos into itemised bids.',
    customer: 'Construction & trades contractors',
    market: 'Construction estimating software',
    tags: ['b2b', 'construction', 'ai'],
    keywords: ['bid estimate', 'job site', 'contractor'],
    quotes: ['[DEMO] "Estimating takes longer than the job itself for small repairs."'],
    docs: 5, engagement: 310, pain: 0.6, wtp: 1, status: 'discovered', price: [29, 69, 149], marketSize: [1.5e7, 9e7, 4e8], complexity: 0.7, regulatory: 0.15, competition: 'unknown', competitors: [], segment: 'Construction & trades',
  },
  {
    key: 'landlord',
    title: 'Maintenance request triage for small landlords',
    problem: 'Landlords with 5–50 units juggle maintenance requests across texts, email and calls.',
    customer: 'Independent landlords & small property managers',
    market: 'Property management software',
    tags: ['b2b', 'real estate'],
    keywords: ['maintenance request', 'tenant', 'landlord'],
    quotes: ['[DEMO] "Tenants text me photos at midnight and I lose track of what is fixed."'],
    docs: 11, engagement: 1200, pain: 0.66, wtp: 3, status: 'validated', price: [15, 39, 99], marketSize: [2e7, 1e8, 5e8], complexity: 0.35, regulatory: 0.2, competition: 'medium', competitors: ['RentDesk (fictional)'], segment: 'Property managers & landlords',
  },
  {
    key: 'podcast',
    title: 'Sponsorship matching for niche podcasters',
    problem: 'Niche podcasters with 1–10k listeners cannot find relevant sponsors efficiently.',
    customer: 'Independent podcast creators',
    market: 'Creator monetisation',
    tags: ['b2c', 'creators'],
    keywords: ['podcast sponsor', 'niche audience'],
    quotes: ['[DEMO] "Sponsors only look at shows with 50k+ downloads."'],
    docs: 4, engagement: 220, pain: 0.4, wtp: 1, status: 'discovered', price: [9, 19, 49], marketSize: [5e6, 3e7, 2e8], complexity: 0.4, regulatory: 0.1, competition: 'unknown', competitors: [], segment: 'Freelancers & creators',
  },
  {
    key: 'noshow',
    title: 'Appointment no-show reduction for small clinics',
    problem: 'Small clinics lose revenue to no-shows and manual reminder calls.',
    customer: 'Independent healthcare practices',
    market: 'Practice management',
    tags: ['b2b', 'healthcare'],
    keywords: ['no show', 'appointment reminder', 'clinic'],
    quotes: ['[DEMO] "We call every patient the day before — it takes a full shift."'],
    docs: 8, engagement: 700, pain: 0.58, wtp: 2, status: 'discovered', price: [49, 99, 249], marketSize: [3e7, 1.5e8, 7e8], complexity: 0.45, regulatory: 0.85, competition: 'medium', competitors: ['RemindMD (fictional)'], segment: 'Healthcare practices',
  },
];

export async function seedDemo(core: Core, opts: { reset?: boolean } = {}) {
  const db = core.db;
  const existing = await core.orgs.demoOrg();
  if (existing && !opts.reset) return { orgId: existing.id, created: false };
  if (existing) await db.query('DELETE FROM organizations WHERE id = $1', [existing.id]);

  const org = await core.orgs.create('Demo Workspace (synthetic data)', { isDemo: true, slug: DEMO_ORG_SLUG });
  const orgId = org.id;
  await core.orgs.updateSettings(orgId, {
    industries: ['accounting', 'e-commerce', 'developer tools', 'real estate'],
    constraints: { initialCapitalUsd: 25_000, monthlyBudgetUsd: 2_000, hoursPerWeek: 20, riskTolerance: 'medium' },
    onboarding: { system_status: { done: true }, connect_ai: { done: true }, configure_sources: { done: true }, constraints: { done: true }, industries: { done: true }, first_scan: { done: true }, hypotheses: { done: true }, select_opportunity: { done: true } },
  });
  await db.query(`INSERT INTO memberships (user_id, org_id, role) SELECT id, $1, 'owner' FROM users WHERE email <> 'demo-guest@roos.local' ON CONFLICT DO NOTHING`, [orgId]);
  await db.query(`INSERT INTO memberships (user_id, org_id, role) SELECT id, $1, 'viewer' FROM users WHERE email = 'demo-guest@roos.local' ON CONFLICT DO NOTHING`, [orgId]);
  const rng = seededRandom(20260923);
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  // Opportunities + synthetic evidence
  const oppIds: Record<string, string> = {};
  for (const o of OPPS) {
    const opp = await core.opportunities.insert(
      orgId,
      {
        title: o.title,
        problem: o.problem,
        customer: o.customer,
        market: o.market,
        tags: o.tags,
        industries: [],
        fingerprint: `demo:${o.key}`,
        signals: { documentCount: o.docs, distinctSources: Math.min(3, Math.ceil(o.docs / 4)), totalEngagement: o.engagement, painScore: o.pain, willingnessToPayMentions: o.wtp, competitorMentions: o.competitors.length, newestEvidenceAt: iso(3 * DAY), oldestEvidenceAt: iso(90 * DAY), keywords: o.keywords },
        estimatedPrice: { ...demoValue(o.price[1], o.price[0], o.price[2]), unit: 'USD/month' },
        estimatedMarketSize: { ...demoValue(o.marketSize[1], o.marketSize[0], o.marketSize[2]), unit: 'USD/year' },
        acquisitionCostEstimate: { ...demoValue(250, 90, 700), unit: 'USD' },
        grossMarginEstimate: demoValue(0.8, 0.7, 0.9),
        technicalComplexity: demoValue(o.complexity, o.complexity - 0.15, o.complexity + 0.15),
        regulatoryRisk: demoValue(o.regulatory, Math.max(0, o.regulatory - 0.15), Math.min(1, o.regulatory + 0.15)),
        timeToMvp: { ...demoValue(2 + o.complexity * 10, 2, 4 + o.complexity * 14), unit: 'weeks' },
        competition: { level: o.competition, competitors: o.competitors.map((name) => ({ name, note: 'DEMO — fictional company' })), kind: 'DEMO', rationale: 'Synthetic demo competitors.' },
        status: o.status as never,
        createdBy: DEMO_ACTOR.id,
      },
      DEMO_ACTOR,
    );
    oppIds[o.key] = opp.id;
    await core.opportunities.addEvidence(
      orgId,
      opp.id,
      o.quotes.map((q, i) => ({
        claim: `Synthetic pain-point example #${i + 1}`,
        quote: q,
        kind: 'DEMO',
        sourceName: 'DEMO DATA (synthetic)',
        sourceUrl: null,
        observedAt: iso((5 + i * 11) * DAY),
        confidence: 0,
        provenance: { synthetic: true, seeder: 'demo' },
      })),
    );
    await core.opportunities.rescore(orgId, opp.id, { isB2B: o.tags.includes('b2b') });
    const g = core.graph;
    const on = await g.upsertNode(orgId, 'opportunity', opp.id, o.title);
    const seg = await g.upsertNode(orgId, 'customer_segment', o.segment.toLowerCase().replace(/[^a-z0-9]+/g, '-'), o.segment);
    const pain = await g.upsertNode(orgId, 'pain_point', o.keywords[0]!.replace(/\s+/g, '-'), o.keywords[0]!);
    const mkt = await g.upsertNode(orgId, 'market', o.market.toLowerCase().replace(/[^a-z0-9]+/g, '-'), o.market);
    await g.upsertEdge(orgId, on, seg, 'targets');
    await g.upsertEdge(orgId, on, pain, 'addresses');
    await g.upsertEdge(orgId, seg, pain, 'experiences');
    await g.upsertEdge(orgId, on, mkt, 'in_market');
    for (const c of o.competitors) await g.upsertEdge(orgId, on, await g.upsertNode(orgId, 'competitor', c.toLowerCase().replace(/[^a-z0-9]+/g, '-'), c, { fictional: true }), 'competes_with');
    if (o.regulatory > 0.5) await g.upsertEdge(orgId, on, await g.upsertNode(orgId, 'regulation', `${o.key}-reg`, o.key === 'noshow' ? 'Health data / medical' : 'AI disclosure rules (demo)'), 'subject_to');
  }

  // Business hypotheses via the real (heuristic) analysis engine
  for (const k of ['invoice', 'inventory', 'aicompliance', 'landlord']) {
    await core.analysis.analyze(orgId, oppIds[k]!, { actor: DEMO_ACTOR, router: null });
  }
  await core.opportunities.setStatus(orgId, oppIds.landlord!, 'validated', DEMO_ACTOR);

  // Products
  const pInventory = await core.products.createProduct(orgId, { name: 'StockSync (demo)', opportunityId: oppIds.inventory, description: 'Synthetic demo product', status: 'live', businessModel: 'b2b_saas' });
  const pInvoice = await core.products.createProduct(orgId, { name: 'RecoDesk (demo)', opportunityId: oppIds.invoice, description: 'Synthetic demo product', status: 'preview', businessModel: 'b2b_saas' });
  const pK8s = await core.products.createProduct(orgId, { name: 'KubeCost Lite (demo)', opportunityId: oppIds.k8scost, description: 'Synthetic demo product', status: 'preview', businessModel: 'developer_tool' });
  const pLandlord = await core.products.createProduct(orgId, { name: 'FixQueue (demo)', opportunityId: oppIds.landlord, description: 'Synthetic demo product', status: 'draft', businessModel: 'b2b_saas' });
  await db.query(`UPDATE products SET launched_at = $2 WHERE id = $1`, [pInventory.id, iso(300 * DAY)]);

  // Experiments with synthetic funnel traffic, evaluated by the real decision engine
  const traffic = async (expId: string, productId: string, variants: { variant: string; visitors: number; rate: number }[], startDaysAgo: number, spanDays: number) => {
    const rows: unknown[][] = [];
    for (const v of variants) {
      // Deterministic conversions (exactly round(visitors × rate), evenly spread) so the demo
      // narrative is stable; timestamps are randomised with a seeded PRNG.
      const k = Math.round(v.visitors * v.rate);
      for (let i = 0; i < v.visitors; i++) {
        const anon = `demo-${expId.slice(-6)}-${v.variant}-${i}`;
        const t = now - startDaysAgo * DAY + rng() * spanDays * DAY;
        rows.push([newId('tracking'), orgId, productId, expId, v.variant, 'page_view', anon, new Date(t).toISOString(), false]);
        if (Math.floor(((i + 1) * k) / v.visitors) > Math.floor((i * k) / v.visitors)) rows.push([newId('tracking'), orgId, productId, expId, v.variant, 'signup', anon, new Date(t + 60_000).toISOString(), false]);
      }
    }
    await bulkInsert(db, 'tracking_events', ['id', 'org_id', 'product_id', 'experiment_id', 'variant', 'event', 'anonymous_id', 'occurred_at', 'is_bot'], rows);
  };
  const mkExp = async (oppKey: string, productId: string, name: string, variants: string[], budget: number, startedDaysAgo: number | null) => {
    const exp = await core.experiments.create(orgId, { opportunityId: oppIds[oppKey], productId, name, budgetUsd: budget, variants, thresholds: { targetRate: 0.05, minSample: 200 }, funnel: 'landing_signup', variantCopy: variants.length > 1 ? { a: 'Never oversell again', b: 'Stock levels that stay in sync — everywhere' } : {} }, DEMO_ACTOR);
    if (startedDaysAgo !== null) {
      await db.query(`UPDATE experiments SET status = 'running', started_at = $2 WHERE id = $1`, [exp.id, iso(startedDaysAgo * DAY)]);
    }
    return exp.id;
  };

  const e1 = await mkExp('inventory', pInventory.id as string, 'StockSync landing page A/B (demo)', ['a', 'b'], 800, 40);
  await traffic(e1, pInventory.id as string, [{ variant: 'a', visitors: 900, rate: 0.07 }, { variant: 'b', visitors: 900, rate: 0.11 }], 40, 20);
  const e2 = await mkExp('invoice', pInvoice.id as string, 'RecoDesk waitlist smoke test (demo)', ['control'], 300, 9);
  await traffic(e2, pInvoice.id as string, [{ variant: 'control', visitors: 260, rate: 0.062 }], 9, 9);
  const e3 = await mkExp('k8scost', pK8s.id as string, 'KubeCost Lite smoke test (demo)', ['control'], 300, 25);
  await traffic(e3, pK8s.id as string, [{ variant: 'control', visitors: 520, rate: 0.006 }], 25, 14);
  await mkExp('landlord', pLandlord.id as string, 'FixQueue pre-launch test (demo)', ['control'], 0, null);
  const expenseRows: unknown[][] = [];
  for (const [expId, productId, total, days] of [[e1, pInventory.id, 640, 20], [e2, pInvoice.id, 120, 9], [e3, pK8s.id, 280, 14]] as const) {
    const n = Math.max(3, Math.floor(days / 3));
    for (let i = 0; i < n; i++) expenseRows.push([newId('expense'), orgId, productId, expId, 'ads', Math.round((total / n) * 100) / 100, iso((days - i * 3) * DAY), 'DEMO ad spend', 'demo']);
  }
  for (const id of [e1, e2, e3]) await core.experiments.evaluate(orgId, id, DEMO_ACTOR);
  // Experiment with budget → goes through the spend.commit policy (approval pending in the demo)
  const e5 = await core.experiments.create(orgId, { opportunityId: oppIds.aicompliance, name: 'AI-compliance checklist paid-search probe (demo)', budgetUsd: 500, variants: ['control'], thresholds: {}, funnel: 'landing_signup' }, DEMO_ACTOR);
  await core.experiments.start(orgId, e5.id, DEMO_ACTOR);

  // Revenue ledger (source 'demo' — never verified) for the "scaling" product
  const revRows: unknown[][] = [];
  const custRows: unknown[][] = [];
  const plans = [49, 49, 99];
  let custIdx = 0;
  for (let m = 10; m >= 0; m--) {
    const newCustomers = Math.round(3 + (10 - m) * 1.6 + rng() * 3);
    for (let i = 0; i < newCustomers; i++) {
      const cid = newId('customer');
      const mrr = plans[Math.floor(rng() * plans.length)]!;
      const start = now - m * 30 * DAY - rng() * 25 * DAY;
      const churnAfterMonths = rng() < 0.045 * 10 ? Math.floor(1 + rng() * 9) : null;
      const churnAt = churnAfterMonths !== null ? start + churnAfterMonths * 30 * DAY : null;
      const churned = churnAt !== null && churnAt < now;
      custRows.push([cid, orgId, pInventory.id, `demo_cus_${custIdx++}`, sha256Hex(`demo${custIdx}`), churned ? 'churned' : 'active', churned ? 0 : mrr, 'demo', new Date(start).toISOString(), churned ? new Date(churnAt!).toISOString() : null]);
      revRows.push([newId('revenue'), orgId, pInventory.id, cid, 'subscription_started', 0, mrr, new Date(start).toISOString(), 'demo', false]);
      for (let t = start; t < now && (!churned || t < churnAt!); t += 30 * DAY) revRows.push([newId('revenue'), orgId, pInventory.id, cid, 'charge', mrr, 0, new Date(t).toISOString(), 'demo', false]);
      if (churned) revRows.push([newId('revenue'), orgId, pInventory.id, cid, 'subscription_canceled', 0, -mrr, new Date(churnAt!).toISOString(), 'demo', false]);
    }
  }
  await bulkInsert(db, 'customers', ['id', 'org_id', 'product_id', 'external_id', 'email_hash', 'status', 'mrr_usd', 'source', 'started_at', 'churned_at'], custRows);
  await bulkInsert(db, 'revenue_events', ['id', 'org_id', 'product_id', 'customer_id', 'type', 'amount_usd', 'mrr_delta_usd', 'occurred_at', 'source', 'verified'], revRows);
  for (let m = 10; m >= 0; m--) {
    const at = iso(m * 30 * DAY + 5 * DAY);
    expenseRows.push([newId('expense'), orgId, pInventory.id, null, 'infrastructure', 120, at, 'DEMO hosting', 'demo']);
    expenseRows.push([newId('expense'), orgId, pInventory.id, null, 'ai', 35, at, 'DEMO inference', 'demo']);
    expenseRows.push([newId('expense'), orgId, null, null, 'tools', 60, at, 'DEMO tooling', 'demo']);
    if (m <= 6) expenseRows.push([newId('expense'), orgId, pInventory.id, null, 'ads', 400, at, 'DEMO acquisition', 'demo']);
  }
  await bulkInsert(db, 'expenses', ['id', 'org_id', 'product_id', 'experiment_id', 'category', 'amount_usd', 'occurred_at', 'description', 'source'], expenseRows);

  // Leads (mixed consent — "unknown" leads are never contacted)
  const names = ['Avery Chen', 'Jordan Patel', 'Sam Rivera', 'Taylor Kim', 'Morgan Diaz', 'Riley Novak', 'Casey Brooks', 'Jamie Okafor', 'Drew Santos', 'Quinn Murphy', 'Harper Ito', 'Rowan Silva', 'Emerson Lee', 'Kai Andersen', 'Reese Walker', 'Sage Moreau', 'Blake Haddad', 'Parker Nguyen', 'Skyler Costa', 'Alex Kowalski'];
  const titles = ['Founder', 'Owner', 'Head of Operations', 'Office Manager', 'CEO', 'Bookkeeper', 'Ops Lead', 'Director of Finance'];
  for (const [i, name] of names.entries()) {
    const consent = i < 11 ? 'inbound' : i < 15 ? 'opt_in' : 'unknown';
    await core.leads.create(
      orgId,
      { name: `${name} (demo)`, email: `demo.lead${i + 1}@example.com`, company: `Demo Company ${i + 1}`, title: titles[i % titles.length], consentBasis: consent, source: i < 11 ? 'inbound_signup' : 'csv_import', opportunityId: i % 2 ? oppIds.invoice : oppIds.inventory },
      DEMO_ACTOR,
    );
  }
  await db.query(`UPDATE leads SET status = 'demo' WHERE org_id = $1 AND email IN ('demo.lead1@example.com','demo.lead2@example.com')`, [orgId]);
  await db.query(`UPDATE leads SET status = 'replied' WHERE org_id = $1 AND email IN ('demo.lead3@example.com','demo.lead4@example.com','demo.lead5@example.com')`, [orgId]);
  await db.query(`UPDATE leads SET status = 'customer' WHERE org_id = $1 AND email = 'demo.lead6@example.com'`, [orgId]);

  const campaign = await core.campaigns.create(
    orgId,
    { name: 'RecoDesk early-access follow-up (demo)', opportunityId: oppIds.invoice, productId: pInvoice.id as string, subjectTemplate: 'Quick question about month-end, {{first_name}}', bodyTemplate: 'Hi {{first_name}},\n\nYou joined the early-access list for {{product}}. Would a 15-minute call to see the reconciliation flow be useful?\n\nThanks,\n{{sender}}' },
    DEMO_ACTOR,
  );
  const approval = await core.approvals.request(orgId, {
    actionType: 'outreach.send',
    title: `Send campaign "${campaign.name}" to ${campaign.messages.length} recipient(s)`,
    what: `Email ${campaign.messages.length} consented demo leads.`,
    why: 'Convert early-access signups into demo calls (DEMO).',
    expectedBenefit: 'Demo calls with interested leads.',
    expectedCostUsd: 0,
    risk: { level: 'medium', description: 'Unwanted email harms reputation. Only consented leads included. (DEMO)' },
    dataSources: [{ name: 'DEMO DATA (synthetic CRM)' }],
    reversibility: 'irreversible',
    payload: { campaignId: campaign.id, recipients: campaign.messages.length, demo: true },
    requestedBy: 'agent:SalesAgent',
  });
  await db.query(`UPDATE campaigns SET status = 'pending_approval', approval_id = $2 WHERE id = $1`, [campaign.id, approval.id]);

  // Agent task history (so the command center shows activity)
  const taskRows: unknown[][] = [];
  const hist: [string, string, number][] = [
    ['ResearchAgent', 'research.discover', 26],
    ['MarketAgent', 'market.synthesize', 26],
    ['RiskAgent', 'risk.assess', 25],
    ['FinanceAgent', 'finance.unit_economics', 20],
    ['ProductAgent', 'product.spec', 18],
    ['CodeAgent', 'code.generate', 18],
    ['SecurityAgent', 'security.scan_code', 18],
    ['GrowthAgent', 'growth.design_experiment', 15],
    ['AnalyticsAgent', 'analytics.evaluate_experiments', 1],
    ['AnalyticsAgent', 'analytics.daily_report', 1],
  ];
  for (const [agent, kind, daysAgo] of hist) {
    const t = now - daysAgo * DAY;
    taskRows.push([newId('task'), orgId, agent, kind, json({ demo: true }), json({ demo: true, summary: 'Synthetic history entry' }), 'succeeded', 1, new Date(t).toISOString(), new Date(t + 4000).toISOString(), 'demo-seeder', new Date(t).toISOString()]);
  }
  await bulkInsert(db, 'agent_tasks', ['id', 'org_id', 'agent', 'kind', 'input', 'output', 'status', 'attempts', 'started_at', 'finished_at', 'created_by', 'created_at'], taskRows);

  await core.reports.generateDaily(orgId);
  await core.audit.record({ orgId, actor: DEMO_ACTOR, action: 'demo.seed', details: { opportunities: OPPS.length } });
  return { orgId, created: true };
}
