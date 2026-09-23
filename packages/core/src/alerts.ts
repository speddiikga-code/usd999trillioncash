import type { Db } from '@roos/database';
import { camelize, newId, type AlertSeverity } from '@roos/shared';
import type { EventBus } from './events';

export class AlertService {
  constructor(
    private db: Db,
    private events: EventBus,
  ) {}

  async raise(orgId: string, a: { severity: AlertSeverity; title: string; message: string; entityType?: string; entityId?: string }) {
    // De-duplicate identical unacknowledged alerts raised within the last hour.
    const dup = await this.db.one(
      `SELECT id FROM alerts WHERE org_id = $1 AND title = $2 AND acknowledged_at IS NULL AND created_at > now() - interval '1 hour'`,
      [orgId, a.title],
    );
    if (dup) return dup.id as string;
    const id = newId('alert');
    await this.db.query(`INSERT INTO alerts (id, org_id, severity, title, message, entity_type, entity_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      id,
      orgId,
      a.severity,
      a.title,
      a.message,
      a.entityType ?? null,
      a.entityId ?? null,
    ]);
    await this.events.publish(orgId, 'alert', { entityType: a.entityType, entityId: a.entityId, payload: { id, severity: a.severity, title: a.title, message: a.message } });
    return id;
  }

  async list(orgId: string, opts: { includeAcknowledged?: boolean; limit?: number } = {}) {
    const rows = await this.db.many(
      `SELECT * FROM alerts WHERE org_id = $1 ${opts.includeAcknowledged ? '' : 'AND acknowledged_at IS NULL'} ORDER BY created_at DESC LIMIT $2`,
      [orgId, opts.limit ?? 50],
    );
    return rows.map((r) => camelize(r));
  }

  async acknowledge(orgId: string, id: string, userId: string) {
    await this.db.query('UPDATE alerts SET acknowledged_at = now(), acknowledged_by = $3 WHERE id = $1 AND org_id = $2', [id, orgId, userId]);
  }
}
