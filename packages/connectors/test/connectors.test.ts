import { describe, expect, it } from 'vitest';
import { nullLogger } from '@roos/shared';
import type { SafeResponse } from '@roos/security';
import {
  CONNECTORS,
  clearConnectorCache,
  engagementScore,
  getConnector,
  isAllowedByRobots,
  listConnectors,
  pageviewTrend,
  parseCsv,
  parseFeed,
  parseFederalRegister,
  parseGithubIssues,
  parseHackerNews,
  parseRobots,
  parseStackExchange,
  runConnector,
  type ConnectorContext,
} from '../src';

function fakeCtx(routes: Record<string, unknown>, calls: string[] = []): ConnectorContext {
  return {
    userAgent: 'ROOS-Test/1.0',
    timeoutMs: 1000,
    maxBytes: 1_000_000,
    secrets: {},
    logger: nullLogger,
    fetch: async (url) => {
      calls.push(url);
      const key = Object.keys(routes).find((k) => url.includes(k));
      const body = key === undefined ? { error: 'no route' } : routes[key];
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      const res: SafeResponse = {
        status: key === undefined ? 404 : 200,
        ok: key !== undefined,
        url,
        headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' },
        bytes: Buffer.from(text),
        text: () => text,
        json: <T>() => JSON.parse(text) as T,
      };
      return res;
    },
  };
}

