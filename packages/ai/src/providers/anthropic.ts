import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ProviderError, type ModelProvider, type ProviderRequest, type ProviderResult, type Tier } from '../types';

/** Models that support the server-side refusal fallback (`fallbacks: "default"`). */
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1', 'claude-opus-5-5']);
/** Haiku 4.5 rejects `output_config.effort`; the Opus/Sonnet/Fable 4.6+ families accept it. */
const supportsEffort = (model: string) => !model.startsWith('claude-haiku');

export const ANTHROPIC_DEFAULT_MODELS: Record<Tier, string> = {
  fast: 'claude-haiku-4-5',
  balanced: 'claude-sonnet-5',
  deep: 'claude-opus-5',
};

/**
 * Claude via the official Anthropic TypeScript SDK.
 *  - Structured output: `beta.messages.parse` + `zodOutputFormat` (schema-constrained JSON).
 *  - Refusals: `stop_reason: "refusal"` is checked before reading content. Claude Opus 5 requests
 *    opt into the server-side fallback (`fallbacks: "default"`), which re-runs a declined request on
 *    Anthropic's recommended fallback model inside the same call; `response.model` then reports the
 *    model that actually served it, and cost is computed for that model.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic' as const;
  private client: Anthropic | null;

  constructor(
    apiKey: string | undefined,
    readonly models: Record<Tier, string> = ANTHROPIC_DEFAULT_MODELS,
    opts: { baseURL?: string; maxRetries?: number } = {},
  ) {
    this.client = apiKey ? new Anthropic({ apiKey, maxRetries: opts.maxRetries ?? 2, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async complete(req: ProviderRequest): Promise<ProviderResult> {
    if (!this.client) throw new ProviderError('anthropic', 'auth', 'ANTHROPIC_API_KEY not configured', false);
    const useFallback = SERVER_FALLBACK_MODELS.has(req.model);
    const outputConfig: Record<string, unknown> = {};
    if (req.effort && supportsEffort(req.model)) outputConfig.effort = req.effort;
    if (req.schema) outputConfig.format = zodOutputFormat(req.schema);

    const params = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: 'user' as const, content: req.prompt }],
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
    const opts = { timeout: req.timeoutMs, signal: req.signal };

    try {
      const res = req.schema ? await this.client.beta.messages.parse(params, opts) : await this.client.beta.messages.create(params, opts);
      if (res.stop_reason === 'refusal') {
        throw new ProviderError('anthropic', 'refusal', 'The model declined this request (stop_reason: refusal)', false);
      }
      if (res.stop_reason === 'max_tokens') {
        throw new ProviderError('anthropic', 'truncated', `Output truncated at max_tokens=${req.maxOutputTokens}`, false);
      }
      const text = res.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        text,
        parsed: req.schema ? ((res as { parsed_output?: unknown }).parsed_output ?? undefined) : undefined,
        model: res.model,
        inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
        outputTokens: res.usage.output_tokens,
        stopReason: res.stop_reason,
      };
    } catch (e) {
      throw mapAnthropicError(e);
    }
  }
}

function mapAnthropicError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.RateLimitError) return new ProviderError('anthropic', 'rate_limited', e.message, true, 429);
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError('anthropic', 'auth', e.message, false, e.status);
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) return new ProviderError('anthropic', 'bad_request', e.message, false, e.status);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('anthropic', 'timeout', e.message, true);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('anthropic', 'unavailable', e.message, true);
  if (e instanceof Anthropic.APIError) {
    const status = e.status ?? 0;
    return new ProviderError('anthropic', status >= 500 ? 'unavailable' : 'unknown', e.message, status >= 500 || status === 408, status);
  }
  return new ProviderError('anthropic', 'unknown', e instanceof Error ? e.message : String(e), false);
}
