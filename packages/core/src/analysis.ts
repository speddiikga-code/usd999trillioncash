import type { CallContext, ModelRouter } from '@roos/ai';
import { computeUnitEconomics } from '@roos/analytics';
import { getConnector, runConnector } from '@roos/connectors';
import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { wrapUntrusted } from '@roos/security';
import {
  assumption,
  BUSINESS_MODELS,
  camelize,
  clamp,
  demoizeDeep,
  errorMessage,
  newId,
  round,
  truncate,
  unique,
  z,
  type BusinessHypothesis,
  type BusinessModel,
  type EstimatedValue,
  type Logger,
  type MvpEntity,
  type Opportunity,
} from '@roos/shared';
import type { Actor } from './audit';
import type { DiscoveryService } from './discovery';
import {
  cacPrior,
  churnPrior,
  competitionFromEvidence,
  complexityEstimate,
  extractPriceMentions,
  grossMarginPrior,
  marketSizeEstimate,
  priceEstimate,
  primarySegment,
  regulatoryEstimate,
  timeToMvpEstimate,
} from './estimates';
import type { EventBus } from './events';
import { PostgresGraphStore } from './graph';
import type { OpportunityService } from './opportunities';
import { markStep } from './orgs';

const FieldSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,30}$/),
  type: z.enum(['string', 'text', 'number', 'boolean', 'date', 'email', 'url']),
  required: z.boolean().optional(),
});
const VariantSchema = z.object({
  model: z.enum(BUSINESS_MODELS),
  title: z.string().min(5).max(140),
  targetCustomer: z.string().min(3).max(200),
  valueProposition: z.string().min(10).max(500),
  coreFeatures: z.array(z.string().min(3).max(140)).min(2).max(6),
  entities: z.array(z.object({ name: z.string().regex(/^[A-Z][a-zA-Z0-9]{1,30}$/), fields: z.array(FieldSchema).min(1).max(10) })).min(1).max(3),
  distribution: z.array(z.string().max(200)).min(1).max(6),
  retention: z.array(z.string().max(200)).min(1).max(5),
  priceMonthlyUsd: z.object({ low: z.number().min(0), mode: z.number().min(0), high: z.number().min(0) }),
});
const HypothesesSchema = z.object({ variants: z.array(VariantSchema).min(2).max(4) });

type HypothesisDraft = Omit<BusinessHypothesis, 'id' | 'opportunityId' | 'createdAt' | 'status'>;

export function singular(word: string): string {
  const w = word.replace(/[^a-z0-9]/gi, '');
  if (/ies$/i.test(w)) return w.slice(0, -3) + 'y';
  if (/(ss|us)$/i.test(w)) return w;
  if (/s$/i.test(w)) return w.slice(0, -1);
  return w;
}

export function entityFromKeywords(keywords: string[], finance: boolean): MvpEntity[] {
  const base = singular((keywords[0] ?? 'item').split(' ')[0] ?? 'item');
  const name = (base.charAt(0).toUpperCase() + base.slice(1).toLowerCase()).replace(/[^A-Za-z0-9]/g, '') || 'Item';
  const safeName = /^[A-Z][a-zA-Z0-9]{1,30}$/.test(name) ? name : 'Item';
  return [
    {
      name: safeName,
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'status', type: 'string' },
        { name: 'owner', type: 'email' },
        { name: 'dueDate', type: 'date' },
        ...(finance ? [{ name: 'amount', type: 'number' as const }] : []),
        { name: 'notes', type: 'text' },
      ],
    },
  ];
}

function tiersFrom(price: number) {
  const r = (x: number) => Math.max(1, Math.round(x));
  return [
    { name: 'Starter', priceUsdMonthly: r(price * 0.5), features: ['1 workspace', 'Core workflow', 'Email support'] },
    { name: 'Pro', priceUsdMonthly: r(price), features: ['Unlimited items', 'Integrations', 'Priority support'] },
    { name: 'Team', priceUsdMonthly: r(price * 2.5), features: ['Multiple seats', 'Roles & audit log', 'SSO (later)'] },
  ];
}

