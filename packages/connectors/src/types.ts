import type { HttpFetcher } from '@roos/security';
import type { Logger } from '@roos/shared';

export interface ConnectorSecrets {
  githubToken?: string;
  stackexchangeKey?: string;
  braveSearchKey?: string;
  secUserAgent?: string;
}

export interface ConnectorContext {
  fetch: HttpFetcher;
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  secrets: ConnectorSecrets;
  logger: Logger;
  signal?: AbortSignal;
  /** Multiplier for per-source minimum request intervals (1 = polite default; tests use 0). */
  politenessScale?: number;
}

/** A document fetched from an external source. Content is UNTRUSTED. */
export interface FetchedDocument {
  externalId?: string;
  url?: string;
  title: string;
  content: string;
  author?: string;
  publishedAt?: string;
  /** Observed engagement counters (points, comments, reactions, answers, views, downloads…). */
  engagement: Record<string, number>;
  metadata: Record<string, unknown>;
}

export type SignalType = 'pain_points' | 'demand' | 'regulatory' | 'jobs' | 'technology' | 'pricing' | 'competitors' | 'market_data';

export interface ConnectorDefinition {
  id: string;
  name: string;
  description: string;
  kind: 'public_api' | 'keyed_api' | 'feed' | 'web' | 'user_data';
  signalTypes: SignalType[];
  /** Credentials without which the connector cannot run. */
  requires?: (keyof ConnectorSecrets)[];
  /** Credentials that raise limits but are not required. */
  optional?: (keyof ConnectorSecrets)[];
  /** Licensing / terms-of-use note shown to operators. */
  terms: string;
  /** Minimum milliseconds between requests to this source (politeness). */
  minIntervalMs: number;
  /** Whether the connector searches by query (vs. reading configured URLs/data). */
  queryable: boolean;
  search(query: string, opts: { limit: number; config: Record<string, unknown> }, ctx: ConnectorContext): Promise<FetchedDocument[]>;
}

export function engagementScore(e: Record<string, number>): number {
  return Math.round(
    (e.points ?? 0) +
      (e.score ?? 0) +
      2 * (e.comments ?? 0) +
      (e.reactions ?? 0) +
      2 * (e.answers ?? 0) +
      (e.views ?? 0) / 100 +
      (e.downloads ?? 0) / 1000,
  );
}
