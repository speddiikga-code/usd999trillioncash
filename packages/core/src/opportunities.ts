import { buildCriteria, scoreOpportunity } from '@roos/analytics';
import type { Db } from '@roos/database';
import { json } from '@roos/database';
import {
  camelize,
  demoizeDeep,
  newId,
  NotFoundError,
  userInput,
  type Evidence,
  type EstimatedValue,
  type Opportunity,
  type OpportunityCreateInput,
  type OpportunitySignals,
  type OpportunityStatus,
  type ScoreBreakdown,
} from '@roos/shared';
import type { Actor, AuditService } from './audit';
import type { EventBus } from './events';
import type { StrategyService } from './strategy';

export const EMPTY_SIGNALS: OpportunitySignals = {
  documentCount: 0,
  distinctSources: 0,
  totalEngagement: 0,
  painScore: 0,
  willingnessToPayMentions: 0,
  competitorMentions: 0,
  keywords: [],
};

export interface EvidenceInput {
  documentId?: string | null;
  claim: string;
  quote?: string | null;
  kind: Evidence['kind'];
  sourceName: string;
  sourceUrl?: string | null;
  observedAt: string;
  confidence: number;
  provenance: Record<string, unknown>;
}

const toOpportunity = (r: Record<string, unknown>) => camelize<Opportunity>(r);
/** Evidence rows: the DB column `data_kind` maps to the API field `kind`. */
export const toEvidence = (r: Record<string, unknown>): Evidence => {
  const { dataKind, ...rest } = camelize<Record<string, unknown>>(r);
  return { ...rest, kind: dataKind } as unknown as Evidence;
};

const ESTIMATE_FIELDS = ['estimatedMarketSize', 'estimatedPrice', 'acquisitionCostEstimate', 'grossMarginEstimate', 'competition', 'technicalComplexity', 'regulatoryRisk', 'timeToMvp'] as const;

export class OpportunityService {
  private demoOrgs = new Map<string, boolean>();

  constructor(
    private db: Db,
    private audit: AuditService,
    private events: EventBus,
    private strategy: StrategyService,
  ) {}

  async isDemoOrg(orgId: string): Promise<boolean> {
    if (!this.demoOrgs.has(orgId)) this.demoOrgs.set(orgId, !!(await this.db.value<boolean>('SELECT is_demo FROM organizations WHERE id = $1', [orgId])));
    return this.demoOrgs.get(orgId)!;
  }

  /** In a demo workspace every estimate is derived from synthetic data → label it DEMO. */
  private async labelForOrg<T extends Record<string, unknown>>(orgId: string, o: T): Promise<T> {
    if (!(await this.isDemoOrg(orgId))) return o;
    const out: Record<string, unknown> = { ...o };
    for (const f of ESTIMATE_FIELDS) if (out[f]) out[f] = demoizeDeep(out[f]);
    return out as T;
  }

