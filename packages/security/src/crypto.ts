import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Envelope for secrets at rest: AES-256-GCM with a random 96-bit IV and the key id stored
 * alongside, so keys can be rotated (ENCRYPTION_KEY_PREVIOUS is tried for old ciphertexts).
 */
export interface EncryptedValue {
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
  keyId: string;
}

export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function encryptSecret(plaintext: string, key: Buffer, aad = 'roos-secret'): EncryptedValue {
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), keyId: keyId(key) };
}

export function decryptSecret(enc: EncryptedValue, keys: Buffer[], aad = 'roos-secret'): string {
  const key = keys.find((k) => keyId(k) === enc.keyId);
  if (!key) throw new Error(`No encryption key available for key id ${enc.keyId} (rotated without ENCRYPTION_KEY_PREVIOUS?)`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** One-way hash for storing bearer tokens / API keys (high-entropy, so SHA-256 is sufficient). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hmacSign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Show only the last 4 characters of a secret, for UIs. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••';
  return `••••${value.slice(-4)}`;
}

/** Signed, expiring token (`payloadB64.sig`) for short-lived capabilities such as CSRF tokens. */
export function signPayload(payload: Record<string, unknown>, secret: string, ttlSec: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  return `${body}.${hmacSign(body, secret)}`;
}

export function verifyPayload<T extends Record<string, unknown>>(token: string, secret: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  if (!safeEqual(sig, hmacSign(body, secret))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
    if (typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}
