import { safeFetch } from '@roos/security';
import { errorMessage, nullLogger, sleep, stableStringify, type AppConfig, type Logger } from '@roos/shared';
import { githubIssues, hackerNews, stackExchange } from './sources/community';
import { federalRegister, secEdgar } from './sources/regulatory';
import { npmRegistry, wikipediaPageviews } from './sources/trends';
import { braveSearch, remotiveJobs, rssFeeds, userDataset, webPages } from './sources/web';
import type { ConnectorContext, ConnectorDefinition, ConnectorSecrets, FetchedDocument } from './types';

export const CONNECTORS: ConnectorDefinition[] = [
  hackerNews,
  stackExchange,
  githubIssues,
  federalRegister,
  npmRegistry,
  wikipediaPageviews,
  remotiveJobs,
  rssFeeds,
  webPages,
  braveSearch,
  secEdgar,
  userDataset,
];

/** Connectors used by a discovery scan when the operator does not choose any. */
export const DEFAULT_DISCOVERY_CONNECTORS = ['hackernews', 'stackexchange', 'github', 'federal_register'];

export function getConnector(id: string): ConnectorDefinition | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

export function connectorAvailability(def: ConnectorDefinition, secrets: ConnectorSecrets): { available: boolean; missing: string[] } {
  const missing = (def.requires ?? []).filter((k) => !secrets[k]);
  return { available: missing.length === 0, missing };
}

export function listConnectors(secrets: ConnectorSecrets) {
  return CONNECTORS.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    kind: c.kind,
    signalTypes: c.signalTypes,
    terms: c.terms,
    queryable: c.queryable,
    requires: c.requires ?? [],
    optional: c.optional ?? [],
    ...connectorAvailability(c, secrets),
  }));
}

export function buildConnectorContext(cfg: AppConfig, secrets: ConnectorSecrets, logger: Logger = nullLogger, fetch = safeFetch): ConnectorContext {
  return {
    fetch: (url, opts) => fetch(url, { ...opts, policy: { ...(opts?.policy ?? {}), allowPrivate: opts?.policy?.allowPrivate ?? cfg.connectors.allowPrivateNetworks } }),
    userAgent: cfg.connectors.userAgent,
    timeoutMs: cfg.connectors.timeoutMs,
    maxBytes: cfg.connectors.maxBytes,
    secrets,
    logger,
  };
}

const lastCall = new Map<string, number>();
const cache = new Map<string, { at: number; docs: FetchedDocument[] }>();
const CACHE_TTL_MS = 10 * 60_000;

export interface ConnectorRun {
  connector: string;
  query: string;
  documents: FetchedDocument[];
  error?: string;
  durationMs: number;
  cached: boolean;
}

/**
 * Run a connector with politeness (minimum interval per source), a short result cache and error
 * isolation — a failing source never aborts a discovery scan.
 */
export async function runConnector(def: ConnectorDefinition, query: string, opts: { limit: number; config?: Record<string, unknown> }, ctx: ConnectorContext): Promise<ConnectorRun> {
  const started = Date.now();
  const config = opts.config ?? {};
  const { available, missing } = connectorAvailability(def, ctx.secrets);
  if (!available) return { connector: def.id, query, documents: [], error: `Missing credentials: ${missing.join(', ')}`, durationMs: 0, cached: false };
  const key = `${def.id}|${query}|${opts.limit}|${stableStringify(config)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { connector: def.id, query, documents: hit.docs, durationMs: 0, cached: true };

  const wait = (lastCall.get(def.id) ?? 0) + def.minIntervalMs * (ctx.politenessScale ?? 1) - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(def.id, Date.now());
  try {
    const documents = await def.search(query, { limit: opts.limit, config }, ctx);
    cache.set(key, { at: Date.now(), docs: documents });
    return { connector: def.id, query, documents, durationMs: Date.now() - started, cached: false };
  } catch (e) {
    ctx.logger.warn('Connector failed', { connector: def.id, error: errorMessage(e) });
    return { connector: def.id, query, documents: [], error: errorMessage(e), durationMs: Date.now() - started, cached: false };
  }
}

export function clearConnectorCache() {
  cache.clear();
  lastCall.clear();
}