  async list(orgId: string, q: { status?: OpportunityStatus; q?: string; minScore?: number; sort?: 'score' | 'created' | 'updated'; limit?: number; offset?: number } = {}) {
    const params: unknown[] = [orgId];
    let where = 'o.org_id = $1';
    if (q.status) {
      params.push(q.status);
      where += ` AND o.status = $${params.length}`;
    } else where += ` AND o.status <> 'archived'`;
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      where += ` AND (lower(o.title) LIKE $${params.length} OR lower(o.problem) LIKE $${params.length} OR lower(o.customer) LIKE $${params.length})`;
    }
    if (q.minScore !== undefined) {
      params.push(q.minScore);
      where += ` AND o.score >= $${params.length}`;
    }
    const order = q.sort === 'created' ? 'o.created_at DESC' : q.sort === 'updated' ? 'o.updated_at DESC' : 'o.score DESC NULLS LAST, o.created_at DESC';
    params.push(q.limit ?? 50, q.offset ?? 0);
    const rows = await this.db.many(
      `SELECT o.*, (SELECT COUNT(*) FROM evidence e WHERE e.opportunity_id = o.id)::int AS evidence_count,
              (SELECT COUNT(*) FROM experiments x WHERE x.opportunity_id = o.id)::int AS experiment_count
       FROM opportunities o WHERE ${where} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const total = Number(await this.db.value(`SELECT COUNT(*) FROM opportunities o WHERE ${where}`, params.slice(0, -2)));
    return { items: rows.map(toOpportunity), total };
  }

  async get(orgId: string, id: string): Promise<Opportunity> {
    const row = await this.db.one('SELECT * FROM opportunities WHERE id = $1 AND org_id = $2', [id, orgId]);
    if (!row) throw new NotFoundError('Opportunity', id);
    return toOpportunity(row);
  }

  /** Resolve an id or unique id prefix (CLI convenience: `/analyze opp_01kb…`). */
  async resolveId(orgId: string, ref: string): Promise<string> {
    const exact = await this.db.value<string>('SELECT id FROM opportunities WHERE org_id = $1 AND id = $2', [orgId, ref]);
    if (exact) return exact;
    const rows = await this.db.many<{ id: string }>(`SELECT id FROM opportunities WHERE org_id = $1 AND id LIKE $2 LIMIT 2`, [orgId, `${ref.replace(/[%_]/g, '')}%`]);
    if (rows.length === 1) return rows[0]!.id;
    throw new NotFoundError('Opportunity', ref);
  }

  async detail(orgId: string, id: string) {
    const opp = await this.get(orgId, id);
    const [evidence, hypotheses, experiments, products, projects, scores] = await Promise.all([
      this.db.many('SELECT * FROM evidence WHERE opportunity_id = $1 AND org_id = $2 ORDER BY confidence DESC, observed_at DESC', [id, orgId]),
      this.db.many('SELECT * FROM business_hypotheses WHERE opportunity_id = $1 AND org_id = $2 ORDER BY score DESC', [id, orgId]),
      this.db.many('SELECT * FROM experiments WHERE opportunity_id = $1 AND org_id = $2 ORDER BY created_at DESC', [id, orgId]),
      this.db.many('SELECT id, name, status, url, write_key, launched_at, project_id FROM products WHERE opportunity_id = $1 AND org_id = $2', [id, orgId]),
      this.db.many('SELECT id, name, status, path, scan_result, test_result, created_at FROM projects WHERE opportunity_id = $1 AND org_id = $2 ORDER BY created_at DESC', [id, orgId]),
      this.db.many('SELECT score, low, high, confidence, weights_version, created_at FROM opportunity_scores WHERE opportunity_id = $1 ORDER BY created_at ASC LIMIT 100', [id]),
    ]);
    return {
      ...opp,
      evidence: evidence.map(toEvidence),
      hypotheses: hypotheses.map((r) => camelize(r)),
      experiments: experiments.map((r) => camelize(r)),
      products: products.map((r) => camelize(r)),
      projects: projects.map((r) => camelize(r)),
      scoreHistory: scores.map((r) => camelize(r)),
    };
  }

  async findByFingerprint(orgId: string, fingerprint: string): Promise<Opportunity | null> {
    const row = await this.db.one('SELECT * FROM opportunities WHERE org_id = $1 AND fingerprint = $2', [orgId, fingerprint]);
    return row ? toOpportunity(row) : null;
  }

  async insert(orgId: string, input: Partial<Opportunity> & { title: string; problem: string; customer: string; market: string; fingerprint?: string | null }, actor: Actor): Promise<Opportunity> {
    const o = await this.labelForOrg(orgId, input);
    const id = newId('opportunity');
    const row = await this.db.one(
      `INSERT INTO opportunities (id, org_id, title, problem, customer, market, source_urls, estimated_market_size, estimated_price, acquisition_cost_estimate,
         gross_margin_estimate, competition, technical_complexity, regulatory_risk, time_to_mvp, confidence, status, tags, industries, signals, fingerprint, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [
        id,
        orgId,
        o.title.slice(0, 200),
        o.problem.slice(0, 4000),
        o.customer.slice(0, 300),
        o.market.slice(0, 300),
        json(o.sourceUrls ?? []),
        json(o.estimatedMarketSize ?? null),
        json(o.estimatedPrice ?? null),
        json(o.acquisitionCostEstimate ?? null),
        json(o.grossMarginEstimate ?? null),
        json(o.competition ?? null),
        json(o.technicalComplexity ?? null),
        json(o.regulatoryRisk ?? null),
        json(o.timeToMvp ?? null),
        o.confidence ?? 0,
        o.status ?? 'discovered',
        json(o.tags ?? []),
        json(o.industries ?? []),
        json(o.signals ?? EMPTY_SIGNALS),
        o.fingerprint ?? null,
        o.createdBy ?? actor.id,
      ],
    );
    const opp = toOpportunity(row!);
    await this.audit.record({ orgId, actor, action: 'opportunity.create', targetType: 'opportunity', targetId: id, details: { title: opp.title } });
    await this.events.publish(orgId, 'opportunity.created', { entityType: 'opportunity', entityId: id, payload: { title: opp.title } });
    return opp;
  }

