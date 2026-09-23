import { z } from 'zod';
import { BudgetExceededError, AppError, nullLogger, type Logger } from '@roos/shared';
import { UNTRUSTED_DATA_SYSTEM_NOTE } from '@roos/security';
import { estimateTokens, PricingTable } from './pricing';
import {
  ProviderError,
  type CallContext,
  type CompletionMeta,
  type CompletionRequest,
  type ModelCallRecord,
  type ModelProvider,
  type ProviderName,
  type ProviderResult,
  type Tier,
} from './types';

/**
 * Provider-agnostic model router.
 *
 *  - Provider order is configurable; unconfigured providers are skipped.
 *  - Tier (fast / balanced / deep) is chosen from the task purpose, prompt size and observed
 *    output quality (a model that keeps producing invalid JSON for a purpose gets escalated).
 *  - Per-provider rate limiting; retryable failures fall back to the next provider.
 *  - Every attempt is recorded (tokens, cost, latency, status, quality) via `onCall`.
 *  - Budgets are checked before each call (estimate) and charged after (actual cost).
 *  - Models are used as pure functions: no tools, JSON validated against a zod schema.
 */
export interface RouterOptions {
  providers: ModelProvider[];
  order?: ProviderName[];
  pricing?: PricingTable;
  onCall?: (rec: ModelCallRecord) => Promise<void> | void;
  logger?: Logger;
  requestTimeoutMs?: number;
  /** Requests per minute allowed per provider (in-process). */
  rpm?: Partial<Record<ProviderName, number>>;
  /** Expected output tokens used for pre-call cost estimates. */
  expectedOutputTokens?: number;
}

const PURPOSE_TIER_RULES: [RegExp, Tier][] = [
  [/(extract|classify|summari[sz]e|tag|score_leads|dedupe)/, 'fast'],
  [/(spec|strategy|architecture|plan|portfolio)/, 'deep'],
  [/(synthesi[sz]e|analy[sz]e|draft|hypothes|segment|sizing|copy|risk)/, 'balanced'],
];
const TIER_ORDER: Tier[] = ['fast', 'balanced', 'deep'];

interface QualityStats {
  calls: number;
  invalid: number;
  errors: number;
  latencyMsTotal: number;
  costUsdTotal: number;
}

export class ModelRouter {
  private providers: ModelProvider[];
  private pricing: PricingTable;
  private logger: Logger;
  private windows = new Map<ProviderName, number[]>();
  private quality = new Map<string, QualityStats>();

  constructor(private opts: RouterOptions) {
    const order = opts.order ?? ['anthropic', 'openai', 'google', 'ollama', 'mock'];
    this.providers = [...opts.providers].sort((a, b) => idx(order, a.name) - idx(order, b.name));
    this.pricing = opts.pricing ?? new PricingTable();
    this.logger = opts.logger ?? nullLogger;
  }

  /** True when at least one provider is configured. Agents fall back to heuristics otherwise. */
  available(): boolean {
    return this.providers.some((p) => p.isConfigured());
  }

  configuredProviders(): { name: ProviderName; models: Record<Tier, string> }[] {
    return this.providers.filter((p) => p.isConfigured()).map((p) => ({ name: p.name, models: p.models }));
  }

  chooseTier(req: Pick<CompletionRequest, 'purpose' | 'tier' | 'prompt'>): Tier {
    let tier: Tier = req.tier ?? PURPOSE_TIER_RULES.find(([re]) => re.test(req.purpose))?.[1] ?? 'balanced';
    if (tier === 'fast' && req.prompt.length > 60_000) tier = 'balanced';
    // Quality-based escalation: if the default model for this tier keeps failing validation, go up a tier.
    const primary = this.providers.find((p) => p.isConfigured());
    if (primary) {
      const s = this.quality.get(`${primary.name}/${primary.models[tier]}/${req.purpose}`);
      if (s && s.calls >= 5 && s.invalid / s.calls > 0.3 && tier !== 'deep') tier = TIER_ORDER[TIER_ORDER.indexOf(tier) + 1]!;
    }
    return tier;
  }

