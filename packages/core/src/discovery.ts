import type { CallContext, ModelRouter } from '@roos/ai';
import { clusterDocuments, detectSignals, topKeywords, type TextSignals } from '@roos/analytics';
import {
  buildConnectorContext,
  DEFAULT_DISCOVERY_CONNECTORS,
  engagementScore,
  getConnector,
  runConnector,
  type ConnectorContext,
  type ConnectorSecrets,
  type FetchedDocument,
} from '@roos/connectors';
import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { sanitizeUntrustedText, scanForInjection, wrapUntrusted } from '@roos/security';
import {
  errorMessage,
  newId,
  sha256Hex,
  truncate,
  unique,
  z,
  type AppConfig,
  type DiscoverInput,
  type Logger,
  type OpportunitySignals,
  type SourceRef,
} from '@roos/shared';
import type { Actor } from './audit';
import type { EventBus } from './events';
import {
  cacPrior,
  competitionFromEvidence,
  complexityEstimate,
  distributionEstimate,
  extractPriceMentions,
  grossMarginPrior,
  marketSizeEstimate,
  priceEstimate,
  primarySegment,
  regulatoryEstimate,
  strategicFitEstimate,
  timeToMvpEstimate,
} from './estimates';
import { PostgresGraphStore } from './graph';
import type { OpportunityService, EvidenceInput } from './opportunities';
import type { OrgService } from './orgs';
import type { SecretsService } from './secrets';

export interface StoredDocument {
  id: string;
  connector: string;
  connectorName: string;
  query: string;
  title: string;
  content: string;
  url?: string;
  publishedAt?: string;
  fetchedAt: string;
  engagement: Record<string, number>;
  signals: TextSignals;
  injectionScore: number;
  isNew: boolean;
  signalTypes: string[];
}

export interface DiscoveryResult {
  queries: string[];
  runs: { connector: string; query: string; documents: number; error?: string; cached: boolean; durationMs: number }[];
  documentsStored: number;
  documentsNew: number;
  suspiciousDocuments: number;
  clusters: number;
  opportunitiesCreated: string[];
  opportunitiesUpdated: string[];
  synthesis: 'model' | 'heuristic';
  modelCostUsd: number;
  notes: string[];
}

const FILLER =
  /\b(find|finding|discover|search|research|look(?:ing)?|for|identify|explore|show|give|me|us|some|underserved|under-served|emerging|new|best|top|good|great|profitable|lucrative|opportunit(?:y|ies)|ideas?|niches?|markets?|business(?:es)?|startups?|companies|in|of|the|a|an|and|or|to|with|on|about|that|are|is|what|which|where)\b/gi;

