import { htmlToText } from '@roos/security';
import { truncate } from '@roos/shared';
import { getJson, getText } from '../http';
import { isAllowedByRobots, parseRobots, type RobotsRules } from '../robots';
import type { ConnectorContext, ConnectorDefinition, FetchedDocument } from '../types';

const matchesQuery = (text: string, query: string) => {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return true;
  const hay = text.toLowerCase();
  return terms.some((t) => hay.includes(t));
};

function stringList(v: unknown, max = 20): string[] {
  return (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []).map(String).filter(Boolean).slice(0, max);
}

// ───────────────────────── RSS / Atom feeds ─────────────────────────

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
};

export function parseFeed(xml: string, feedUrl: string): FetchedDocument[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  return blocks.map((b) => {
    const atomLink = b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1];
    const link = tag(b, 'link') || atomLink || '';
    const title = htmlToText(tag(b, 'title')) || '(untitled)';
    const body = htmlToText(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content') || tag(b, 'content:encoded'));
    const date = tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') || tag(b, 'dc:date');
    const parsed = date ? new Date(date) : null;
    return {
      externalId: `rss:${link || title}`,
      url: link || undefined,
      title,
      content: truncate(body || title, 8000),
      publishedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined,
      engagement: {},
      metadata: { feed: feedUrl },
    };
  });
}

export const rssFeeds: ConnectorDefinition = {
  id: 'rss',
  name: 'RSS / Atom feeds',
  description: 'Operator-configured feeds (industry news, changelogs, product launches). Config: { urls: [...] }.',
  kind: 'feed',
  signalTypes: ['demand', 'technology', 'competitors', 'market_data'],
  terms: 'Only add feeds you are permitted to consume; attribute sources.',
  minIntervalMs: 500,
  queryable: true,
  async search(query, { limit, config }, ctx) {
    const out: FetchedDocument[] = [];
    for (const url of stringList(config.urls)) {
      try {
        const { status, text } = await getText(ctx, url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' });
        if (status >= 400) continue;
        out.push(...parseFeed(text, url).filter((d) => config.noFilter || matchesQuery(`${d.title} ${d.content}`, query)));
      } catch (e) {
        ctx.logger.warn('Feed fetch failed', { url, error: (e as Error).message });
      }
    }
    return out.slice(0, limit);
  },
};

// ───────────────────────── Web pages (competitor sites, catalogs, pricing pages) ─────────────────────────

const robotsCache = new Map<string, { rules: RobotsRules; at: number }>();

async function robotsFor(origin: string, ctx: ConnectorContext): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.at < 3_600_000) return cached.rules;
  let rules: RobotsRules = { allow: [], disallow: [] };
  try {
    const { status, text } = await getText(ctx, `${origin}/robots.txt`);
    if (status === 200) rules = parseRobots(text, ctx.userAgent);
    // 401/403 on robots.txt: treat the site as disallowed (conservative).
    if (status === 401 || status === 403) rules = { allow: [], disallow: ['/'] };
  } catch {
    /* unreachable robots.txt → no rules (RFC 9309 §2.3.1.3 treats 4xx as allow) */
  }
  robotsCache.set(origin, { rules, at: Date.now() });
  return rules;
}

export const webPages: ConnectorDefinition = {
  id: 'web_page',
  name: 'Web pages (robots.txt-aware)',
  description: 'Operator-listed public pages such as competitor pricing pages or product catalogs. Config: { urls: [...] }.',
  kind: 'web',
  signalTypes: ['competitors', 'pricing'],
  terms: 'Respects robots.txt; only fetch pages whose terms permit automated access. No login-gated content.',
  minIntervalMs: 2000,
  queryable: false,
  async search(_query, { limit, config }, ctx) {
    const out: FetchedDocument[] = [];
    for (const url of stringList(config.urls).slice(0, limit)) {
      const u = new URL(url);
      const rules = await robotsFor(u.origin, ctx);
      if (!isAllowedByRobots(rules, u.pathname + u.search)) {
        ctx.logger.info('Skipping URL disallowed by robots.txt', { url });
        continue;
      }
      const { status, text, contentType } = await getText(ctx, url, { accept: 'text/html' });
      if (status >= 400 || !/html/i.test(contentType)) continue;
      const title = htmlToText(text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? url);
      out.push({
        externalId: `web:${url}`,
        url,
        title,
        content: truncate(htmlToText(text), 20_000),
        publishedAt: undefined,
        engagement: {},
        metadata: { contentType, fetchedFrom: u.hostname },
      });
    }
    return out;
  },
};