  qualityStats() {
    return [...this.quality.entries()].map(([key, s]) => ({
      key,
      ...s,
      invalidRate: s.calls ? s.invalid / s.calls : 0,
      avgLatencyMs: s.calls ? Math.round(s.latencyMsTotal / s.calls) : 0,
    }));
  }

  private rateLimited(p: ProviderName): boolean {
    const limit = this.opts.rpm?.[p] ?? 60;
    const now = Date.now();
    const w = (this.windows.get(p) ?? []).filter((t) => now - t < 60_000);
    this.windows.set(p, w);
    if (w.length >= limit) return true;
    w.push(now);
    return false;
  }

  private track(key: string, patch: Partial<QualityStats>) {
    const s = this.quality.get(key) ?? { calls: 0, invalid: 0, errors: 0, latencyMsTotal: 0, costUsdTotal: 0 };
    s.calls += patch.calls ?? 0;
    s.invalid += patch.invalid ?? 0;
    s.errors += patch.errors ?? 0;
    s.latencyMsTotal += patch.latencyMsTotal ?? 0;
    s.costUsdTotal += patch.costUsdTotal ?? 0;
    this.quality.set(key, s);
  }

  private async record(ctx: CallContext, rec: Omit<ModelCallRecord, 'orgId' | 'taskId' | 'agent'>) {
    try {
      await this.opts.onCall?.({ ...rec, orgId: ctx.orgId ?? null, taskId: ctx.taskId ?? null, agent: ctx.agent ?? null });
    } catch (e) {
      this.logger.warn('Failed to record model call', { error: (e as Error).message });
    }
  }

  /** Core call with provider fallback. `schema` switches the providers into JSON mode. */
  private async call(
    req: CompletionRequest,
    ctx: CallContext,
    schema?: z.ZodType,
  ): Promise<{ result: ProviderResult; meta: CompletionMeta }> {
    const candidates = this.providers.filter((p) => p.isConfigured());
    if (!candidates.length) throw new AppError('No AI provider is configured', { status: 503, code: 'AI_UNAVAILABLE' });
    const tier = this.chooseTier(req);
    const system = [req.system, UNTRUSTED_DATA_SYSTEM_NOTE].filter(Boolean).join('\n\n');
    const jsonSchema = schema ? (z.toJSONSchema(schema) as Record<string, unknown>) : undefined;
    const maxOutputTokens = req.maxOutputTokens ?? 16_000;
    const errors: string[] = [];
    let attempts = 0;

    for (const provider of candidates) {
      const model = provider.models[tier];
      const price = this.pricing.get(provider.name, model);
      const estInput = estimateTokens(system + req.prompt);
      const estimate = price ? (estInput * price.input + (this.opts.expectedOutputTokens ?? 1500) * price.output) / 1e6 : 0;
      const qKey = `${provider.name}/${model}/${req.purpose}`;

      if (ctx.budget) {
        try {
          await ctx.budget.check(estimate);
        } catch (e) {
          await this.record(ctx, { provider: provider.name, model, purpose: req.purpose, tier, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, status: 'budget_denied', error: (e as Error).message, quality: {} });
          throw e;
        }
      }
      if (this.rateLimited(provider.name)) {
        errors.push(`${provider.name}: local rate limit reached`);
        await this.record(ctx, { provider: provider.name, model, purpose: req.purpose, tier, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, status: 'rate_limited', error: 'local rate limit', quality: {} });
        continue;
      }

      attempts++;
      const started = Date.now();
      try {
        const result = await provider.complete({
          model,
          system,
          prompt: req.prompt,
          maxOutputTokens,
          schema,
          jsonSchema,
          effort: req.effort ?? (tier === 'deep' ? 'high' : tier === 'balanced' ? 'medium' : 'low'),
          timeoutMs: this.opts.requestTimeoutMs ?? 60_000,
          signal: ctx.signal,
        });
        const latencyMs = Date.now() - started;
        const cost = this.pricing.cost(provider.name, result.model, result.inputTokens, result.outputTokens);
        if (!cost.priced) this.logger.warn('Model has no pricing row — cost recorded as $0', { provider: provider.name, model: result.model });
        await ctx.budget?.charge(cost.usd, result.inputTokens + result.outputTokens);
        this.track(qKey, { calls: 1, latencyMsTotal: latencyMs, costUsdTotal: cost.usd });
        return {
          result,
          meta: {
            provider: provider.name,
            model: result.model,
            tier,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd: cost.usd,
            latencyMs,
            attempts,
            generatedBy: `model:${provider.name}/${result.model}`,
          },
        };
      } catch (e) {
        const latencyMs = Date.now() - started;
        const pe = e instanceof ProviderError ? e : new ProviderError(provider.name, 'unknown', (e as Error).message, false);
        this.track(qKey, { calls: 1, errors: 1, latencyMsTotal: latencyMs });
        await this.record(ctx, { provider: provider.name, model, purpose: req.purpose, tier, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs, status: pe.kind === 'rate_limited' ? 'rate_limited' : 'error', error: pe.message.slice(0, 500), quality: {} });
        errors.push(pe.message);
        this.logger.warn('Model call failed', { provider: provider.name, model, kind: pe.kind, retryable: pe.retryable });
        // Refusals and truncation may succeed on a different provider; auth/bad-request also try the next one.
        continue;
      }
    }
    throw new AppError(`All AI providers failed: ${errors.join(' | ')}`, { status: 502, code: 'AI_PROVIDERS_FAILED', retryable: true });
  }

