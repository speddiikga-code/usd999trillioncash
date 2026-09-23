import { safeFetch, type HttpFetcher, type UrlPolicy } from '@roos/security';
import { ProviderError, type ProviderName } from '../types';

/** POST JSON through the SSRF-guarded fetcher and map HTTP failures to ProviderError. */
export async function postJson<T>(
  provider: ProviderName,
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; timeoutMs: number; signal?: AbortSignal; policy?: UrlPolicy; fetcher?: HttpFetcher },
): Promise<T> {
  const fetcher = opts.fetcher ?? safeFetch;
  let res;
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs,
      maxBytes: 10 * 1024 * 1024,
      signal: opts.signal,
      policy: opts.policy,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ProviderError(provider, /timed out/i.test(msg) ? 'timeout' : 'unavailable', msg, true);
  }
  if (!res.ok) {
    let detail = res.text().slice(0, 300);
    try {
      const j = res.json<{ error?: { message?: string } | string }>();
      detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? detail);
    } catch {
      /* keep raw text */
    }
    const s = res.status;
    if (s === 429) throw new ProviderError(provider, 'rate_limited', detail, true, s);
    if (s === 401 || s === 403) throw new ProviderError(provider, 'auth', detail, false, s);
    if (s >= 500 || s === 408) throw new ProviderError(provider, 'unavailable', detail, true, s);
    throw new ProviderError(provider, 'bad_request', detail, false, s);
  }
  try {
    return res.json<T>();
  } catch {
    throw new ProviderError(provider, 'unknown', 'Provider returned non-JSON body', true, res.status);
  }
}

export function jsonInstruction(jsonSchema?: Record<string, unknown>): string {
  return (
    'Respond with a single JSON object only — no prose, no markdown code fences.' +
    (jsonSchema ? `\nThe JSON must conform to this JSON Schema:\n${JSON.stringify(jsonSchema)}` : '')
  );
}
