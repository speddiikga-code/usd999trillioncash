import { createRouter, DEFAULT_PRICING, PricingTable, type BudgetGuard, type ModelCallRecord, type ModelRouter } from '@roos/ai';
import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { BudgetExceededError, newId, round, type AppConfig, type Logger } from '@roos/shared';
import type { OrgService } from './orgs';
import type { SecretsService } from './secrets';

/**
 * Builds a provider-agnostic model router per organisation (keys from the environment, overridden
 * by the organisation's encrypted secrets), records every call to `model_calls`, keeps pricing in
 * `model_costs`, and enforces AI budgets (per task and per organisation per day).
 */
export class AiService {
  private routers = new Map<string, { router: ModelRouter; at: number }>();
  private pricing: PricingTable | null = null;

  constructor(
    private db: Db,
    private cfg: AppConfig,
    private secrets: SecretsService,
    private orgs: OrgService,
    private logger: Logger,
  ) {}

  async seedPricing() {
    for (const p of DEFAULT_PRICING) {
      await this.db.query(
        `INSERT INTO model_costs (provider, model, tier, input_per_mtok_usd, output_per_mtok_usd, context_window, source_note) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (provider, model) DO UPDATE SET input_per_mtok_usd = EXCLUDED.input_per_mtok_usd, output_per_mtok_usd = EXCLUDED.output_per_mtok_usd,
           tier = EXCLUDED.tier, source_note = EXCLUDED.source_note, updated_at = now() WHERE model_costs.user_override = false`,
        [p.provider, p.model, p.tier, p.inputPerMtok, p.outputPerMtok, p.contextWindow ?? null, p.sourceNote],
      );
    }
    this.pricing = null;
  }

  async pricingTable(): Promise<PricingTable> {
    if (this.pricing) return this.pricing;
    const rows = await this.db.many<{ provider: string; model: string; input_per_mtok_usd: number; output_per_mtok_usd: number }>('SELECT * FROM model_costs');
    this.pricing = new PricingTable(rows.length ? rows.map((r) => ({ provider: r.provider, model: r.model, inputPerMtok: r.input_per_mtok_usd, outputPerMtok: r.output_per_mtok_usd })) : DEFAULT_PRICING);
    return this.pricing;
  }

  async setPrice(provider: string, model: string, tier: 'fast' | 'balanced' | 'deep', inputPerMtok: number, outputPerMtok: number, note: string) {
    await this.db.query(
      `INSERT INTO model_costs (provider, model, tier, input_per_mtok_usd, output_per_mtok_usd, source_note, user_override) VALUES ($1,$2,$3,$4,$5,$6,true)
       ON CONFLICT (provider, model) DO UPDATE SET input_per_mtok_usd = $4, output_per_mtok_usd = $5, tier = $3, source_note = $6, user_override = true, updated_at = now()`,
      [provider, model, tier, inputPerMtok, outputPerMtok, note],
    );
    this.pricing = null;
    this.routers.clear();
  }

  async providerKeys(orgId: string) {
    const [anthropic, openai, google, ollama] = await Promise.all([
      this.secrets.get(orgId, 'ai.anthropic.api_key'),
      this.secrets.get(orgId, 'ai.openai.api_key'),
      this.secrets.get(orgId, 'ai.google.api_key'),
      this.secrets.get(orgId, 'ai.ollama.base_url'),
    ]);
    return {
      anthropic: anthropic ?? this.cfg.ai.anthropicKey,
      openai: openai ?? this.cfg.ai.openaiKey,
      google: google ?? this.cfg.ai.googleKey,
      ollamaBaseUrl: ollama ?? this.cfg.ai.ollamaBaseUrl,
    };
  }

  invalidate(orgId?: string) {
    if (orgId) this.routers.delete(orgId);
    else this.routers.clear();
  }

  async routerFor(orgId: string): Promise<ModelRouter> {
    const cached = this.routers.get(orgId);
    if (cached && Date.now() - cached.at < 60_000) return cached.router;
    const router = createRouter(await this.providerKeys(orgId), {
      order: this.cfg.ai.providerOrder,
      pricing: await this.pricingTable(),
      onCall: (rec) => this.recordCall(rec),
      logger: this.logger.child({ component: 'model-router' }),
      requestTimeoutMs: this.cfg.ai.requestTimeoutMs,
    });
    this.routers.set(orgId, { router, at: Date.now() });
    return router;
  }

  async recordCall(rec: ModelCallRecord) {
    await this.db.query(
      `INSERT INTO model_calls (id, org_id, task_id, agent, provider, model, purpose, tier, input_tokens, output_tokens, cost_usd, latency_ms, status, error, quality)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [newId('modelCall'), rec.orgId ?? null, rec.taskId ?? null, rec.agent ?? null, rec.provider, rec.model, rec.purpose, rec.tier, rec.inputTokens, rec.outputTokens, rec.costUsd, rec.latencyMs, rec.status, rec.error ?? null, json(rec.quality)],
    );
  }

  async spentToday(orgId: string): Promise<number> {
    return Number((await this.db.value(`SELECT COALESCE(SUM(cost_usd), 0) FROM model_calls WHERE org_id = $1 AND created_at > date_trunc('day', now())`, [orgId])) ?? 0);
  }

  async dailyBudget(orgId: string): Promise<number> {
    const org = await this.orgs.get(orgId);
    return org.settings.aiDailyBudgetUsd ?? this.cfg.ai.dailyBudgetUsd;
  }

  /** Budget guard enforcing the per-task cap and the organisation's daily AI budget. */
  budgetGuard(orgId: string, opts: { maxTaskUsd?: number; label?: string } = {}): BudgetGuard & { spentUsd: () => number; tokens: () => number } {
    let spent = 0;
    let tokens = 0;
    const maxTask = opts.maxTaskUsd ?? this.cfg.ai.maxCostPerTaskUsd;
    return {
      check: async (estimate: number) => {
        if (spent + estimate > maxTask) throw new BudgetExceededError(`Task AI budget exceeded: $${round(spent + estimate, 4)} > $${maxTask}${opts.label ? ` (${opts.label})` : ''}`);
        const [today, budget] = await Promise.all([this.spentToday(orgId), this.dailyBudget(orgId)]);
        if (today + estimate > budget) throw new BudgetExceededError(`Daily AI budget exhausted: $${round(today, 4)} spent of $${budget}`);
      },
      charge: (usd: number, t: number) => {
        spent += usd;
        tokens += t;
      },
      spentUsd: () => spent,
      tokens: () => tokens,
    };
  }

  async usage(orgId: string) {
    const byModel = await this.db.many(
      `SELECT provider, model, COUNT(*)::int AS calls, SUM(input_tokens)::int AS input_tokens, SUM(output_tokens)::int AS output_tokens,
              ROUND(SUM(cost_usd)::numeric, 6) AS cost_usd, ROUND(AVG(latency_ms)::numeric, 0) AS avg_latency_ms,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)::int AS ok, SUM(CASE WHEN status = 'invalid_output' THEN 1 ELSE 0 END)::int AS invalid,
              SUM(CASE WHEN status IN ('error','rate_limited') THEN 1 ELSE 0 END)::int AS errors
       FROM model_calls WHERE org_id = $1 AND created_at > now() - interval '30 days' GROUP BY provider, model ORDER BY cost_usd DESC`,
      [orgId],
    );
    return { spentTodayUsd: round(await this.spentToday(orgId), 6), dailyBudgetUsd: await this.dailyBudget(orgId), last30Days: byModel };
  }
}
