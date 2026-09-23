import { round, truncate } from '@roos/shared';
import { getJson } from '../http';
import type { ConnectorDefinition, FetchedDocument } from '../types';

// ───────────────────────── npm registry (technology adoption) ─────────────────────────

interface NpmSearch {
  objects?: {
    package: { name: string; description?: string; version?: string; date?: string; links?: { npm?: string; repository?: string; homepage?: string }; keywords?: string[] };
    score?: { final?: number; detail?: { popularity?: number; quality?: number; maintenance?: number } };
  }[];
}

export function parseNpmSearch(json: NpmSearch, downloads: Record<string, number>): FetchedDocument[] {
  return (json.objects ?? []).map((o) => {
    const p = o.package;
    const dl = downloads[p.name] ?? 0;
    return {
      externalId: `npm:${p.name}`,
      url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
      title: `npm package: ${p.name}`,
      content: truncate(`${p.description ?? ''} Keywords: ${(p.keywords ?? []).join(', ')}. Last-month downloads: ${dl.toLocaleString('en-US')}.`, 4000),
      publishedAt: p.date,
      engagement: { downloads: dl },
      metadata: { version: p.version, repository: p.links?.repository, popularity: o.score?.detail?.popularity },
    };
  });
}

export const npmRegistry: ConnectorDefinition = {
  id: 'npm',
  name: 'npm registry',
  description: 'Package search + monthly downloads — adoption signals for emerging developer technologies.',
  kind: 'public_api',
  signalTypes: ['technology', 'demand'],
  terms: 'Public npm registry and downloads APIs (no key).',
  minIntervalMs: 500,
  queryable: true,
  async search(query, { limit }, ctx) {
    const json = await getJson<NpmSearch>(ctx, `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${Math.min(limit, 50)}`);
    const names = (json.objects ?? []).map((o) => o.package.name);
    const downloads: Record<string, number> = {};
    const unscoped = names.filter((n) => !n.startsWith('@'));
    if (unscoped.length) {
      try {
        const bulk = await getJson<Record<string, { downloads?: number } | null> & { downloads?: number; package?: string }>(
          ctx,
          `https://api.npmjs.org/downloads/point/last-month/${unscoped.slice(0, 100).map(encodeURIComponent).join(',')}`,
        );
        if (unscoped.length === 1 && typeof bulk.downloads === 'number') downloads[unscoped[0]!] = bulk.downloads;
        else for (const n of unscoped) downloads[n] = (bulk[n] as { downloads?: number } | null)?.downloads ?? 0;
      } catch (e) {
        ctx.logger.warn('npm downloads lookup failed', { error: (e as Error).message });
      }
    }
    return parseNpmSearch(json, downloads);
  },
};

// ───────────────────────── Wikipedia pageviews (interest trends) ─────────────────────────

export function pageviewTrend(items: { timestamp: string; views: number }[]): { last3: number; prev3: number; growth: number | null; lastMonth: number } {
  const v = items.map((i) => i.views);
  const last3 = v.slice(-3).reduce((a, b) => a + b, 0);
  const prev3 = v.slice(-6, -3).reduce((a, b) => a + b, 0);
  return { last3, prev3, growth: prev3 > 0 ? last3 / prev3 - 1 : null, lastMonth: v[v.length - 1] ?? 0 };
}

const ymd = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}0100`;

export const wikipediaPageviews: ConnectorDefinition = {
  id: 'wikipedia_trends',
  name: 'Wikipedia pageview trends',
  description: 'Monthly pageviews for topic articles — a proxy for public interest over time.',
  kind: 'public_api',
  signalTypes: ['demand', 'market_data'],
  terms: 'Wikimedia REST API; set a descriptive HTTP_USER_AGENT with contact details (Wikimedia policy).',
  minIntervalMs: 200,
  queryable: true,
  async search(query, { limit }, ctx) {
    const os = await getJson<[string, string[], string[], string[]]>(
      ctx,
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${Math.min(limit, 5)}&namespace=0&format=json`,
    );
    const titles = os[1] ?? [];
    // Only complete months: the API includes the in-progress month, which would distort the trend.
    const now = new Date();
    const endMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1));
    const out: FetchedDocument[] = [];
    for (const [i, title] of titles.entries()) {
      const article = encodeURIComponent(title.replace(/ /g, '_'));
      try {
        const pv = await getJson<{ items?: { timestamp: string; views: number }[] }>(
          ctx,
          `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${article}/monthly/${ymd(start)}/${ymd(endMonth)}`,
        );
        const t = pageviewTrend(pv.items ?? []);
        out.push({
          externalId: `wiki:${title}`,
          url: os[3]?.[i] ?? `https://en.wikipedia.org/wiki/${article}`,
          title: `Interest trend: ${title}`,
          content:
            `Wikipedia article "${title}" had ${t.lastMonth.toLocaleString('en-US')} pageviews last month; ` +
            `last 3 months ${t.last3.toLocaleString('en-US')} vs previous 3 months ${t.prev3.toLocaleString('en-US')}` +
            (t.growth === null ? '.' : ` (${t.growth >= 0 ? '+' : ''}${round(t.growth * 100, 1)}%).`) +
            ` ${os[2]?.[i] ?? ''}`,
          publishedAt: new Date().toISOString(),
          engagement: { views: t.lastMonth },
          metadata: { growth: t.growth, series: pv.items ?? [] },
        });
      } catch (e) {
        ctx.logger.warn('pageviews lookup failed', { title, error: (e as Error).message });
      }
    }
    return out;
  },
};
