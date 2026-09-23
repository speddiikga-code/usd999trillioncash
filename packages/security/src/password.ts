import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** scrypt parameters (N=2^15, r=8, p=1 ≈ 32 MiB, OWASP-recommended minimum). */
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

/** Hash format: `scrypt$N$r$p$saltB64$hashB64` — parameters are stored so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nS, rS, pS, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const n = Number(nS);
  const r = Number(rS);
  const p = Number(pS);
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: n,
    r,
    p,
    maxmem: 128 * n * r * 2,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Basic strength policy — length is what matters most (NIST 800-63B). */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('must be at least 12 characters');
  if (/^(.)\1+$/.test(password)) problems.push('must not be a single repeated character');
  if (['password1234', '123456789012', 'qwertyuiopas'].includes(password.toLowerCase())) problems.push('is too common');
  return problems;
}