describe('parsers', () => {
  it('parses Hacker News stories and comments, stripping HTML', () => {
    const docs = parseHackerNews({
      hits: [
        { objectID: '1', title: 'Ask HN: Is there a tool for invoice reconciliation?', story_text: '<p>We waste <i>hours</i> every week</p>', points: 120, num_comments: 45, created_at: '2026-08-01T00:00:00Z', author: 'a' },
        { objectID: '2', comment_text: 'I would happily pay for this &amp; more', story_title: 'Invoices', created_at_i: 1785000000, author: 'b' },
      ],
    });
    expect(docs).toHaveLength(2);
    expect(docs[0]!.content).toBe('We waste hours every week');
    expect(docs[0]!.engagement).toEqual({ points: 120, comments: 45 });
    expect(docs[0]!.url).toBe('https://news.ycombinator.com/item?id=1');
    expect(docs[1]!.title).toBe('Comment on: Invoices');
    expect(docs[1]!.content).toContain('happily pay for this & more');
  });

  it('parses Stack Exchange questions', () => {
    const [d] = parseStackExchange(
      { items: [{ question_id: 9, title: 'Tool to sync &quot;Shopify&quot; inventory?', body: '<p>Manual spreadsheets</p>', link: 'https://softwarerecs.stackexchange.com/q/9', score: 5, answer_count: 2, view_count: 900, creation_date: 1780000000, tags: ['inventory'] }] },
      'softwarerecs',
    );
    expect(d!.title).toBe('Tool to sync "Shopify" inventory?');
    expect(d!.engagement).toEqual({ score: 5, answers: 2, views: 900 });
    expect(engagementScore(d!.engagement)).toBe(5 + 4 + 9);
  });

  it('parses GitHub issues and Federal Register documents', () => {
    const [g] = parseGithubIssues({ items: [{ id: 1, number: 7, html_url: 'https://github.com/o/r/issues/7', title: 'Export to CSV', body: 'please', comments: 3, reactions: { total_count: 40, '+1': 38 }, created_at: '2026-01-01T00:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }] });
    expect(g!.metadata.repository).toBe('o/r');
    expect(g!.engagement.reactions).toBe(40);
    const [f] = parseFederalRegister({ results: [{ title: 'Beneficial ownership reporting', abstract: 'New requirements', html_url: 'https://www.federalregister.gov/d/1', publication_date: '2026-08-01', type: 'Rule', agencies: [{ name: 'Treasury' }], document_number: '2026-1' }] });
    expect(f!.content).toMatch(/Rule — Treasury\. New requirements/);
  });

  it('parses RSS and Atom feeds', () => {
    const rss = `<rss><channel><item><title><![CDATA[Launch: Acme]]></title><link>https://x.com/1</link><description>&lt;b&gt;New&lt;/b&gt; product</description><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const atom = `<feed><entry><title>Changelog</title><link href="https://y.com/2"/><summary>API v2</summary><updated>2026-09-01T00:00:00Z</updated></entry></feed>`;
    expect(parseFeed(rss, 'f')[0]).toMatchObject({ title: 'Launch: Acme', url: 'https://x.com/1' });
    expect(parseFeed(atom, 'f')[0]).toMatchObject({ title: 'Changelog', url: 'https://y.com/2', content: 'API v2' });
  });

  it('computes pageview trends', () => {
    const t = pageviewTrend([100, 100, 100, 150, 150, 150].map((v, i) => ({ timestamp: String(i), views: v })));
    expect(t.growth).toBeCloseTo(0.5, 5);
    expect(t.lastMonth).toBe(150);
  });
});

describe('robots.txt', () => {
  const txt = `User-agent: *\nDisallow: /private\nAllow: /private/public\n\nUser-agent: ROOS-Research-Bot\nDisallow: /pricing$\n`;
  it('uses the most specific user-agent group and longest match', () => {
    const generic = parseRobots(txt, 'OtherBot/1.0');
    expect(isAllowedByRobots(generic, '/private/x')).toBe(false);
    expect(isAllowedByRobots(generic, '/private/public/page')).toBe(true);
    expect(isAllowedByRobots(generic, '/pricing')).toBe(true);
    const ours = parseRobots(txt, 'ROOS-Research-Bot/0.1');
    expect(isAllowedByRobots(ours, '/pricing')).toBe(false);
    expect(isAllowedByRobots(ours, '/pricing/enterprise')).toBe(true);
  });
});

describe('CSV', () => {
  it('parses quoted fields, escaped quotes and embedded newlines', () => {
    const rows = parseCsv('Name,Email,Notes\r\n"Doe, Jane",jane@x.com,"said ""hi""\nline2"\nBob,bob@y.com,\n');
    expect(rows).toEqual([
      { name: 'Doe, Jane', email: 'jane@x.com', notes: 'said "hi"\nline2' },
      { name: 'Bob', email: 'bob@y.com', notes: '' },
    ]);
  });
});

describe('connector runtime', () => {
  it('runs a connector through the fetcher, caches results and isolates failures', async () => {
    clearConnectorCache();
    const calls: string[] = [];
    const ctx = fakeCtx({ 'hn.algolia.com': { hits: [{ objectID: '5', title: 'Is there a tool for X?', story_text: 'Tedious manual work every day', points: 3 }] } }, calls);
    const hn = getConnector('hackernews')!;
    const r1 = await runConnector(hn, 'invoice tool', { limit: 10 }, ctx);
    expect(r1.documents).toHaveLength(1);
    expect(calls[0]).toContain('query=invoice%20tool');
    const r2 = await runConnector(hn, 'invoice tool', { limit: 10 }, ctx);
    expect(r2.cached).toBe(true);
    expect(calls).toHaveLength(1);
    const failing = await runConnector(getConnector('federal_register')!, 'x', { limit: 5 }, ctx);
    expect(failing.error).toMatch(/HTTP 404/);
    expect(failing.documents).toEqual([]);
  });

  it('refuses to run keyed connectors without credentials and reports availability', async () => {
    const r = await runConnector(getConnector('brave_search')!, 'x', { limit: 5 }, fakeCtx({}));
    expect(r.error).toMatch(/Missing credentials: braveSearchKey/);
    const list = listConnectors({});
    expect(list.find((c) => c.id === 'brave_search')!.available).toBe(false);
    expect(list.find((c) => c.id === 'hackernews')!.available).toBe(true);
    expect(CONNECTORS.every((c) => c.terms.length > 10)).toBe(true);
  });

  it('respects robots.txt in the web page connector', async () => {
    clearConnectorCache();
    const ctx = fakeCtx({ '/robots.txt': 'User-agent: *\nDisallow: /secret', '/pricing': '<html><title>Acme Pricing</title><body>Pro $49/mo</body></html>' });
    const r = await runConnector(getConnector('web_page')!, '', { limit: 5, config: { urls: ['https://acme.example/pricing', 'https://acme.example/secret'] } }, ctx);
    expect(r.documents.map((d) => d.title)).toEqual(['Acme Pricing']);
    expect(r.documents[0]!.content).toContain('Pro $49/mo');
  });
});
