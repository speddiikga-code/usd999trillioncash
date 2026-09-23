import type { Logger } from '@roos/shared';
import { AnthropicProvider, ANTHROPIC_DEFAULT_MODELS } from './providers/anthropic';
import { GoogleProvider, GOOGLE_DEFAULT_MODELS } from './providers/google';
import { OllamaProvider } from './providers/ollama';
import { OpenAIProvider, OPENAI_DEFAULT_MODELS } from './providers/openai';
import { PricingTable } from './pricing';
import { ModelRouter, type RouterOptions } from './router';
import type { ProviderName, Tier } from './types';

export interface ProviderKeys {
  anthropic?: string;
  openai?: string;
  google?: string;
  ollamaBaseUrl?: string;
}

function tierModels(prefix: string, env: NodeJS.ProcessEnv, defaults: Record<Tier, string>): Record<Tier, string> {
  return {
    fast: env[`${prefix}_MODEL_FAST`] || defaults.fast,
    balanced: env[`${prefix}_MODEL_BALANCED`] || defaults.balanced,
    deep: env[`${prefix}_MODEL_DEEP`] || defaults.deep,
  };
}

/** Build a router from provider keys (environment and/or per-organisation encrypted secrets). */
export function createRouter(
  keys: ProviderKeys,
  opts: { order?: string[]; pricing?: PricingTable; onCall?: RouterOptions['onCall']; logger?: Logger; requestTimeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): ModelRouter {
  const env = opts.env ?? process.env;
  return new ModelRouter({
    providers: [
      new AnthropicProvider(keys.anthropic, tierModels('ANTHROPIC', env, ANTHROPIC_DEFAULT_MODELS)),
      new OpenAIProvider(keys.openai, tierModels('OPENAI', env, OPENAI_DEFAULT_MODELS)),
      new GoogleProvider(keys.google, tierModels('GOOGLE', env, GOOGLE_DEFAULT_MODELS)),
      new OllamaProvider(keys.ollamaBaseUrl, env.OLLAMA_MODEL || 'llama3.1'),
    ],
    order: (opts.order as ProviderName[] | undefined) ?? undefined,
    pricing: opts.pricing,
    onCall: opts.onCall,
    logger: opts.logger,
    requestTimeoutMs: opts.requestTimeoutMs,
    rpm: {
      anthropic: Number(env.AI_RPM_ANTHROPIC) || 50,
      openai: Number(env.AI_RPM_OPENAI) || 50,
      google: Number(env.AI_RPM_GOOGLE) || 50,
      ollama: Number(env.AI_RPM_OLLAMA) || 30,
    },
  });
}
