import { htmlToText } from '@roos/security';
import { truncate } from '@roos/shared';
import { getJson, unixToIso } from '../http';
import type { ConnectorDefinition, FetchedDocument } from '../types';

// ───────────────────────── Hacker News (Algolia Search API) ─────────────────────────

interface HnHit {
  objectID: string;
  title?: string | null;
  url?: string | null;
  author?: string;
  points?: number | null;
  num_comments?: number | null;
  story_text?: string | null;
  comment_text?: string | null;
  story_title?: string | null;
  created_at?: string;
  created_at_i?: number;
  _tags?: string[];
}

export function parseHackerNews(json: { hits: HnHit[] }): FetchedDocument[] {
  return (json.hits ?? [])
    .map((h): FetchedDocument => {
      const isComment = !!h.comment_text;
      const body = htmlToText(h.comment_text ?? h.story_text ?? '');
      return {
        externalId: `hn:${h.objectID}`,
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        title: isComment ? `Comment on: ${h.story_title ?? 'HN thread'}` : (h.title ?? '(untitled)'),
        content: truncate(body || h.title || '', 8000),
        author: h.author,
        publishedAt: h.created_at ?? unixToIso(h.created_at_i),
        engagement: { points: h.points ?? 0, comments: h.num_comments ?? 0 },
        metadata: { type: isComment ? 'comment' : 'story', tags: h._tags ?? [], linkedUrl: h.url ?? undefined },
      };
    })
    .filter((d) => d.content.length > 20);
}

export const hackerNews: ConnectorDefinition = {
  id: 'hackernews',
  name: 'Hacker News (Algolia API)',
  description: 'Stories, Ask HN posts and comments — rich in developer and B2B pain points.',
  kind: 'public_api',
  signalTypes: ['pain_points', 'demand', 'technology', 'competitors'],
  terms: 'Public Algolia HN Search API; no key required. Content belongs to its authors — store excerpts with attribution only.',
  minIntervalMs: 1000,
  queryable: true,
  async search(query, { limit, config }, ctx) {
    const days = Number(config.days ?? 365);
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const tags = String(config.tags ?? '(story,comment)');
    const url =
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=${encodeURIComponent(tags)}` +
      `&hitsPerPage=${Math.min(limit, 100)}&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}`;
    return parseHackerNews(await getJson(ctx, url));
  },
};

// ───────────────────────── Stack Exchange API ─────────────────────────

interface SeItem {
  question_id: number;
  title: string;
  body?: string;
  link: string;
  score: number;
  answer_count: number;
  view_count: number;
  creation_date: number;
  owner?: { display_name?: string };
  tags?: string[];
  is_answered?: boolean;
}

export function parseStackExchange(json: { items?: SeItem[]; backoff?: number }, site: string): FetchedDocument[] {
  return (json.items ?? []).map((q) => ({
    externalId: `se:${site}:${q.question_id}`,
    url: q.link,
    title: htmlToText(q.title),
    content: truncate(htmlToText(q.body ?? q.title), 8000),
    author: q.owner?.display_name ? htmlToText(q.owner.display_name) : undefined,
    publishedAt: unixToIso(q.creation_date),
    engagement: { score: q.score, answers: q.answer_count, views: q.view_count },
    metadata: { site, tags: q.tags ?? [], isAnswered: q.is_answered ?? false },
  }));
}

export const stackExchange: ConnectorDefinition = {
  id: 'stackexchange',
  name: 'Stack Exchange (incl. Software Recommendations)',
  description: 'Questions from Stack Exchange sites; softwarerecs is people explicitly asking for tools.',
  kind: 'public_api',
  signalTypes: ['pain_points', 'demand', 'technology'],
  optional: ['stackexchangeKey'],
  terms: 'Stack Exchange API; content CC BY-SA — attribute and link back. 300 requests/day without a key.',
  minIntervalMs: 1500,
  queryable: true,
  async search(query, { limit, config }, ctx) {
    const sites = (Array.isArray(config.sites) ? config.sites : ['softwarerecs', 'stackoverflow']).map(String).slice(0, 4);
    const out: FetchedDocument[] = [];
    const per = Math.max(5, Math.ceil(limit / sites.length));
    for (const site of sites) {
      const key = ctx.secrets.stackexchangeKey ? `&key=${encodeURIComponent(ctx.secrets.stackexchangeKey)}` : '';
      const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=${encodeURIComponent(site)}&pagesize=${Math.min(per, 100)}&filter=withbody${key}`;
      const json = await getJson<{ items?: SeItem[]; backoff?: number }>(ctx, url);
      out.push(...parseStackExchange(json, site));
      if (json.backoff) {
        ctx.logger.warn('Stack Exchange requested backoff', { seconds: json.backoff });
        break;
      }
    }
    return out.slice(0, limit);
  },
};

// ───────────────────────── GitHub issue search ─────────────────────────

interface GhIssue {
  html_url: string;
  title: string;
  body?: string | null;
  comments: number;
  reactions?: { total_count?: number; '+1'?: number };
  created_at: string;
  user?: { login?: string };
  repository_url?: string;
  labels?: { name: string }[];
  state?: string;
  number: number;
  id: number;
}

export function parseGithubIssues(json: { items?: GhIssue[] }): FetchedDocument[] {
  return (json.items ?? []).map((i) => ({
    externalId: `gh:${i.id}`,
    url: i.html_url,
    title: i.title,
    content: truncate(i.body ?? i.title, 8000),
    author: i.user?.login,
    publishedAt: i.created_at,
    engagement: { comments: i.comments, reactions: i.reactions?.total_count ?? 0 },
    metadata: {
      repository: i.repository_url?.replace('https://api.github.com/repos/', ''),
      labels: (i.labels ?? []).map((l) => l.name),
      state: i.state,
      thumbsUp: i.reactions?.['+1'] ?? 0,
    },
  }));
}

export const githubIssues: ConnectorDefinition = {
  id: 'github',
  name: 'GitHub issue search',
  description: 'Issues and feature requests (with reaction counts) — unmet needs around popular tools.',
  kind: 'public_api',
  signalTypes: ['pain_points', 'technology', 'competitors'],
  optional: ['githubToken'],
  terms: 'GitHub REST API; unauthenticated search is limited to 10 requests/minute. Respect repository licences.',
  minIntervalMs: 6500,
  queryable: true,
  async search(query, { limit, config }, ctx) {
    const extra = typeof config.qualifiers === 'string' ? ` ${config.qualifiers}` : '';
    const q = `${query} is:issue${extra}`;
    // Default is GitHub's best-match relevance; sorting by reactions surfaces viral but off-topic issues.
    const sort = typeof config.sort === 'string' ? `&sort=${encodeURIComponent(config.sort)}&order=desc` : '';
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}${sort}&per_page=${Math.min(limit, 100)}`;
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
    if (ctx.secrets.githubToken) headers.authorization = `Bearer ${ctx.secrets.githubToken}`;
    return parseGithubIssues(await getJson(ctx, url, headers));
  },
};
