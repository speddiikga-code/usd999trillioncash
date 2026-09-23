import { EventEmitter } from 'node:events';
import type { Db } from '@roos/database';
import { json } from '@roos/database';
import type { EventType, Logger, SystemEvent } from '@roos/shared';
import { camelize } from '@roos/shared';

export interface PublishLike {
  publish(channel: string, message: string): Promise<unknown>;
}

/**
 * Event bus: every event is appended to the `events` table (durable, ordered log that the SSE
 * stream tails across processes), emitted in-process, and — when Redis is configured — published
 * on `roos:events` for other subscribers.
 */
export class EventBus {
  private emitter = new EventEmitter();

  constructor(
    private db: Db,
    private logger: Logger,
    private redis?: PublishLike,
  ) {
    this.emitter.setMaxListeners(200);
  }

  async publish(orgId: string | null, type: EventType, opts: { entityType?: string; entityId?: string; payload?: Record<string, unknown> } = {}): Promise<SystemEvent> {
    const row = await this.db.one<Record<string, unknown>>(
      `INSERT INTO events (org_id, type, entity_type, entity_id, payload) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [orgId, type, opts.entityType ?? null, opts.entityId ?? null, json(opts.payload ?? {})],
    );
    const evt = camelize<SystemEvent>(row!);
    this.emitter.emit('event', evt);
    if (this.redis) this.redis.publish('roos:events', JSON.stringify(evt)).catch((e) => this.logger.warn('Redis publish failed', { error: (e as Error).message }));
    return evt;
  }

  /** Events for an organisation (plus global events) after a cursor — used by SSE and polling clients. */
  async tail(orgId: string, afterId: number, limit = 100): Promise<SystemEvent[]> {
    const rows = await this.db.many(`SELECT * FROM events WHERE (org_id = $1 OR org_id IS NULL) AND id > $2 ORDER BY id ASC LIMIT $3`, [orgId, afterId, limit]);
    return rows.map((r) => camelize<SystemEvent>(r));
  }

  async latestId(): Promise<number> {
    return Number((await this.db.value<number>('SELECT COALESCE(MAX(id), 0) FROM events')) ?? 0);
  }

  on(handler: (evt: SystemEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }
}
