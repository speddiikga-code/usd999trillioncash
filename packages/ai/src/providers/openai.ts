import type { HttpFetcher } from '@roos/security';
import { ProviderError, type ModelProvider, type ProviderRequest, type ProviderResult, type Tier } from '../types';
import { jsonInstruction, postJson } from './http';

/** Defaults are configurable (OPENAI_MODEL_FAST/BALANCED/DEEP) — verify current model names. */
export const OPENAI_DEFAULT_MODELS: Record<Tier, string> = { fast: 'gpt-5-nano', balanced: 'gpt-5-mini', deep: 'gpt-5' };

interface ChatCompletion {
  model: string;
  choices: { message: { content: string | null; refusal?: string | null }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** OpenAI Chat Completions API over the SSRF-guarded fetcher. */
export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai' as const;
  constructor(
    private apiKey: string | undefined,
    readonly models: Record<Tier, string> = OPENAI_DEFAULT_MODELS,
    private baseUrl = 'https://api.openai.com/v1',
    private fetcher?: HttpFetcher,
  ) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async complete(req: ProviderRequest): Promise<ProviderResult> {
    if (!this.apiKey) throw new ProviderError('openai', 'auth', 'OPENAI_API_KEY not configured', false);
    const system = [req.system, req.schema || req.jsonSchema ? jsonInstruction(req.jsonSchema) : ''].filter(Boolean).join('\n\n');
    const body = {
      model: req.model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: req.prompt }],
      max_completion_tokens: req.maxOutputTokens,
      ...(req.schema || req.jsonSchema ? { response_format: { type: 'json_object' } } : {}),
    };
    const res = await postJson<ChatCompletion>('openai', `${this.baseUrl}/chat/completions`, body, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      fetcher: this.fetcher,
    });
    const choice = res.choices[0];
    if (!choice) throw new ProviderError('openai', 'unknown', 'No choices returned', true);
    if (choice.message.refusal) throw new ProviderError('openai', 'refusal', choice.message.refusal, false);
    if (choice.finish_reason === 'length') throw new ProviderError('openai', 'truncated', 'Output truncated (finish_reason=length)', false);
    return {
      text: choice.message.content ?? '',
      model: res.model ?? req.model,
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      stopReason: choice.finish_reason,
    };
  }
}
