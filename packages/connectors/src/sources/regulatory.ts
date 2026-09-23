import { truncate } from '@roos/shared';
import { getJson } from '../http';
import type { ConnectorDefinition, FetchedDocument } from '../types';

// ───────────────────────── US Federal Register ─────────────────────────

interface FrDoc {
  title: string;
  abstract?: string | null;
  html_url: string;
  publication_date: string;
  type?: string;
  agencies?: { name?: string; raw_name?: string }[];
  document_number: string;
  significant?: boolean | null;
}

export function parseFederalRegister(json: { results?: FrDoc[] }): FetchedDocument[] {
  return (json.results ?? []).map((d) => {
    const agencies = (d.agencies ?? []).map((a) => a.name ?? a.raw_name ?? '').filter(Boolean);
    return {
      externalId: `fr:${d.document_number}`,
      url: d.html_url,
      title: d.title,
      content: truncate(`${d.type ?? 'Document'} — ${agencies.join(', ')}. ${d.abstract ?? ''}`, 8000),
      publishedAt: new Date(d.publication_date).toISOString(),
      engagement: {},
      metadata: { documentType: d.type, agencies, significant: d.significant ?? null },
    };
  });
}

export const federalRegister: ConnectorDefinition = {
  id: 'federal_register',
  name: 'US Federal Register',
  description: 'New rules, proposed rules and notices — regulatory changes create compliance demand.',
  kind: 'public_api',
  signalTypes: ['regulatory'],
  terms: 'Public domain US government data (federalregister.gov API, no key).',
  minIntervalMs: 1000,
  queryable: true,
  async search(query, { limit }, ctx) {
    const fields = ['title', 'abstract', 'html_url', 'publication_date', 'type', 'agencies', 'document_number', 'significant'].map((f) => `fields[]=${f}`).join('&');
    const url = `https://www.federalregister.gov/api/v1/documents.json?conditions[term]=${encodeURIComponent(query)}&order=newest&per_page=${Math.min(limit, 100)}&${fields}`;
    return parseFederalRegister(await getJson(ctx, url));
  },
};

// ───────────────────────── SEC EDGAR full-text search ─────────────────────────

interface EdgarHit {
  _id: string;
  _source: { display_names?: string[]; file_date?: string; form?: string; ciks?: string[]; adsh?: string; period_ending?: string };
}

export function parseEdgar(json: { hits?: { hits?: EdgarHit[] } }, query: string): FetchedDocument[] {
  return (json.hits?.hits ?? []).map((h) => {
    const s = h._source;
    const cik = (s.ciks?.[0] ?? '').replace(/^0+/, '');
    const [adsh, file] = h._id.split(':');
    const url = cik && adsh && file ? `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, '')}/${file}` : undefined;
    return {
      externalId: `edgar:${h._id}`,
      url,
      title: `${s.form ?? 'Filing'}: ${(s.display_names ?? ['Unknown filer']).join('; ')}`,
      content: `SEC ${s.form ?? 'filing'} filed ${s.file_date ?? '?'} mentions "${query}". Company: ${(s.display_names ?? []).join('; ')}.`,
      publishedAt: s.file_date ? new Date(s.file_date).toISOString() : undefined,
      engagement: {},
      metadata: { form: s.form, ciks: s.ciks, periodEnding: s.period_ending },
    };
  });
}

export const secEdgar: ConnectorDefinition = {
  id: 'sec_edgar',
  name: 'SEC EDGAR full-text search',
  description: 'Public-company filings mentioning a topic (risk factors, market commentary).',
  kind: 'keyed_api',
  signalTypes: ['market_data', 'competitors', 'regulatory'],
  requires: ['secUserAgent'],
  terms: 'SEC fair-access policy: declare a User-Agent with company name and contact email (SEC_USER_AGENT); ≤10 requests/second.',
  minIntervalMs: 250,
  queryable: true,
  async search(query, { limit, config }, ctx) {
    const forms = typeof config.forms === 'string' ? config.forms : '10-K';
    const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${query}"`)}&forms=${encodeURIComponent(forms)}`;
    const json = await getJson<{ hits?: { hits?: EdgarHit[] } }>(ctx, url, { 'user-agent': ctx.secrets.secUserAgent ?? ctx.userAgent });
    return parseEdgar(json, query).slice(0, limit);
  },
};
