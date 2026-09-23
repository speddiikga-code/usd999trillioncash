import { ProviderError, type ModelProvider, type ProviderName, type ProviderRequest, type ProviderResult, type Tier } from '../types';

/**
 * Deterministic provider for tests. Never enabled in normal operation — the system falls back to
 * heuristic (non-LLM) implementations when no real provider is configured, and labels them so.
 */
export class MockProvider implements ModelProvider {
  readonly models: Record<Tier, string> = { fast: 'mock-fast', balanced: 'mock-balanced', deep: 'mock-deep' };
  calls: ProviderRequest[] = [];

  constructor(
    private handler: (req: ProviderRequest, callIndex: number) => string | object | Error,
    readonly name: ProviderName = 'mock',
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async complete(req: ProviderRequest): Promise<ProviderResult> {
    this.calls.push(req);
    const out = this.handler(req, this.calls.length - 1);
    if (out instanceof Error) {
      if (out instanceof ProviderError) throw out;
      throw new ProviderError(this.name, 'unavailable', out.message, true);
    }
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    return { text, model: req.model, inputTokens: Math.ceil((req.prompt.length + (req.system?.length ?? 0)) / 4), outputTokens: Math.ceil(text.length / 4) };
  }
}