  /** Manual entry by an operator — all fields are USER_INPUT. */
  async createManual(orgId: string, input: OpportunityCreateInput, actor: Actor) {
    const opp = await this.insert(
      orgId,
      {
        title: input.title,
        problem: input.problem,
        customer: input.customer,
        market: input.market,
        tags: input.tags,
        industries: input.industries,
        sourceUrls: input.sourceUrls,
        estimatedPrice: input.estimatedPriceUsdMonthly !== undefined ? userInput(input.estimatedPriceUsdMonthly, 'Price entered by operator', { unit: 'USD/month' }) : null,
        createdBy: actor.id,
      },
      actor,
    );
    if (input.notes || input.sourceUrls.length) {
      await this.addEvidence(orgId, opp.id, [
        {
          claim: input.notes ?? 'Operator-provided sources',
          kind: 'USER_INPUT',
          sourceName: 'Operator',
          sourceUrl: input.sourceUrls[0] ?? null,
          observedAt: new Date().toISOString(),
          confidence: 0.5,
          provenance: { enteredBy: actor.id, sourceUrls: input.sourceUrls },
        },
      ]);
    }
    await this.rescore(orgId, opp.id);
    return this.get(orgId, opp.id);
  }

  async update(orgId: string, id: string, rawPatch: Record<string, unknown>, actor: Actor): Promise<Opportunity> {
    await this.get(orgId, id);
    const patch = await this.labelForOrg(orgId, rawPatch);
    const columns: Record<string, string> = {
      title: 'title',
      problem: 'problem',
      customer: 'customer',
      market: 'market',
      status: 'status',
      tags: 'tags',
      industries: 'industries',
      signals: 'signals',
      sourceUrls: 'source_urls',
      estimatedMarketSize: 'estimated_market_size',
      estimatedPrice: 'estimated_price',
      acquisitionCostEstimate: 'acquisition_cost_estimate',
      grossMarginEstimate: 'gross_margin_estimate',
      competition: 'competition',
      technicalComplexity: 'technical_complexity',
      regulatoryRisk: 'regulatory_risk',
      timeToMvp: 'time_to_mvp',
      selectedHypothesisId: 'selected_hypothesis_id',
      marketId: 'market_id',
    };
    const jsonCols = new Set(['tags', 'industries', 'signals', 'source_urls', 'estimated_market_size', 'estimated_price', 'acquisition_cost_estimate', 'gross_margin_estimate', 'competition', 'technical_complexity', 'regulatory_risk', 'time_to_mvp']);
    const sets: string[] = [];
    const params: unknown[] = [id, orgId];
    for (const [k, v] of Object.entries(patch)) {
      const col = columns[k];
      if (!col || v === undefined) continue;
      params.push(jsonCols.has(col) ? json(v) : v);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) return this.get(orgId, id);
    const row = await this.db.one(`UPDATE opportunities SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *`, params);
    const keys = Object.keys(patch).filter((k) => columns[k]);
    await this.audit.record({ orgId, actor, action: 'opportunity.update', targetType: 'opportunity', targetId: id, details: { fields: keys, status: patch.status } });
    await this.events.publish(orgId, 'opportunity.updated', { entityType: 'opportunity', entityId: id, payload: { fields: keys, status: patch.status } });
    return toOpportunity(row!);
  }

  async setStatus(orgId: string, id: string, status: OpportunityStatus, actor: Actor) {
    return this.update(orgId, id, { status }, actor);
  }

