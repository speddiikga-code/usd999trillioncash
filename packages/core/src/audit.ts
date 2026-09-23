import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { camelize, newId, sha256Hex, stableStringify } from '@roos/shared';

export type ActorType = 'user' | 'agent' | 'system' | 'api_key' | 'webhook';

export interface Actor {
  type: ActorType;
  id: string;
  ip?: string;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: 'system' };

export interface AuditEntry {
  orgId: string | null;
  actor: Actor;
  action: string;
  targetType?: string;
  targetId?: string;
  outcome?: 'success' | 'denied' | 'failed' | 'pending';
  details?: Record<string, unknown>;
}

/**
 * Tamper-evident audit log. Entries form a per-organisation hash chain:
 * hash = sha256(prev_hash || canonical(entry)). The table is append-only (DB trigger), and
 * `verifyChain` detects any retroactive edit made by bypassing the trigger.
 */
export class AuditService {
  constructor(private db: Db) {}

  async record(e: AuditEntry): Promise<string> {
    return this.db.tx(async () => {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${e.orgId ?? 'global'}`]);
      const prev = await this.db.value<string>(
        e.orgId === null ? 'SELECT hash FROM audit_logs WHERE org_id IS NULL ORDER BY seq DESC LIMIT 1' : 'SELECT hash FROM audit_logs WHERE org_id = $1 ORDER BY seq DESC LIMIT 1',
        e.orgId === null ? [] : [e.orgId],
      );
      const id = newId('audit');
      const createdAt = new Date().toISOString();
      const canonical = {
        id,
        orgId: e.orgId,
        actorType: e.actor.type,
        actorId: e.actor.id,
        action: e.action,
        targetType: e.targetType ?? null,
        targetId: e.targetId ?? null,
        outcome: e.outcome ?? 'success',
        details: e.details ?? {},
        createdAt,
      };
      const hash = sha256Hex((prev ?? '') + stableStringify(canonical));
      await this.db.query(
        `INSERT INTO audit_logs (id, org_id, actor_type, actor_id, action, target_type, target_id, outcome, details, ip, prev_hash, hash, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, e.orgId, e.actor.type, e.actor.id, e.action, e.targetType ?? null, e.targetId ?? null, e.outcome ?? 'success', json(e.details ?? {}), e.actor.ip ?? null, prev, hash, createdAt],
      );
      return id;
    });
  }

  async list(orgId: string, opts: { limit?: number; before?: number; action?: string; targetId?: string } = {}) {
    const params: unknown[] = [orgId];
    let where = 'org_id = $1';
    if (opts.before) {
      params.push(opts.before);
      where += ` AND seq < $${params.length}`;
    }
    if (opts.action) {
      params.push(`${opts.action}%`);
      where += ` AND action LIKE $${params.length}`;
    }
    if (opts.targetId) {
      params.push(opts.targetId);
      where += ` AND target_id = $${params.length}`;
    }
    params.push(Math.min(opts.limit ?? 100, 500));
    const rows = await this.db.many(`SELECT * FROM audit_logs WHERE ${where} ORDER BY seq DESC LIMIT $${params.length}`, params);
    return rows.map((r) => camelize(r));
  }

  async verifyChain(orgId: string): Promise<{ valid: boolean; entries: number; brokenAt?: string }> {
    const rows = await this.db.many<Record<string, any>>('SELECT * FROM audit_logs WHERE org_id = $1 ORDER BY seq ASC', [orgId]);
    let prev: string | null = null;
    for (const r of rows) {
      const canonical = {
        id: r.id,
        orgId: r.org_id,
        actorType: r.actor_type,
        actorId: r.actor_id,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        outcome: r.outcome,
        details: r.details,
        createdAt: new Date(r.created_at).toISOString(),
      };
      const expected = sha256Hex((prev ?? '') + stableStringify(canonical));
      if (r.prev_hash !== prev || r.hash !== expected) return { valid: false, entries: rows.length, brokenAt: r.id };
      prev = r.hash;
    }
    return { valid: true, entries: rows.length };
  }
}
