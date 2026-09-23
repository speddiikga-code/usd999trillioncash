import type { z } from 'zod';

export type Tier = 'fast' | 'balanced' | 'deep';
export type ProviderName = 'anthropic' | 'openai' | 'google' | 'ollama' | 'mock';
export type Effort = 'low' | 'medium' | 'high';

export interface ProviderRequest {
  model: string;
  system?: string;
  prompt: string;
  maxOutputTokens: number;
  /** When set, the provider must return JSON matching this schema (validated again by the router). */
  schema?: z.ZodType;
  /** JSON Schema rendering of `schema`, for providers without native zod support. */
  jsonSchema?: Record<string, unknown>;
  effort?: Effort;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProviderResult {
  text: string;
  /** Parsed structured output when the provider validated it natively (e.g. Anthropic structured outputs). */
  parsed?: unknown;
  /** Model that actually served the request (may differ from the requested one, e.g. server-side fallback). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason?: string | null;
}

export type ProviderErrorKind = 'rate_limited' | 'unavailable' | 'auth' | 'bad_request' | 'refusal' | 'truncated' | 'timeout' | 'unknown';

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}

export interface ModelProvider {
  readonly name: ProviderName;
  /** Model id per tier. */
  readonly models: Record<Tier, string>;
  isConfigured(): boolean;
  complete(req: ProviderRequest): Promise<ProviderResult>;
}

export interface ModelCallRecord {
  orgId?: string | null;
  taskId?: string | null;
  agent?: string | null;
  provider: ProviderName;
  model: string;
  purpose: string;
  tier: Tier;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  status: 'ok' | 'error' | 'invalid_output' | 'rate_limited' | 'budget_denied';
  error?: string;
  quality: { validated?: boolean; repairAttempts?: number; priced?: boolean; fallbackServed?: boolean };
}

export interface CallContext {
  orgId?: string | null;
  taskId?: string | null;
  agent?: string | null;
  /** Checked before and charged after every call. Throws BudgetExceededError to deny. */
  budget?: BudgetGuard;
  signal?: AbortSignal;
}

export interface BudgetGuard {
  check(estimatedUsd: number): Promise<void> | void;
  charge(actualUsd: number, tokens: number): Promise<void> | void;
}

export interface CompletionRequest {
  purpose: string;
  tier?: Tier;
  system?: string;
  prompt: string;
  maxOutputTokens?: number;
  effort?: Effort;
}

export interface CompletionMeta {
  provider: ProviderName;
  model: string;
  tier: Tier;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  attempts: number;
  generatedBy: string;
}
