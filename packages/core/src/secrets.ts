import type { Db } from '@roos/database';
import { decryptSecret, encryptSecret, maskSecret } from '@roos/security';
import { newId, type AppConfig } from '@roos/shared';
import type { AuditService } from './audit';

/**
 * Per-organisation secrets (AI provider keys, connector tokens, Stripe keys), encrypted at rest with
 * AES-256-GCM. Values are never returned by the API — only a masked hint. The org id is bound into
 * the AEAD associated data so a ciphertext cannot be moved to another tenant.
 */
export class SecretsService {
  private cache = new Map<string, { value: string | null; at: number }>();

  constructor(
    private db: Db,
    private cfg: AppConfig,
    private audit: AuditService,
  ) {}

  private keys(): Buffer[] {
    return [this.cfg.secrets.encryptionKey, ...(this.cfg.secrets.previousEncryptionKey ? [this.cfg.secrets.previousEncryptionKey] : [])];
  }

  async set(orgId: string, name: string, value: string, actorId: string) {
    const enc = encryptSecret(value, this.cfg.secrets.encryptionKey, `${orgId}:${name}`);
    await this.db.query(
      `INSERT INTO secrets (id, org_id, name, ciphertext, iv, tag, key_id, hint, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (org_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, key_id = EXCLUDED.key_id, hint = EXCLUDED.hint, updated_at = now()`,
      [newId('secret'), orgId, name, enc.ciphertext, enc.iv, enc.tag, enc.keyId, maskSecret(value), actorId],
    );
    this.cache.delete(`${orgId}:${name}`);
    await this.audit.record({ orgId, actor: { type: 'user', id: actorId }, action: 'secret.set', targetType: 'secret', targetId: name });
  }

  async get(orgId: string, name: string): Promise<string | null> {
    const k = `${orgId}:${name}`;
    const c = this.cache.get(k);
    if (c && Date.now() - c.at < 30_000) return c.value;
    const row = await this.db.one<{ ciphertext: string; iv: string; tag: string; key_id: string }>('SELECT ciphertext, iv, tag, key_id FROM secrets WHERE org_id = $1 AND name = $2', [orgId, name]);
    const value = row ? decryptSecret({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, keyId: row.key_id }, this.keys(), `${orgId}:${name}`) : null;
    this.cache.set(k, { value, at: Date.now() });
    return value;
  }

  async list(orgId: string) {
    return this.db.many(`SELECT name, hint, key_id, updated_at FROM secrets WHERE org_id = $1 ORDER BY name`, [orgId]);
  }

  async remove(orgId: string, name: string, actorId: string) {
    await this.db.query('DELETE FROM secrets WHERE org_id = $1 AND name = $2', [orgId, name]);
    this.cache.delete(`${orgId}:${name}`);
    await this.audit.record({ orgId, actor: { type: 'user', id: actorId }, action: 'secret.delete', targetType: 'secret', targetId: name });
  }

  /** Re-encrypt every secret with the current key (after rotating ENCRYPTION_KEY). */
  async rotate(): Promise<number> {
    const rows = await this.db.many<Record<string, any>>('SELECT * FROM secrets');
    let n = 0;
    for (const r of rows) {
      const plain = decryptSecret({ ciphertext: r.ciphertext, iv: r.iv, tag: r.tag, keyId: r.key_id }, this.keys(), `${r.org_id}:${r.name}`);
      const enc = encryptSecret(plain, this.cfg.secrets.encryptionKey, `${r.org_id}:${r.name}`);
      if (enc.keyId === r.key_id) continue;
      await this.db.query('UPDATE secrets SET ciphertext=$2, iv=$3, tag=$4, key_id=$5, updated_at=now() WHERE id=$1', [r.id, enc.ciphertext, enc.iv, enc.tag, enc.keyId]);
      n++;
    }
    this.cache.clear();
    return n;
  }
}