  async addEvidence(orgId: string, opportunityId: string, items: EvidenceInput[]): Promise<string[]> {
    const ids: string[] = [];
    for (const e of items) {
      if (e.documentId) {
        const dup = await this.db.one('SELECT id FROM evidence WHERE opportunity_id = $1 AND document_id = $2 AND claim = $3', [opportunityId, e.documentId, e.claim]);
        if (dup) continue;
      }
      const id = newId('evidence');
      await this.db.query(
        `INSERT INTO evidence (id, org_id, opportunity_id, document_id, claim, quote, data_kind, source_name, source_url, observed_at, confidence, provenance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, orgId, opportunityId, e.documentId ?? null, e.claim.slice(0, 1000), e.quote?.slice(0, 1200) ?? null, e.kind, e.sourceName, e.sourceUrl ?? null, e.observedAt, e.confidence, json(e.provenance)],
      );
      ids.push(id);
    }
    const urls = await this.db.many<{ source_url: string }>(`SELECT DISTINCT source_url FROM evidence WHERE opportunity_id = $1 AND source_url IS NOT NULL LIMIT 50`, [opportunityId]);
    await this.db.query('UPDATE opportunities SET source_urls = $2, updated_at = now() WHERE id = $1', [opportunityId, json(urls.map((u) => u.source_url))]);
    return ids;
  }

  async saveScore(orgId: string, id: string, breakdown: ScoreBreakdown) {
    await this.db.query('UPDATE opportunities SET score = $3, confidence = $4, score_breakdown = $5, updated_at = now() WHERE id = $1 AND org_id = $2', [id, orgId, breakdown.score, breakdown.confidence, json(breakdown)]);
    await this.db.query(`INSERT INTO opportunity_scores (org_id, opportunity_id, score, low, high, confidence, breakdown, weights_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      orgId,
      id,
      breakdown.score,
      breakdown.low,
      breakdown.high,
      breakdown.confidence,
      json(breakdown),
      breakdown.weightsVersion,
    ]);
    await this.events.publish(orgId, 'opportunity.scored', { entityType: 'opportunity', entityId: id, payload: { score: breakdown.score, low: breakdown.low, high: breakdown.high } });
  }

  /** Recompute the score from the stored estimates, observed signals and the active weights. */
  async rescore(orgId: string, id: string, extra: { strategicFit?: EstimatedValue | null; distributionDifficulty?: EstimatedValue | null; isB2B?: boolean } = {}): Promise<ScoreBreakdown> {
    const opp = await this.get(orgId, id);
    const org = await this.db.one<{ is_demo: boolean }>('SELECT is_demo FROM organizations WHERE id = $1', [orgId]);
    const weeks = opp.timeToMvp;
    const criteria = buildCriteria({
      signals: opp.signals ?? EMPTY_SIGNALS,
      marketSize: opp.estimatedMarketSize,
      priceMonthly: opp.estimatedPrice,
      technicalComplexity: opp.technicalComplexity,
      regulatoryRisk: opp.regulatoryRisk,
      timeToMvpWeeks: weeks,
      competition: opp.competition,
      distributionDifficulty: extra.distributionDifficulty ?? (opp.scoreBreakdown ? pickEstimate(opp.scoreBreakdown, 'distribution_ease', true) : null),
      strategicFit: extra.strategicFit ?? (opp.scoreBreakdown ? pickEstimate(opp.scoreBreakdown, 'strategic_fit', false) : null),
      isB2B: extra.isB2B ?? opp.tags.includes('b2b'),
      demo: !!org?.is_demo,
    });
    const { weights, version } = await this.strategy.activeWeights(orgId);
    const breakdown = scoreOpportunity(criteria, { weights, weightsVersion: version, seed: id });
    await this.saveScore(orgId, id, breakdown);
    return breakdown;
  }
}

/** Carry a previously computed criterion forward as an estimate (so rescoring keeps it). */
function pickEstimate(b: ScoreBreakdown, key: string, invert: boolean): EstimatedValue | null {
  const c = b.criteria.find((x) => x.key === key);
  if (!c || c.kind === 'MODEL_ASSUMPTION') return null;
  const t = (v: number) => (invert ? 1 - v : v);
  return { value: t(c.value), low: Math.min(t(c.low), t(c.high)), high: Math.max(t(c.low), t(c.high)), kind: c.kind, confidence: 0.5, rationale: c.rationale };
}
