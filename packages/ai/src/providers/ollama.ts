import type { HttpFetcher } from '@roos/security';
import { ProviderError, type ModelProvider, type ProviderRequest, type ProviderResult, type Tier } from '../types';
import { jsonInstruction, postJson } from './http';

interface OllamaChatResponse {
  model: string;
  message?: { content: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Local models via Ollama (`/api/chat`). The base URL is operator-configured and usually on
 * localhost, so private addresses are permitted for this provider only, and only for the exact
 * configured host.
 */
export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama' as const;
  readonly models: Record<Tier, string>;

  constructor(
    private baseUrl: string | undefined,
    model = 'llama3.1',
    private fetcher?: HttpFetcher,
  ) {
    this.models = { fast: model, balanced: model, deep: model };
  }

  isConfigured(): boolean {
    return !!this.baseUrl;
  }

  async complete(req: ProviderRequest): Promise<ProviderResult> {
    if (!this.baseUrl) throw new ProviderError('ollama', 'auth', 'OLLAMA_BASE_URL not configured', false);
    const url = new URL('/api/chat', this.baseUrl);
    const wantsJson = !!(req.schema || req.jsonSchema);
    const system = [req.system, wantsJson ? jsonInstruction(req.jsonSchema) : ''].filter(Boolean).join('\n\n');
    const res = await postJson<OllamaChatResponse>(
      'ollama',
      url.toString(),
      {
        model: req.model,
        stream: false,
        messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: req.prompt }],
        ...(wantsJson ? { format: req.jsonSchema ?? 'json' } : {}),
        options: { num_predict: req.maxOutputTokens },
      },
      {
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        fetcher: this.fetcher,
        policy: { allowPrivate: true, allowedHosts: [url.hostname] },
      },
    );
    if (res.done_reason === 'length') throw new ProviderError('ollama', 'truncated', 'Output truncated', false);
    return {
      text: res.message?.content ?? '',
      model: res.model ?? req.model,
      inputTokens: res.prompt_eval_count ?? 0,
      outputTokens: res.eval_count ?? 0,
      stopReason: res.done_reason,
    };
  }
}