export class AnalysisService {
  private graph: PostgresGraphStore;

  constructor(
    private db: Db,
    private logger: Logger,
    private events: EventBus,
    private opportunities: OpportunityService,
    private discovery: DiscoveryService,
  ) {
    this.graph = new PostgresGraphStore(db);
  }

  async analyze(orgId: string, oppId: string, opts: { router?: ModelRouter | null; callCtx?: CallContext; actor: Actor }) {
    const notes: string[] = [];
    let modelCostUsd = 0;
    const router = opts.router && opts.router.available() ? opts.router : null;
    const before = await this.opportunities.get(orgId, oppId);
    await this.opportunities.setStatus(orgId, oppId, 'analyzing', opts.actor);
    try {
      const detail = await this.opportunities.detail(orgId, oppId);
      const docs = await this.db.many<{ content: string; connector: string }>(`SELECT DISTINCT d.content, d.connector FROM evidence e JOIN documents d ON d.id = e.document_id WHERE e.opportunity_id = $1 AND e.org_id = $2`, [oppId, orgId]);
      const texts = [detail.problem, ...detail.evidence.map((e) => e.quote ?? ''), ...docs.map((d) => d.content)];
      const allText = texts.join('\n');
      const seg = primarySegment(allText);
      const isB2B = detail.tags.includes('b2b') || seg.isB2B;

      // Competition: evidence mentions + optional web search (observed search results).
      const searchResults: { name: string; url?: string }[] = [];
      const ctx = await this.discovery.connectorContext(orgId);
      if (ctx.secrets.braveSearchKey) {
        const q = `${detail.signals.keywords.slice(0, 3).join(' ')} software`;
        const r = await runConnector(getConnector('brave_search')!, q, { limit: 8 }, ctx);
        for (const d of r.documents) if (d.url) searchResults.push({ name: new URL(d.url).hostname.replace(/^www\./, ''), url: d.url });
        if (r.error) notes.push(`Competitor web search failed: ${r.error}`);
      } else notes.push('No web-search key configured (BRAVE_SEARCH_API_KEY) — competition assessed from evidence mentions only.');
      const competition = competitionFromEvidence(texts, searchResults);

      const price = priceEstimate(isB2B, extractPriceMentions(texts), detail.evidence.slice(0, 5).map((e) => ({ name: e.sourceName, url: e.sourceUrl ?? undefined })));
      const complexity = complexityEstimate(allText);
      const { flags: regFlags, ...regulatoryRisk } = regulatoryEstimate(allText);
      const gm = grossMarginPrior(/\b(ai|llm|gpt|model)\b/i.test(allText));
      const cac = cacPrior(isB2B);
      const churn = churnPrior(isB2B);
      const marketSize = marketSizeEstimate(seg.segment, price);
      if (regFlags.length) notes.push(`Regulatory flags: ${regFlags.map((f) => f.area).join('; ')} — obtain qualified legal review before launch.`);

      // Hypotheses: heuristic variants, optionally enriched by a model (qualitative fields only).
      let drafts = this.heuristicHypotheses(detail, { isB2B, price, cac, gm, churn, complexity, segment: seg.segment?.segment });
      if (router) {
        try {
          const evidenceBlock = detail.evidence
            .slice(0, 10)
            .map((e, i) => wrapUntrusted(`[${i}] ${e.claim}\n${e.quote ?? ''}`, e.sourceName).wrapped)
            .join('\n');
          const { data, meta } = await router.generateJson(
            {
              purpose: 'strategy.hypotheses',
              tier: 'deep',
              system:
                'You are a pragmatic startup strategist. Propose distinct business-model hypotheses that could be tested cheaply. ' +
                'Ground them in the evidence. Do not state market sizes, revenue figures or facts not present in the evidence.',
              prompt:
                `Opportunity: ${detail.title}\nProblem: ${truncate(detail.problem, 1500)}\nCustomer: ${detail.customer}\nB2B: ${isB2B}\n` +
                `Evidence:\n${evidenceBlock}\n\nReturn {"variants": [...]} with 2-4 different business models (from the allowed enum). ` +
                'entities describe the core data model of a minimal web app (PascalCase names, camelCase fields).',
              maxOutputTokens: 8000,
            },
            HypothesesSchema,
            opts.callCtx,
          );
          modelCostUsd += meta.costUsd;
          drafts = data.variants.map((v) => this.fromModelVariant(v, detail, { cac, gm, churn, complexity, generatedBy: meta.generatedBy }));
        } catch (e) {
          notes.push(`Model hypothesis generation failed (${errorMessage(e)}); used heuristic templates.`);
        }
      }

      const ids = await this.db.tx(async () => {
        await this.db.query(`DELETE FROM business_hypotheses WHERE opportunity_id = $1 AND org_id = $2 AND status = 'proposed'`, [oppId, orgId]);
        const out: string[] = [];
        for (const h of drafts) out.push(await this.insertHypothesis(orgId, oppId, h));
        return out;
      });

      await this.opportunities.update(
        orgId,
        oppId,
        {
          status: ['discovered', 'analyzing'].includes(before.status) ? 'analyzed' : before.status,
          estimatedMarketSize: marketSize,
          estimatedPrice: price,
          acquisitionCostEstimate: cac,
          grossMarginEstimate: gm,
          competition,
          technicalComplexity: complexity,
          regulatoryRisk,
          timeToMvp: timeToMvpEstimate(Number(complexity.value)),
        },
        opts.actor,
      );
      const breakdown = await this.opportunities.rescore(orgId, oppId, { isB2B });

      const oppNode = await this.graph.upsertNode(orgId, 'opportunity', oppId, detail.title, { opportunityId: oppId });
      for (const h of drafts) {
        const n = await this.graph.upsertNode(orgId, 'business_model', h.model, h.model.replace(/_/g, ' '));
        await this.graph.upsertEdge(orgId, oppNode, n, 'hypothesis');
      }
      for (const c of competition.competitors) {
        const n = await this.graph.upsertNode(orgId, 'competitor', PostgresGraphStore.key(c.name), c.name, { url: c.url });
        await this.graph.upsertEdge(orgId, oppNode, n, 'competes_with');
      }
      for (const f of regFlags) {
        const n = await this.graph.upsertNode(orgId, 'regulation', PostgresGraphStore.key(f.area), f.area, { note: f.note });
        await this.graph.upsertEdge(orgId, oppNode, n, 'subject_to');
      }

      await this.events.publish(orgId, 'hypothesis.created', { entityType: 'opportunity', entityId: oppId, payload: { count: ids.length } });
      await markStep(this.db, orgId, 'hypotheses');
      const hypotheses = (await this.db.many('SELECT * FROM business_hypotheses WHERE id = ANY($1) ORDER BY score DESC', [ids])).map((r) => camelize<BusinessHypothesis>(r));
      return { opportunityId: oppId, score: breakdown, hypotheses, competition, notes, modelCostUsd, generatedBy: router && drafts[0]?.generatedBy.startsWith('model') ? drafts[0].generatedBy : 'heuristic' };
    } catch (e) {
      await this.opportunities.setStatus(orgId, oppId, before.status, opts.actor);
      throw e;
    }
  }

