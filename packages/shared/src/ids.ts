import { randomBytes } from 'node:crypto';

/**
 * Prefixed, time-sortable identifiers, e.g. `opp_01kbq3v8f2x9w7d4m1a6c0e5`.
 * Prefixes make IDs self-describing in logs, CLI commands (/analyze opp_...) and audit trails.
 */
export const ID_PREFIXES = {
  org: 'org',
  user: 'usr',
  session: 'ses',
  apiKey: 'key',
  opportunity: 'opp',
  hypothesis: 'hyp',
  evidence: 'evd',
  document: 'doc',
  source: 'src',
  market: 'mkt',
  company: 'cmp',
  customer: 'cus',
  product: 'prd',
  project: 'prj',
  deployment: 'dep',
  experiment: 'exp',
  metric: 'met',
  revenue: 'rev',
  expense: 'xpn',
  lead: 'lead',
  campaign: 'cmpgn',
  outbox: 'msg',
  approval: 'apr',
  audit: 'aud',
  task: 'task',
  workflow: 'wf',
  span: 'spn',
  memory: 'mem',
  modelCall: 'mc',
  event: 'evt',
  node: 'kgn',
  edge: 'kge',
  report: 'rpt',
  sandboxRun: 'sbx',
  tracking: 'trk',
  secret: 'sec',
  ledger: 'ldg',
  strategy: 'stv',
  alert: 'alr',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase

function encodeTime(ms: number, len = 10): string {
  let out = '';
  let n = ms;
  for (let i = 0; i < len; i++) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRandom(len = 14): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % 32];
  return out;
}

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${encodeTime(Date.now())}${encodeRandom()}`;
}

/** Random url-safe token (for API keys, session tokens, public write keys). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
