import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { AppError } from '@roos/shared';

/**
 * SSRF protection for every outbound HTTP request made on behalf of connectors, agents or users.
 *
 *  1. URL syntax policy: http(s) only, no embedded credentials, allowed ports, blocked internal hostnames.
 *  2. IP policy: loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT,
 *     multicast, reserved and IPv6 equivalents (incl. IPv4-mapped / NAT64 / 6to4) are refused.
 *  3. DNS-rebinding defence: the IP check runs inside the socket `lookup` hook, i.e. on the exact
 *     address the connection uses — not on an earlier, separate DNS query.
 *  4. Redirects are followed manually and every hop is re-validated; credentials are dropped cross-origin.
 *  5. Response size and time limits.
 */
export class SsrfError extends AppError {
  constructor(message: string) {
    super(message, { status: 400, code: 'SSRF_BLOCKED' });
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  for (const [base, bits] of V4_BLOCKS) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (ipv4ToInt(base) & mask)) return true;
  }
  return false;
}

/** Expand an IPv6 address into eight 16-bit groups (handles `::` and embedded IPv4). */
export function expandIPv6(ip: string): number[] | null {
  let addr = ip.replace(/^\[|\]$/g, '').split('%')[0]!;
  const v4Match = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const n = ipv4ToInt(v4Match[1]!);
    addr = addr.slice(0, -v4Match[1]!.length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

export function isPrivateIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return true;
  const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateIPv4(embeddedV4(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return isPrivateIPv4(embeddedV4(g[6]!, g[7]!)); // ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateIPv4(embeddedV4(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return isPrivateIPv4(embeddedV4(g[1]!, g[2]!)); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard-only
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip.replace(/^\[|\]$/g, ''));
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true;
}

export interface UrlPolicy {
  allowPrivate?: boolean;
  allowedPorts?: number[];
  /** If set, only these hostnames (or their subdomains) may be contacted. */
  allowedHosts?: string[];
  blockedHosts?: string[];
}

const BLOCKED_HOST_SUFFIXES = ['localhost', '.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', 'metadata.google.internal'];

export function validateUrl(raw: string, policy: UrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError(`Protocol ${url.protocol} is not allowed`);
  if (url.username || url.password) throw new SsrfError('URLs with embedded credentials are not allowed');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new SsrfError('URL has no host');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const ports = policy.allowedPorts ?? [80, 443];
  if (!policy.allowPrivate && !ports.includes(port)) throw new SsrfError(`Port ${port} is not allowed`);
  if (policy.blockedHosts?.some((h) => host === h || host.endsWith('.' + h))) throw new SsrfError(`Host ${host} is blocked`);
  if (policy.allowedHosts && !policy.allowedHosts.some((h) => host === h || host.endsWith('.' + h))) {
    throw new SsrfError(`Host ${host} is not on the allow-list`);
  }
  if (!policy.allowPrivate) {
    if (BLOCKED_HOST_SUFFIXES.some((s) => host === s.replace(/^\./, '') || host.endsWith(s))) throw new SsrfError(`Host ${host} is an internal name`);
    if (net.isIP(host) && isPrivateAddress(host)) throw new SsrfError(`Address ${host} is private or reserved`);
  }
  return url;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '');
      const list = addresses as dns.LookupAddress[];
      if (!list.length) return callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' }), '');
      if (!allowPrivate) {
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) return callback(new SsrfError(`Host ${hostname} resolves to a private/reserved address`) as unknown as NodeJS.ErrnoException, '');
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export interface SafeFetchOptions {
  method?: 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  policy?: UrlPolicy;
  signal?: AbortSignal;
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  bytes: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

export type HttpFetcher = (url: string, opts?: SafeFetchOptions) => Promise<SafeResponse>;

function requestOnce(url: URL, opts: SafeFetchOptions): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const allowPrivate = !!opts.policy?.allowPrivate;
  const lib = url.protocol === 'https:' ? https : http;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    const fail = (err: unknown) => settle(() => reject(err));
    const req = lib.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: { 'accept-encoding': 'gzip, deflate, br', ...(opts.headers ?? {}) },
        lookup: guardedLookup(allowPrivate) as unknown as typeof dns.lookup,
        timeout: opts.timeoutMs ?? 15_000,
        signal: opts.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        stream.on('data', (c: Buffer) => {
          if (settled) return;
          size += c.length;
          if (size > maxBytes) {
            fail(new AppError(`Response exceeded ${maxBytes} bytes`, { status: 502, code: 'RESPONSE_TOO_LARGE' }));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => settle(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })));
        stream.on('error', fail);
        res.on('error', fail);
      },
    );
    req.on('timeout', () => {
      fail(new AppError(`Request timed out after ${opts.timeoutMs ?? 15_000}ms`, { status: 504, code: 'TIMEOUT', retryable: true }));
      req.destroy();
    });
    req.on('error', fail);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export const safeFetch: HttpFetcher = async (rawUrl, opts = {}) => {
  let url = validateUrl(rawUrl, opts.policy);
  let method = opts.method ?? 'GET';
  let body = opts.body;
  let headers = { ...(opts.headers ?? {}) };
  const maxRedirects = opts.maxRedirects ?? 5;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await requestOnce(url, { ...opts, method, body, headers });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const next = validateUrl(new URL(res.headers.location, url).toString(), opts.policy);
      if (next.origin !== url.origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|x-api-key)$/i.test(k)));
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      url = next;
      continue;
    }
    const flatHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) flatHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
    const bytes = res.body;
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      url: url.toString(),
      headers: flatHeaders,
      bytes,
      text: () => bytes.toString('utf8'),
      json: <T>() => JSON.parse(bytes.toString('utf8')) as T,
    };
  }
  throw new SsrfError(`Too many redirects (> ${maxRedirects})`);
};