  async complete(req: CompletionRequest, ctx: CallContext = {}): Promise<{ text: string; meta: CompletionMeta }> {
    const { result, meta } = await this.call(req, ctx);
    await this.record(ctx, { provider: meta.provider, model: meta.model, purpose: req.purpose, tier: meta.tier, inputTokens: meta.inputTokens, outputTokens: meta.outputTokens, costUsd: meta.costUsd, latencyMs: meta.latencyMs, status: 'ok', quality: { priced: this.pricing.get(meta.provider, meta.model) !== undefined } });
    return { text: result.text, meta };
  }

  /**
   * Structured generation: returns data validated against `schema`. One repair attempt is made
   * when the output fails validation; the attempt count is recorded as a quality signal.
   */
  async generateJson<T>(req: CompletionRequest, schema: z.ZodType<T>, ctx: CallContext = {}): Promise<{ data: T; meta: CompletionMeta }> {
    let lastError = '';
    let totalCost = 0;
    for (let repair = 0; repair <= 1; repair++) {
      const prompt = repair === 0 ? req.prompt : `${req.prompt}\n\nYour previous answer failed validation: ${lastError}\nReturn corrected JSON only.`;
      const { result, meta } = await this.call({ ...req, prompt }, ctx, schema);
      totalCost += meta.costUsd;
      const candidate = result.parsed !== undefined && result.parsed !== null ? result.parsed : extractJson(result.text);
      const parsed = schema.safeParse(candidate);
      const qKey = `${meta.provider}/${meta.model}/${req.purpose}`;
      if (parsed.success) {
        await this.record(ctx, { provider: meta.provider, model: meta.model, purpose: req.purpose, tier: meta.tier, inputTokens: meta.inputTokens, outputTokens: meta.outputTokens, costUsd: meta.costUsd, latencyMs: meta.latencyMs, status: 'ok', quality: { validated: true, repairAttempts: repair } });
        return { data: parsed.data, meta: { ...meta, costUsd: totalCost } };
      }
      lastError = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      this.track(qKey, { invalid: 1 });
      await this.record(ctx, { provider: meta.provider, model: meta.model, purpose: req.purpose, tier: meta.tier, inputTokens: meta.inputTokens, outputTokens: meta.outputTokens, costUsd: meta.costUsd, latencyMs: meta.latencyMs, status: 'invalid_output', error: lastError.slice(0, 500), quality: { validated: false, repairAttempts: repair } });
    }
    throw new AppError(`Model output failed schema validation: ${lastError}`, { status: 502, code: 'AI_INVALID_OUTPUT' });
  }
}

/** Extract the first JSON object/array from model text (tolerates code fences and preambles). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1]! : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function idx(order: ProviderName[], p: ProviderName): number {
  const i = order.indexOf(p);
  return i < 0 ? 99 : i;
}

export { BudgetExceededError };