// ───────────────────────── Brave Search API (keyed) ─────────────────────────

interface BraveResponse {
  web?: { results?: { title: string; url: string; description?: string; age?: string; page_age?: string }[] };
}

export function parseBrave(json: BraveResponse): FetchedDocument[] {
  return (json.web?.results ?? []).map((r) => ({
    externalId: `brave:${r.url}`,
    url: r.url,
    title: htmlToText(r.title),
    content: htmlToText(r.description ?? ''),
    publishedAt: r.page_age ? new Date(r.page_age).toISOString() : undefined,
    engagement: {},
    metadata: { age: r.age },
  }));
}

export const braveSearch: ConnectorDefinition = {
  id: 'brave_search',
  name: 'Brave Search API',
  description: 'General web search (competitors, pricing, market commentary). Requires BRAVE_SEARCH_API_KEY.',
  kind: 'keyed_api',
  signalTypes: ['competitors', 'pricing', 'market_data', 'demand'],
  requires: ['braveSearchKey'],
  terms: 'Brave Search API subscription terms apply (storage of results may be restricted by plan).',
  minIntervalMs: 1100,
  queryable: true,
  async search(query, { limit }, ctx) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}`;
    return parseBrave(await getJson(ctx, url, { 'x-subscription-token': ctx.secrets.braveSearchKey ?? '' }));
  },
};

// ───────────────────────── Job postings (Remotive public API) ─────────────────────────

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

export function parseRemotive(json: { jobs?: RemotiveJob[] }): FetchedDocument[] {
  return (json.jobs ?? []).map((j) => ({
    externalId: `remotive:${j.id}`,
    url: j.url,
    title: `Job: ${j.title} at ${j.company_name}`,
    content: truncate(htmlToText(j.description ?? ''), 6000),
    author: j.company_name,
    publishedAt: j.publication_date ? new Date(j.publication_date).toISOString() : undefined,
    engagement: {},
    metadata: { category: j.category, jobType: j.job_type, location: j.candidate_required_location, salary: j.salary, company: j.company_name },
  }));
}

export const remotiveJobs: ConnectorDefinition = {
  id: 'remotive_jobs',
  name: 'Job postings (Remotive)',
  description: 'Remote job postings — hiring for manual, repetitive roles signals automatable workflows and budgets.',
  kind: 'public_api',
  signalTypes: ['jobs', 'demand'],
  terms: 'Remotive public API: link back to Remotive, keep request volume low (a few requests per day).',
  minIntervalMs: 10_000,
  queryable: true,
  async search(query, { limit }, ctx) {
    const json = await getJson<{ jobs?: RemotiveJob[] }>(ctx, `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=${Math.min(limit, 50)}`);
    return parseRemotive(json).slice(0, limit);
  },
};

// ───────────────────────── User-provided dataset ─────────────────────────

export const userDataset: ConnectorDefinition = {
  id: 'user_dataset',
  name: 'User-provided dataset',
  description: 'Rows uploaded by the operator (CSV/JSON: title, text, url, date, points). Stored as USER_INPUT.',
  kind: 'user_data',
  signalTypes: ['pain_points', 'demand', 'market_data'],
  terms: 'You are responsible for having the right to use uploaded data.',
  minIntervalMs: 0,
  queryable: true,
  async search(query, { limit, config }) {
    const rows = Array.isArray(config.rows) ? (config.rows as Record<string, unknown>[]) : [];
    return rows
      .map((r, i): FetchedDocument => ({
        externalId: `user:${String(r.id ?? i)}`,
        url: typeof r.url === 'string' ? r.url : undefined,
        title: String(r.title ?? `Row ${i + 1}`).slice(0, 300),
        content: String(r.text ?? r.content ?? r.body ?? '').slice(0, 8000),
        publishedAt: r.date ? new Date(String(r.date)).toISOString() : undefined,
        engagement: { points: Number(r.points ?? r.score ?? 0) || 0 },
        metadata: { userProvided: true },
      }))
      .filter((d) => config.noFilter || matchesQuery(`${d.title} ${d.content}`, query))
      .slice(0, limit);
  },
};
