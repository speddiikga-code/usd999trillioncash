import type { HttpFetcher } from '@roos/security';
import { ProviderError, type ModelProvider, type ProviderRequest, type ProviderResult, type Tier } from '../types';
import { jsonInstruction, postJson } from './http';

/** Defaults are configurable (GOOGLE_MODEL_FAST/BALANCED/DEEP) — verify current model names. */
export const GOOGLE_DEFAULT_MODELS: Record<Tier, string> = { fast: 'gemini-2.5-flash-lite', balanced: 'gemini-2.5-flash', deep: 'gemini-2.5-pro' };

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
}

/** Google Gemini `generateContent` REST API over the SSRF-guarded fetcher. */
export class GoogleProvider implements ModelProvider {
  readonly name = 'google' as const;
  constructor(
    private apiKey: string | undefined,
    readonly models: Record<Tier, string> = GOOGLE_DEFAULT_MODELS,
    private baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
    private fetcher?: HttpFetcher,
  ) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async complete(req: ProviderRequest): Promise<ProviderResult> {
    if (!this.apiKey) throw new ProviderError('google', 'auth', 'GOOGLE_API_KEY not configured', false);
    const wantsJson = !!(req.schema || req.jsonSchema);
    const system = [req.system, wantsJson ? jsonInstruction(req.jsonSchema) : ''].filter(Boolean).join('\n\n');
    const body = {
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { maxOutputTokens: req.maxOutputTokens, ...(wantsJson ? { responseMimeType: 'application/json' } : {}) },
    };
    const res = await postJson<GenerateContentResponse>('google', `${this.baseUrl}/models/${encodeURIComponent(req.model)}:generateContent`, body, {
      headers: { 'x-goog-api-key': this.apiKey },
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      fetcher: this.fetcher,
    });
    if (res.promptFeedback?.blockReason) throw new ProviderError('google', 'refusal', `Blocked: ${res.promptFeedback.blockReason}`, false);
    const cand = res.candidates?.[0];
    if (!cand) throw new ProviderError('google', 'unknown', 'No candidates returned', true);
    if (cand.finishReason === 'SAFETY') throw new ProviderError('google', 'refusal', 'Candidate blocked for safety', false);
    if (cand.finishReason === 'MAX_TOKENS') throw new ProviderError('google', 'truncated', 'Output truncated (MAX_TOKENS)', false);
    return {
      text: (cand.content?.parts ?? []).map((p) => p.text ?? '').join(''),
      model: req.model,
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
      stopReason: cand.finishReason,
    };
  }
}
