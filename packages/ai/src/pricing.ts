import type { ProviderName, Tier } from './types';

/**
 * Default model pricing (USD per million tokens). Seeded into the `model_costs` table, where it can
 * be edited — prices change, and every row records where its number came from.
 *
 * Anthropic rows: first-party API list prices (Claude API docs, cached 2026-06-24).
 * OpenAI / Google rows: last list prices known to this codebase's authors (2025) — UNVERIFIED for
 * the current date. Check the providers' pricing pages and update `model_costs` before relying on
 * cost reports for those providers. Ollama runs locally: marginal API cost is $0 (hardware not counted).
 */
export interface PriceRow {
  provider: ProviderName;
  model: string;
  tier: Tier;
  inputPerMtok: number;
  outputPerMtok: number;
  contextWindow?: number;
  sourceNote: string;
}

const ANTHROPIC_NOTE = 'Anthropic first-party API list price (docs cache 2026-06-24)';
const UNVERIFIED = 'UNVERIFIED — last known 2025 list price; update in model_costs';

export const DEFAULT_PRICING: PriceRow[] = [
  { provider: 'anthropic', model: 'claude-opus-5', tier: 'deep', inputPerMtok: 5, outputPerMtok: 25, contextWindow: 1_000_000, sourceNote: ANTHROPIC_NOTE },
  { provider: 'anthropic', model: 'claude-sonnet-5', tier: 'balanced', inputPerMtok: 2, outputPerMtok: 10, contextWindow: 1_000_000, sourceNote: ANTHROPIC_NOTE },
  { provider: 'anthropic', model: 'claude-haiku-4-5', tier: 'fast', inputPerMtok: 1, outputPerMtok: 5, contextWindow: 200_000, sourceNote: ANTHROPIC_NOTE },
  // Served when Claude Opus 5 declines and the server-side fallback routes the request here.
  { provider: 'anthropic', model: 'claude-opus-4-8', tier: 'deep', inputPerMtok: 5, outputPerMtok: 25, contextWindow: 1_000_000, sourceNote: ANTHROPIC_NOTE },
  { provider: 'anthropic', model: 'claude-fable-5-1', tier: 'deep', inputPerMtok: 10, outputPerMtok: 50, contextWindow: 1_000_000, sourceNote: ANTHROPIC_NOTE },
  { provider: 'openai', model: 'gpt-5', tier: 'deep', inputPerMtok: 1.25, outputPerMtok: 10, sourceNote: UNVERIFIED },
  { provider: 'openai', model: 'gpt-5-mini', tier: 'balanced', inputPerMtok: 0.25, outputPerMtok: 2, sourceNote: UNVERIFIED },
  { provider: 'openai', model: 'gpt-5-nano', tier: 'fast', inputPerMtok: 0.05, outputPerMtok: 0.4, sourceNote: UNVERIFIED },
  { provider: 'google', model: 'gemini-2.5-pro', tier: 'deep', inputPerMtok: 1.25, outputPerMtok: 10, sourceNote: UNVERIFIED },
  { provider: 'google', model: 'gemini-2.5-flash', tier: 'balanced', inputPerMtok: 0.3, outputPerMtok: 2.5, sourceNote: UNVERIFIED },
  { provider: 'google', model: 'gemini-2.5-flash-lite', tier: 'fast', inputPerMtok: 0.1, outputPerMtok: 0.4, sourceNote: UNVERIFIED },
];

export class PricingTable {
  private rows = new Map<string, { input: number; output: number }>();

  constructor(rows: { provider: string; model: string; inputPerMtok: number; outputPerMtok: number }[] = DEFAULT_PRICING) {
    for (const r of rows) this.set(r.provider, r.model, r.inputPerMtok, r.outputPerMtok);
  }

  set(provider: string, model: string, inputPerMtok: number, outputPerMtok: number) {
    this.rows.set(`${provider}/${model}`, { input: inputPerMtok, output: outputPerMtok });
  }

  get(provider: string, model: string): { input: number; output: number } | undefined {
    if (provider === 'ollama' || provider === 'mock') return { input: 0, output: 0 };
    return this.rows.get(`${provider}/${model}`);
  }

  cost(provider: string, model: string, inputTokens: number, outputTokens: number): { usd: number; priced: boolean } {
    const p = this.get(provider, model);
    if (!p) return { usd: 0, priced: false };
    return { usd: (inputTokens * p.input + outputTokens * p.output) / 1_000_000, priced: true };
  }
}

/** Rough token estimate (≈ 4 characters per token for English text) for pre-call budget checks. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