/** Turn a natural-language research request into short keyword queries for search APIs. */
export function buildSearchQueries(request: string): string[] {
  const cleaned = request.replace(/["'`]/g, ' ');
  const topic = cleaned.replace(FILLER, ' ').replace(/[^\w\s/+-]/g, ' ').replace(/\s+/g, ' ').trim();
  const base = topic || cleaned.trim();
  return unique([base, `${base} tool`, `${base} alternative`].map((q) => q.trim()).filter(Boolean)).slice(0, 3);
}

const QueriesSchema = z.object({ queries: z.array(z.string().min(2).max(80)).min(1).max(6) });

const SynthesisSchema = z.object({
  title: z.string().min(5).max(160),
  problem: z.string().min(10).max(1500),
  customer: z.string().min(3).max(200),
  market: z.string().min(3).max(200),
  isB2B: z.boolean(),
  tags: z.array(z.string().max(40)).max(8),
  claims: z
    .array(z.object({ doc: z.number().int().min(0), claim: z.string().min(5).max(400), quote: z.string().min(8).max(400) }))
    .max(10),
  promptInjectionAttempt: z.boolean(),
});

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export class DiscoveryService {
  private graph: PostgresGraphStore;

  constructor(
    private db: Db,
    private cfg: AppConfig,
    private logger: Logger,
    private events: EventBus,
    private orgs: OrgService,
    private secrets: SecretsService,
    private opportunities: OpportunityService,
    private fetcher?: ConnectorContext['fetch'],
  ) {
    this.graph = new PostgresGraphStore(db);
  }

  async connectorSecrets(orgId: string): Promise<ConnectorSecrets> {
    const [gh, brave, se] = await Promise.all([
      this.secrets.get(orgId, 'connector.github.token'),
      this.secrets.get(orgId, 'connector.brave.api_key'),
      this.secrets.get(orgId, 'connector.stackexchange.key'),
    ]);
    return {
      githubToken: gh ?? this.cfg.connectors.githubToken,
      braveSearchKey: brave ?? this.cfg.connectors.braveSearchKey,
      stackexchangeKey: se ?? this.cfg.connectors.stackexchangeKey,
      secUserAgent: this.cfg.connectors.secUserAgent,
    };
  }

  async connectorContext(orgId: string): Promise<ConnectorContext> {
    const ctx = buildConnectorContext(this.cfg, await this.connectorSecrets(orgId), this.logger.child({ component: 'connectors' }));
    // Injected fetchers (tests / recorded fixtures) do not hit real services, so no politeness delay.
    return this.fetcher ? { ...ctx, fetch: this.fetcher, politenessScale: 0 } : ctx;
  }

  /** Configured source rows for the org (auto-creating defaults on first use). */
  async sources(orgId: string) {
    return this.db.many<{ id: string; connector: string; name: string; enabled: boolean; config: Record<string, unknown> }>('SELECT * FROM sources WHERE org_id = $1 ORDER BY connector, name', [orgId]);
  }

  async ensureDefaultSources(orgId: string) {
    for (const c of DEFAULT_DISCOVERY_CONNECTORS) {
      await this.db.query(`INSERT INTO sources (id, org_id, connector, name, config) VALUES ($1,$2,$3,'default','{}') ON CONFLICT (org_id, connector, name) DO NOTHING`, [newId('source'), orgId, c]);
    }
  }

  async scan(orgId: string, input: DiscoverInput, opts: { router?: ModelRouter | null; callCtx?: CallContext; actor: Actor }): Promise<DiscoveryResult> {
    const notes: string[] = [];
    const org = await this.orgs.get(orgId);
    const router = opts.router && opts.router.available() ? opts.router : null;
    let modelCostUsd = 0;

    // 1. Queries
    let queries = buildSearchQueries(input.query);
    if (router) {
      try {
        const { data, meta } = await router.generateJson(
          {
            purpose: 'research.extract_queries',
            tier: 'fast',
            system: 'You turn a business research request into short keyword search queries for public APIs (Hacker News, Stack Exchange, GitHub issues, Federal Register). Queries must be 1-5 words, concrete nouns/phrases people would actually write when describing a problem.',
            prompt: `Research request: ${JSON.stringify(input.query)}\nIndustries of interest: ${JSON.stringify(input.industries ?? org.settings.industries ?? [])}\nReturn {"queries": [...]} with 3-5 queries.`,
            maxOutputTokens: 1000,
          },
          QueriesSchema,
          opts.callCtx,
        );
        modelCostUsd += meta.costUsd;
        queries = unique([...data.queries.map((q) => q.trim()), queries[0]!]).slice(0, 5);
      } catch (e) {
        notes.push(`Query generation by model failed (${errorMessage(e)}); used keyword heuristic.`);
      }
    }

    // 2. Sources
    await this.ensureDefaultSources(orgId);
    const configured = await this.sources(orgId);
    const wanted = input.sources?.length ? input.sources : configured.filter((s) => s.enabled).map((s) => s.connector);
    const connectorIds = unique(wanted.length ? wanted : DEFAULT_DISCOVERY_CONNECTORS).filter((id) => getConnector(id));
    const ctx = await this.connectorContext(orgId);

    // 3. Fetch (connectors in parallel; queries sequential within a connector for politeness)
    const runs: DiscoveryResult['runs'] = [];
    const fetched: { connector: string; query: string; docs: FetchedDocument[]; sourceId?: string }[] = [];
    await Promise.all(
      connectorIds.map(async (cid) => {
        const def = getConnector(cid)!;
        const src = configured.find((s) => s.connector === cid && s.enabled) ?? configured.find((s) => s.connector === cid);
        const qs = def.queryable ? queries : [input.query];
        for (const q of qs) {
          const r = await runConnector(def, q, { limit: input.limitPerSource ?? 30, config: src?.config ?? {} }, ctx);
          runs.push({ connector: cid, query: q, documents: r.documents.length, error: r.error, cached: r.cached, durationMs: r.durationMs });
          fetched.push({ connector: cid, query: q, docs: r.documents, sourceId: src?.id });
          if (!def.queryable) break;
        }
        const errs = runs.filter((r) => r.connector === cid && r.error);
        if (src) {
          await this.db.query(`UPDATE sources SET last_run_at = now(), last_status = $3, last_error = $4, documents_fetched = documents_fetched + $5, updated_at = now() WHERE id = $1 AND org_id = $2`, [
            src.id,
            orgId,
            errs.length === qs.length ? 'error' : 'ok',
            errs[0]?.error ?? null,
            runs.filter((r) => r.connector === cid).reduce((a, r) => a + r.documents, 0),
          ]);
        }
      }),
    );

    // 4. Store documents (sanitised, injection-scanned, signal-annotated)
    const stored: StoredDocument[] = [];
    const seen = new Set<string>();
    for (const f of fetched) {
      const def = getConnector(f.connector)!;
      for (const d of f.docs) {
        const hash = sha256Hex(`${f.connector}|${d.externalId ?? d.url ?? d.title}`);
        if (seen.has(hash)) continue;
        seen.add(hash);
        stored.push(await this.storeDocument(orgId, f.connector, def.name, def.signalTypes, f.sourceId, f.query, d, hash));
      }
    }
    const suspicious = stored.filter((d) => d.injectionScore >= 0.5).length;
    if (suspicious) notes.push(`${suspicious} document(s) contained prompt-injection-like text; they are kept as data, flagged, and down-weighted.`);

    // 5. Cluster documents carrying pain/demand signals
    const painDocs = stored.filter((d) => d.signalTypes.some((t) => ['pain_points', 'demand', 'jobs'].includes(t)) && (d.signals.painScore > 0 || d.signals.seekingMentions > 0 || d.signals.wtpMentions > 0));
    const contextDocs = stored.filter((d) => d.signalTypes.includes('regulatory'));
    let clusters = clusterDocuments(
      painDocs.map((d) => ({ id: d.id, text: `${d.title}\n${d.content.slice(0, 2500)}` })),
      { threshold: 0.1, minSize: 2, maxClusters: 8 },
    );
    if (!clusters.length) {
      const strong = painDocs
        .filter((d) => d.signals.painScore >= 0.3)
        .sort((a, b) => b.signals.painScore * Math.log(2 + engagementScore(b.engagement)) - a.signals.painScore * Math.log(2 + engagementScore(a.engagement)))
        .slice(0, 4);
      clusters = strong.map((d) => ({ ids: [d.id], keywords: topKeywords([`${d.title} ${d.content}`], 6), cohesion: 1 }));
      if (strong.length) notes.push('Too few related documents to cluster; created single-document candidates with low confidence.');
    }
    if (!painDocs.length) notes.push('No documents with pain/demand signals were found for these queries. Try broader or different queries.');

    // 6. Opportunities
    const created: string[] = [];
    const updated: string[] = [];
    let usedModel = false;
    for (const c of clusters) {
      const docs = c.ids
        .map((id) => stored.find((d) => d.id === id)!)
        .sort((a, b) => b.signals.painScore * Math.log(2 + engagementScore(b.engagement)) - a.signals.painScore * Math.log(2 + engagementScore(a.engagement)));
      try {
        const r = await this.upsertOpportunityFromCluster(orgId, org.settings.industries ?? input.industries, c.keywords, docs, contextDocs, router, opts);
        modelCostUsd += r.costUsd;
        usedModel ||= r.usedModel;
        (r.created ? created : updated).push(r.opportunityId);
      } catch (e) {
        notes.push(`Failed to build opportunity from cluster [${c.keywords.slice(0, 3).join(', ')}]: ${errorMessage(e)}`);
        this.logger.warn('Cluster synthesis failed', { error: errorMessage(e) });
      }
    }

    const result: DiscoveryResult = {
      queries,
      runs,
      documentsStored: stored.length,
      documentsNew: stored.filter((d) => d.isNew).length,
      suspiciousDocuments: suspicious,
      clusters: clusters.length,
      opportunitiesCreated: created,
      opportunitiesUpdated: updated,
      synthesis: usedModel ? 'model' : 'heuristic',
      modelCostUsd,
      notes,
    };
    await this.events.publish(orgId, 'research.completed', { payload: { query: input.query, created: created.length, updated: updated.length, documents: stored.length } });
    if (created.length || updated.length) await this.orgs.markOnboarding(orgId, 'first_scan').catch(() => undefined);
    return result;
  }

  private async storeDocument(orgId: string, connector: string, connectorName: string, signalTypes: string[], sourceId: string | undefined, query: string, d: FetchedDocument, hash: string): Promise<StoredDocument> {
    const content = sanitizeUntrustedText(d.content, 20_000);
    const title = sanitizeUntrustedText(d.title, 300);
    const inj = scanForInjection(`${title}\n${content}`);
    const signals = detectSignals(`${title}\n${content}`);
    const row = await this.db.one<{ id: string; inserted: boolean; fetched_at: Date }>(
      `INSERT INTO documents (id, org_id, source_id, connector, external_id, url, title, content, content_hash, author, published_at, engagement, signals, injection_score, query, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (org_id, content_hash) DO UPDATE SET engagement = EXCLUDED.engagement, signals = EXCLUDED.signals, fetched_at = now()
       RETURNING id, (xmax = 0) AS inserted, fetched_at`,
      [
        newId('document'),
        orgId,
        sourceId ?? null,
        connector,
        d.externalId ?? null,
        d.url ?? null,
        title,
        content,
        hash,
        d.author?.slice(0, 200) ?? null,
        d.publishedAt ?? null,
        json(d.engagement),
        json(signals),
        inj.score,
        query,
        json({ ...d.metadata, injection: inj.suspicious ? inj.matches : undefined }),
      ],
    );
    return {
      id: row!.id,
      connector,
      connectorName,
      query,
      title,
      content,
      url: d.url,
      publishedAt: d.publishedAt,
      fetchedAt: new Date(row!.fetched_at).toISOString(),
      engagement: d.engagement,
      signals,
      injectionScore: inj.score,
      isNew: row!.inserted,
      signalTypes,
    };
  }

  private aggregateSignals(docs: StoredDocument[], keywords: string[]): OpportunitySignals {
    const dates = docs.map((d) => d.publishedAt ?? d.fetchedAt).filter(Boolean).sort();
    return {
      documentCount: docs.length,
      distinctSources: new Set(docs.map((d) => d.connector)).size,
      totalEngagement: docs.reduce((a, d) => a + engagementScore(d.engagement), 0),
      painScore: docs.length ? Math.round((docs.reduce((a, d) => a + d.signals.painScore * (d.injectionScore >= 0.5 ? 0.3 : 1), 0) / docs.length) * 1000) / 1000 : 0,
      willingnessToPayMentions: docs.reduce((a, d) => a + d.signals.wtpMentions, 0),
      competitorMentions: docs.reduce((a, d) => a + d.signals.competitorMentions, 0),
      newestEvidenceAt: dates[dates.length - 1],
      oldestEvidenceAt: dates[0],
      keywords: keywords.slice(0, 8),
    };
  }

  private async upsertOpportunityFromCluster(
    orgId: string,
    industries: string[] | undefined,
    keywords: string[],
    docs: StoredDocument[],
    contextDocs: StoredDocument[],
    router: ModelRouter | null,
    opts: { callCtx?: CallContext; actor: Actor },
  ): Promise<{ opportunityId: string; created: boolean; usedModel: boolean; costUsd: number }> {
    const top = docs.slice(0, 8);
    const text = top.map((d) => `${d.title}\n${d.content}`).join('\n\n');
    const seg = primarySegment(text);
    const sources: SourceRef[] = top.slice(0, 5).map((d) => ({ name: d.connectorName, url: d.url, retrievedAt: d.fetchedAt, connector: d.connector }));
    const fingerprint = keywords.slice(0, 3).sort().join('|') || sha256Hex(top.map((d) => d.id).join()).slice(0, 16);

    // Evidence: observed quotes straight from the source documents.
    const evidence: EvidenceInput[] = top.map((d) => {
      const m = d.signals.matches[0];
      const labels = unique(d.signals.matches.map((x) => x.label));
      return {
        documentId: d.id,
        claim: labels.length ? `Observed ${labels.join(', ')} signal(s) in "${truncate(d.title, 120)}"` : `Related discussion: "${truncate(d.title, 120)}"`,
        quote: m?.excerpt ?? truncate(d.content, 280),
        kind: 'OBSERVED',
        sourceName: d.connectorName,
        sourceUrl: d.url ?? null,
        observedAt: d.publishedAt ?? d.fetchedAt,
        confidence: d.injectionScore >= 0.5 ? 0.3 : 0.8,
        provenance: { connector: d.connector, documentId: d.id, query: d.query, matchedPatterns: labels, engagement: d.engagement, retrievedAt: d.fetchedAt, injectionScore: d.injectionScore },
      };
    });

    // Related regulatory activity (keyword overlap with the cluster).
    const kwTokens = keywords.flatMap((k) => k.split(' '));
    for (const r of contextDocs) {
      const hay = `${r.title} ${r.content}`.toLowerCase();
      const overlap = kwTokens.filter((t) => t.length > 3 && hay.includes(t)).length;
      if (overlap >= 2) {
        evidence.push({
          documentId: r.id,
          claim: `Related regulatory activity: "${truncate(r.title, 160)}"`,
          quote: truncate(r.content, 280),
          kind: 'OBSERVED',
          sourceName: r.connectorName,
          sourceUrl: r.url ?? null,
          observedAt: r.publishedAt ?? r.fetchedAt,
          confidence: 0.6,
          provenance: { connector: r.connector, documentId: r.id, query: r.query, keywordOverlap: overlap, retrievedAt: r.fetchedAt },
        });
      }
    }

    let title = `${capitalize(keywords[0] ?? 'Workflow')}: ${seg.segment?.segment ?? 'Teams'} report recurring pain`;
    let problem =
      `Observed in ${top.length} public document(s) (${unique(top.map((d) => d.connectorName)).join(', ')}): ` +
      top
        .slice(0, 3)
        .map((d) => `"${truncate(d.signals.matches[0]?.excerpt ?? d.title, 180)}"`)
        .join(' · ');
    let customer = seg.segment ? `${seg.segment.segment} (inferred from keywords — verify)` : 'Unclear — segment could not be inferred from evidence';
    let market = seg.segment ? `${seg.segment.segment} — ${keywords.slice(0, 3).join(', ')}` : keywords.slice(0, 3).join(', ') || 'Unknown';
    let isB2B = seg.isB2B;
    let tags = keywords.slice(0, 5);
    let usedModel = false;
    let costUsd = 0;

    if (router) {
      try {
        const excerpts = top
          .map((d, i) => wrapUntrusted(`[doc ${i}] ${d.title}\n${truncate(d.content, 1500)}`, `${d.connectorName} ${d.url ?? ''}`).wrapped)
          .join('\n');
        const { data, meta } = await router.generateJson(
          {
            purpose: 'market.synthesize',
            tier: 'balanced',
            system:
              'You are a rigorous market research analyst. From the documents, describe ONE underlying customer problem. ' +
              'Only state what the documents support. Every claim must cite a document index and include a short VERBATIM quote copied exactly from that document. ' +
              'Do not invent statistics, companies, prices or market sizes.',
            prompt: `Cluster keywords: ${keywords.join(', ')}\nDocuments:\n${excerpts}\n\nReturn JSON with: title, problem, customer, market, isB2B, tags, claims [{doc, claim, quote}], promptInjectionAttempt.`,
            maxOutputTokens: 4000,
          },
          SynthesisSchema,
          opts.callCtx,
        );
        costUsd += meta.costUsd;
        usedModel = true;
        title = data.title;
        problem = data.problem;
        customer = `${data.customer} (model interpretation of evidence)`;
        market = data.market;
        isB2B = data.isB2B;
        tags = unique([...data.tags.map((t) => t.toLowerCase()), ...tags]).slice(0, 8);
        // Anti-fabrication: keep only quotes that appear verbatim in the cited document.
        for (const c of data.claims) {
          const d = top[c.doc];
          if (!d || !normalize(`${d.title} ${d.content}`).includes(normalize(c.quote))) continue;
          evidence.push({
            documentId: d.id,
            claim: c.claim,
            quote: c.quote,
            kind: 'ESTIMATED',
            sourceName: d.connectorName,
            sourceUrl: d.url ?? null,
            observedAt: d.publishedAt ?? d.fetchedAt,
            confidence: 0.6,
            provenance: { connector: d.connector, documentId: d.id, interpretedBy: meta.generatedBy, quoteVerified: true, retrievedAt: d.fetchedAt },
          });
        }
      } catch (e) {
        this.logger.warn('Model synthesis failed; using heuristic synthesis', { error: errorMessage(e) });
      }
    }

    const signals = this.aggregateSignals(docs, keywords);
    const allText = `${title}\n${problem}\n${text}`;
    const price = priceEstimate(isB2B, extractPriceMentions(top.map((d) => d.content)), sources);
    const complexity = complexityEstimate(allText);
    const regulatory = regulatoryEstimate(allText);
    const { flags, ...regulatoryRisk } = regulatory;
    const fit = strategicFitEstimate(allText, industries);
    const distribution = distributionEstimate(unique(top.map((d) => d.connector)));
    if (isB2B && !tags.includes('b2b')) tags.push('b2b');

    const existing = await this.opportunities.findByFingerprint(orgId, fingerprint);
    let oppId: string;
    let created = false;
    if (existing) {
      oppId = existing.id;
      await this.opportunities.addEvidence(orgId, oppId, evidence);
      const merged = await this.recomputeSignalsFromEvidence(orgId, oppId, keywords);
      await this.opportunities.update(orgId, oppId, { signals: merged, regulatoryRisk, technicalComplexity: complexity }, opts.actor);
    } else {
      const opp = await this.opportunities.insert(
        orgId,
        {
          title,
          problem,
          customer,
          market,
          fingerprint,
          tags,
          industries: industries?.filter((i) => allText.toLowerCase().includes(i.toLowerCase())) ?? [],
          signals,
          estimatedPrice: price,
          estimatedMarketSize: marketSizeEstimate(seg.segment, price),
          acquisitionCostEstimate: cacPrior(isB2B),
          grossMarginEstimate: grossMarginPrior(/\b(ai|llm|gpt|model)\b/i.test(allText)),
          technicalComplexity: complexity,
          regulatoryRisk,
          timeToMvp: timeToMvpEstimate(Number(complexity.value)),
          competition: competitionFromEvidence(top.map((d) => d.content)),
          createdBy: opts.actor.id,
        },
        opts.actor,
      );
      oppId = opp.id;
      created = true;
      await this.opportunities.addEvidence(orgId, oppId, evidence);
    }
    await this.opportunities.rescore(orgId, oppId, { strategicFit: fit, distributionDifficulty: distribution, isB2B });
    const competitors = competitionFromEvidence(top.map((d) => d.content)).competitors.map((c) => c.name);
    await this.linkGraph(orgId, oppId, title, keywords, seg.all, flags.map((f) => f.area), unique(top.map((d) => d.connector)), competitors);
    return { opportunityId: oppId, created, usedModel, costUsd };
  }

  private async recomputeSignalsFromEvidence(orgId: string, oppId: string, keywords: string[]): Promise<OpportunitySignals> {
    const rows = await this.db.many<Record<string, any>>(
      `SELECT DISTINCT d.* FROM evidence e JOIN documents d ON d.id = e.document_id WHERE e.opportunity_id = $1 AND e.org_id = $2`,
      [oppId, orgId],
    );
    const docs: StoredDocument[] = rows.map((r) => ({
      id: r.id,
      connector: r.connector,
      connectorName: r.connector,
      query: r.query,
      title: r.title,
      content: r.content,
      url: r.url,
      publishedAt: r.published_at ? new Date(r.published_at).toISOString() : undefined,
      fetchedAt: new Date(r.fetched_at).toISOString(),
      engagement: r.engagement,
      signals: r.signals,
      injectionScore: r.injection_score,
      isNew: false,
      signalTypes: [],
    }));
    return this.aggregateSignals(docs.filter((d) => d.signals?.matches), keywords);
  }

  private async linkGraph(orgId: string, oppId: string, title: string, keywords: string[], segments: string[], regulations: string[], connectors: string[], competitors: string[] = []) {
    const g = this.graph;
    const oppNode = await g.upsertNode(orgId, 'opportunity', oppId, title, { opportunityId: oppId });
    const pain = keywords[0] ? await g.upsertNode(orgId, 'pain_point', PostgresGraphStore.key(keywords.slice(0, 2).join(' ')), keywords.slice(0, 2).join(' / ')) : null;
    if (pain) await g.upsertEdge(orgId, oppNode, pain, 'addresses');
    for (const s of segments) {
      const n = await g.upsertNode(orgId, 'customer_segment', PostgresGraphStore.key(s), s);
      await g.upsertEdge(orgId, oppNode, n, 'targets');
      if (pain) await g.upsertEdge(orgId, n, pain, 'experiences');
    }
    for (const r of regulations) {
      const n = await g.upsertNode(orgId, 'regulation', PostgresGraphStore.key(r), r);
      await g.upsertEdge(orgId, oppNode, n, 'subject_to');
    }
    for (const c of connectors) {
      const n = await g.upsertNode(orgId, 'source', c, getConnector(c)?.name ?? c);
      await g.upsertEdge(orgId, oppNode, n, 'evidenced_by');
    }
    const techs = unique(keywords.flatMap((k) => k.split(' ')).filter((t) => TECH_TERMS.test(t)));
    for (const t of techs.slice(0, 6)) {
      const n = await g.upsertNode(orgId, 'technology', PostgresGraphStore.key(t), t);
      await g.upsertEdge(orgId, oppNode, n, 'uses_or_affects', { weight: 0.5 });
    }
    for (const c of competitors.slice(0, 6)) {
      const n = await g.upsertNode(orgId, 'competitor', PostgresGraphStore.key(c), c, { source: 'observed mention' });
      await g.upsertEdge(orgId, oppNode, n, 'competes_with');
    }
  }
}

/** Vocabulary used to recognise technology keywords for the knowledge graph. */
const TECH_TERMS =
  /^(ai|llm|gpt|api|sdk|saas|excel|spreadsheet|sql|postgres|kubernetes|k8s|docker|aws|azure|gcp|shopify|quickbooks|xero|salesforce|hubspot|slack|notion|zapier|stripe|github|react|python|javascript|typescript|iot|blockchain|crypto|ocr|pdf|csv|erp|crm|ats|ehr|emr|webhook|oauth|mobile|ios|android)$/i;

function capitalize(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
