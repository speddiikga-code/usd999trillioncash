import { ExternalServiceError } from '@roos/shared';
import type { ConnectorContext } from './types';

export async function getJson<T>(ctx: ConnectorContext, url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await ctx.fetch(url, {
    headers: { 'user-agent': ctx.userAgent, accept: 'application/json', ...headers },
    timeoutMs: ctx.timeoutMs,
    maxBytes: ctx.maxBytes,
    signal: ctx.signal,
  });
  if (!res.ok) {
    throw new ExternalServiceError(`${new URL(url).hostname} returned HTTP ${res.status}`, {
      retryable: res.status === 429 || res.status >= 500,
      details: { status: res.status, body: res.text().slice(0, 300) },
    });
  }
  try {
    return res.json<T>();
  } catch (e) {
    throw new ExternalServiceError(`${new URL(url).hostname} returned invalid JSON`, { retryable: false, cause: e });
  }
}

export async function getText(ctx: ConnectorContext, url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; contentType: string }> {
  const res = await ctx.fetch(url, {
    headers: { 'user-agent': ctx.userAgent, ...headers },
    timeoutMs: ctx.timeoutMs,
    maxBytes: ctx.maxBytes,
    signal: ctx.signal,
  });
  return { status: res.status, text: res.text(), contentType: res.headers['content-type'] ?? '' };
}

export const unixToIso = (s: number | undefined) => (s ? new Date(s * 1000).toISOString() : undefined);