  private economics(price: EstimatedValue, ctx: { cac: EstimatedValue; gm: EstimatedValue; churn: EstimatedValue }) {
    return computeUnitEconomics({ price, cac: ctx.cac, grossMargin: ctx.gm, monthlyChurn: ctx.churn });
  }

  private hypothesisScore(oppScore: number, ltvToCac: number, weeksToRevenue: number) {
    return round(0.5 * oppScore + 0.3 * clamp(ltvToCac / 5, 0, 1) + 0.2 * clamp(1 - weeksToRevenue / 16, 0, 1), 4);
  }

  private channels(connectors: string[]): string[] {
    const out = ['Waitlist landing page with a clear offer (smoke test)', 'Founder-led outreach to inbound, opted-in leads'];
    if (connectors.includes('hackernews')) out.push('Launch post / answer existing threads on Hacker News (where the pain was observed)');
    if (connectors.includes('stackexchange')) out.push('SEO page targeting "tool for …" questions seen on Stack Exchange');
    if (connectors.includes('github')) out.push('Integration or plugin for the open-source tools named in GitHub issues');
    return out;
  }

  private heuristicHypotheses(
    o: Opportunity & { evidence: { provenance: Record<string, unknown> }[] },
    c: { isB2B: boolean; price: EstimatedValue; cac: EstimatedValue; gm: EstimatedValue; churn: EstimatedValue; complexity: EstimatedValue; segment?: string },
  ): HypothesisDraft[] {
    const kw = o.signals.keywords.length ? o.signals.keywords : o.tags;
    const topic = kw.slice(0, 2).join(' / ') || o.title;
    const customer = c.segment ?? o.customer;
    const finance = /\b(invoice|payment|billing|expense|budget|account|tax|price|cost)/i.test(`${o.title} ${o.problem}`);
    const entities = entityFromKeywords(kw, finance);
    const connectors = unique(o.evidence.map((e) => String(e.provenance.connector ?? ''))).filter(Boolean);
    const p = Number(c.price.value);
    const weeks = 2 + Number(c.complexity.value) * 10;
    const oppScore = o.score ?? 0.4;
    const baseArch = [
      'Node.js HTTP server with zero runtime dependencies (sandbox-friendly)',
      'JSON-file store for the MVP; schema.sql provided for the move to PostgreSQL',
      'Landing page + core app screen + REST API',
      'Funnel events posted to the ROOS tracking API (page_view, signup, activation, payment)',
      'Payments interface: Stripe payment link created only after human approval',
    ];
    const plan = (target: string) => [
      { step: 'Publish landing page + waitlist', metric: 'visitor → signup', threshold: target },
      { step: 'Onboard first 10 signups manually', metric: 'signup → activation', threshold: '≥ 40%' },
      { step: 'Offer paid pilot / pre-order', metric: 'activated → paid', threshold: '≥ 10%' },
    ];
    const costs = (extra: { item: string; monthlyUsd: number }[] = []) => [
      { item: 'Hosting (small VM/container)', monthlyUsd: 20, kind: 'MODEL_ASSUMPTION' as const },
      { item: 'Email / tooling', monthlyUsd: 30, kind: 'MODEL_ASSUMPTION' as const },
      ...extra.map((e) => ({ ...e, kind: 'MODEL_ASSUMPTION' as const })),
    ];

    const saasEcon = this.economics(c.price, c);
    const serviceP = assumption(Math.round(p * 5), Math.round((c.price.low ?? p) * 3), Math.round((c.price.high ?? p) * 8), 'Done-for-you service priced at ~5× the software price prior.', { unit: 'USD/month', computedBy: 'prior:service-price' });
    const serviceEcon = this.economics(serviceP, { cac: c.cac, gm: assumption(0.5, 0.35, 0.65, 'Service gross margin prior (labour-heavy).'), churn: c.churn });
    const marketplace = /\b(hire|hiring|freelanc|contractor|find (a|an)? ?(expert|consultant))\b/i.test(`${o.problem} ${o.title}`);
    const thirdP = marketplace
      ? assumption(round(p * 0.15 * 4, 2), round(p * 0.1, 2), round(p * 1.5, 2), 'Marketplace take-rate revenue per buyer per month (15% of ~4 transactions) — prior.', { unit: 'USD/month', computedBy: 'prior:take-rate' })
      : assumption(Math.round(p * 0.6), Math.round(p * 0.3), Math.round(p * 1.2), 'Digital product priced as one-off; expressed as monthly-equivalent over expected use.', { unit: 'USD/month', computedBy: 'prior:digital-product' });
    const thirdEcon = this.economics(thirdP, { cac: assumption(Number(c.cac.value) * 0.4, (c.cac.low ?? 10) * 0.3, (c.cac.high ?? 100) * 0.6, 'Lower CAC prior for low-touch products.'), gm: c.gm, churn: assumption(0.2, 0.1, 0.4, 'High churn prior for one-off / transactional usage.') });

    const saasModel: BusinessModel = c.isB2B ? 'b2b_saas' : 'b2c_app';
    return [
      {
        model: saasModel,
        title: `${c.isB2B ? 'Vertical SaaS' : 'Consumer app'} for ${topic}`,
        targetCustomer: customer,
        valueProposition: `Replace the manual, error-prone ${topic} work described in the evidence with a focused workspace that ${customer} can adopt in minutes.`,
        mvpSpec: { name: `${capital(kw[0] ?? 'Flow')}Desk`, tagline: `The simplest way to handle ${topic}`, coreFeatures: [`Track every ${entities[0]!.name.toLowerCase()} in one place`, 'Status workflow with owners and due dates', 'CSV import/export', 'Weekly summary email'], entities },
        pricing: { tiers: tiersFrom(p), metric: 'per workspace / month', kind: c.price.kind },
        distribution: this.channels(connectors),
        acquisitionExperiments: [
          { name: 'Landing page smoke test', channel: 'community + direct', hypothesis: '≥ 5% of visitors join the waitlist', costUsd: 0 },
          { name: 'Paid search probe', channel: 'search ads (approval required)', hypothesis: `CAC ≤ $${Math.round(Number(c.cac.value))}`, costUsd: 200 },
        ],
        retentionStrategy: ['Guided onboarding checklist', 'Weekly digest email', 'Integrations with the tools customers already use', 'Annual plan discount'],
        unitEconomics: saasEcon,
        expectedCosts: costs(/\b(ai|llm)\b/i.test(o.problem) ? [{ item: 'AI inference', monthlyUsd: 50 }] : []),
        experimentPlan: plan('≥ 5%'),
        technicalArchitecture: baseArch,
        score: this.hypothesisScore(oppScore, Number(saasEcon.ltvToCac.value), weeks),
        generatedBy: 'heuristic:templates',
      },
      {
        model: 'automation_service',
        title: `Done-for-you ${topic} service (concierge MVP)`,
        targetCustomer: customer,
        valueProposition: `We take ${topic} off your plate: you send the inputs, we deliver the result — manually at first, automating as patterns emerge.`,
        mvpSpec: { name: `${capital(kw[0] ?? 'Ops')} Concierge`, tagline: `${capital(topic)} handled for you`, coreFeatures: ['Intake form', 'Request tracking board', 'Delivery log and customer portal'], entities: [{ name: 'Request', fields: [{ name: 'title', type: 'string', required: true }, { name: 'customerEmail', type: 'email', required: true }, { name: 'status', type: 'string' }, { name: 'details', type: 'text' }] }] },
        pricing: { tiers: [{ name: 'Retainer', priceUsdMonthly: Math.round(Number(serviceP.value)), features: ['Up to 20 requests/month', '48h turnaround'] }], metric: 'per customer / month', kind: 'MODEL_ASSUMPTION' },
        distribution: ['Direct outreach to inbound leads', 'Referrals from first customers', ...this.channels(connectors).slice(2)],
        acquisitionExperiments: [{ name: 'Paid pilot offer', channel: 'direct', hypothesis: '≥ 2 of 10 qualified calls convert to a paid pilot', costUsd: 0 }],
        retentionStrategy: ['Monthly results review', 'SLA reporting', 'Gradual self-serve automation'],
        unitEconomics: serviceEcon,
        expectedCosts: costs([{ item: 'Operator time (opportunity cost)', monthlyUsd: 0 }]),
        experimentPlan: plan('≥ 3%'),
        technicalArchitecture: [...baseArch.slice(0, 3), 'Manual fulfilment behind a request board (concierge)'],
        score: this.hypothesisScore(oppScore, Number(serviceEcon.ltvToCac.value), 2),
        generatedBy: 'heuristic:templates',
      },
      {
        model: marketplace ? 'marketplace' : 'digital_product',
        title: marketplace ? `Marketplace connecting ${customer} with ${topic} specialists` : `${capital(topic)} playbook + templates`,
        targetCustomer: customer,
        valueProposition: marketplace ? 'Vetted specialists on demand, with transparent pricing.' : `A ready-to-use playbook and templates that solve the most common ${topic} problems today.`,
        mvpSpec: { name: marketplace ? `${capital(kw[0] ?? 'Expert')} Match` : `${capital(kw[0] ?? 'Ops')} Kit`, tagline: marketplace ? 'Find the right specialist fast' : 'Solve it this afternoon', coreFeatures: marketplace ? ['Request board', 'Specialist profiles', 'Transaction tracking'] : ['Template library', 'Checklist generator', 'Email capture'], entities: marketplace ? [{ name: 'Listing', fields: [{ name: 'title', type: 'string', required: true }, { name: 'budget', type: 'number' }, { name: 'contact', type: 'email' }, { name: 'details', type: 'text' }] }] : entities },
        pricing: { tiers: [{ name: marketplace ? 'Take rate' : 'One-off', priceUsdMonthly: Math.round(Number(thirdP.value)), features: marketplace ? ['15% commission'] : ['Lifetime access', 'Updates for 12 months'] }], metric: marketplace ? 'take rate' : 'one-off (monthly-equivalent)', kind: 'MODEL_ASSUMPTION' },
        distribution: this.channels(connectors),
        acquisitionExperiments: [{ name: 'Pre-order page', channel: 'community', hypothesis: '≥ 2% of visitors pre-order or request access', costUsd: 0 }],
        retentionStrategy: marketplace ? ['Repeat-buyer discounts', 'Specialist ratings'] : ['Update newsletter', 'Upsell to the SaaS variant'],
        unitEconomics: thirdEcon,
        expectedCosts: costs(),
        experimentPlan: plan('≥ 2%'),
        technicalArchitecture: baseArch.slice(0, 4),
        score: this.hypothesisScore(oppScore, Number(thirdEcon.ltvToCac.value), 1),
        generatedBy: 'heuristic:templates',
      },
    ];
  }

  private fromModelVariant(v: z.infer<typeof VariantSchema>, o: Opportunity, c: { cac: EstimatedValue; gm: EstimatedValue; churn: EstimatedValue; complexity: EstimatedValue; generatedBy: string }): HypothesisDraft {
    const lo = Math.min(v.priceMonthlyUsd.low, v.priceMonthlyUsd.mode);
    const hi = Math.max(v.priceMonthlyUsd.high, v.priceMonthlyUsd.mode);
    const price = assumption(v.priceMonthlyUsd.mode, lo, hi, 'Model-suggested price range — unverified until a pricing experiment runs.', { unit: 'USD/month', computedBy: c.generatedBy });
    const econ = this.economics(price, c);
    const weeks = 2 + Number(c.complexity.value) * 10;
    return {
      model: v.model,
      title: v.title,
      targetCustomer: v.targetCustomer,
      valueProposition: v.valueProposition,
      mvpSpec: { name: v.title.split(/[:—-]/)[0]!.trim().slice(0, 40), tagline: truncate(v.valueProposition, 90), coreFeatures: v.coreFeatures, entities: v.entities },
      pricing: { tiers: tiersFrom(v.priceMonthlyUsd.mode), metric: 'per account / month', kind: 'MODEL_ASSUMPTION' },
      distribution: v.distribution,
      acquisitionExperiments: [
        { name: 'Landing page smoke test', channel: v.distribution[0] ?? 'community', hypothesis: '≥ 5% visitor → signup', costUsd: 0 },
        { name: 'Paid probe', channel: 'ads (approval required)', hypothesis: `CAC ≤ $${Math.round(Number(c.cac.value))}`, costUsd: 200 },
      ],
      retentionStrategy: v.retention,
      unitEconomics: econ,
      expectedCosts: [
        { item: 'Hosting', monthlyUsd: 20, kind: 'MODEL_ASSUMPTION' },
        { item: 'Tooling', monthlyUsd: 30, kind: 'MODEL_ASSUMPTION' },
      ],
      experimentPlan: [
        { step: 'Landing page + waitlist', metric: 'visitor → signup', threshold: '≥ 5%' },
        { step: 'Concierge onboarding', metric: 'signup → activation', threshold: '≥ 40%' },
        { step: 'Paid pilot', metric: 'activated → paid', threshold: '≥ 10%' },
      ],
      technicalArchitecture: ['Generated Node.js MVP (zero dependencies)', 'JSON store → PostgreSQL (schema.sql)', 'ROOS tracking + approval-gated payments'],
      score: this.hypothesisScore(o.score ?? 0.4, Number(econ.ltvToCac.value), weeks),
      generatedBy: c.generatedBy,
    };
  }

  private async insertHypothesis(orgId: string, oppId: string, draft: HypothesisDraft): Promise<string> {
    const h = (await this.opportunities.isDemoOrg(orgId)) ? demoizeDeep(draft) : draft;
    const id = newId('hypothesis');
    await this.db.query(
      `INSERT INTO business_hypotheses (id, org_id, opportunity_id, model, title, target_customer, value_proposition, mvp_spec, pricing, distribution,
         acquisition_experiments, retention_strategy, unit_economics, expected_costs, experiment_plan, technical_architecture, score, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        id,
        orgId,
        oppId,
        h.model,
        h.title,
        h.targetCustomer,
        h.valueProposition,
        json(h.mvpSpec),
        json(h.pricing),
        json(h.distribution),
        json(h.acquisitionExperiments),
        json(h.retentionStrategy),
        json(h.unitEconomics),
        json(h.expectedCosts),
        json(h.experimentPlan),
        json(h.technicalArchitecture),
        h.score,
        h.generatedBy,
      ],
    );
    return id;
  }

  async selectHypothesis(orgId: string, oppId: string, hypothesisId: string, actor: Actor) {
    await this.db.query(`UPDATE business_hypotheses SET status = CASE WHEN id = $3 THEN 'selected' WHEN status = 'selected' THEN 'proposed' ELSE status END, updated_at = now() WHERE opportunity_id = $1 AND org_id = $2`, [oppId, orgId, hypothesisId]);
    await this.opportunities.update(orgId, oppId, { selectedHypothesisId: hypothesisId, status: 'validated' }, actor);
    await markStep(this.db, orgId, 'select_opportunity');
    return this.getHypothesis(orgId, hypothesisId);
  }

  async getHypothesis(orgId: string, id: string): Promise<BusinessHypothesis> {
    const row = await this.db.one('SELECT * FROM business_hypotheses WHERE id = $1 AND org_id = $2', [id, orgId]);
    if (!row) throw new Error(`Hypothesis ${id} not found`);
    return camelize<BusinessHypothesis>(row);
  }

  /** The hypothesis to build: explicitly selected, else the highest-scoring one. */
  async bestHypothesis(orgId: string, oppId: string): Promise<BusinessHypothesis | null> {
    const row = await this.db.one(`SELECT * FROM business_hypotheses WHERE opportunity_id = $1 AND org_id = $2 ORDER BY (status = 'selected') DESC, score DESC LIMIT 1`, [oppId, orgId]);
    return row ? camelize<BusinessHypothesis>(row) : null;
  }
}

function capital(s: string) {
  const w = s.split(' ')[0] ?? s;
  return w.charAt(0).toUpperCase() + w.slice(1);
}
