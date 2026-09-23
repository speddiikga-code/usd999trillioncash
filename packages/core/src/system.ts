import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { pickSandbox } from '@roos/factory';
import { integrationStatus, type AppConfig } from '@roos/shared';

const STARTED = Date.now();

/** System health for the command center (database, queue, workers, integrations, sandbox). */
export class SystemService {
  private sandboxCache: { at: number; available: boolean } | null = null;

  constructor(
    private db: Db,
    private cfg: AppConfig,
    private redis?: { ping(): Promise<string> },
  ) {}

  async heartbeat(workerId: string, roles: string[], info: Record<string, unknown> = {}) {
    await this.db.query(
      `INSERT INTO worker_heartbeats (worker_id, roles, info) VALUES ($1,$2,$3)
       ON CONFLICT (worker_id) DO UPDATE SET roles = EXCLUDED.roles, info = EXCLUDED.info, last_seen_at = now()`,
      [workerId, json(roles), json(info)],
    );
  }

  private async sandboxAvailable() {
    if (this.sandboxCache && Date.now() - this.sandboxCache.at < 60_000) return this.sandboxCache.available;
    const s = await pickSandbox(this.cfg.sandbox.driver, this.cfg.sandbox.image);
    this.sandboxCache = { at: Date.now(), available: !!s };
    return !!s;
  }

  async health(orgId?: string) {
    const t0 = Date.now();
    const dbOk = await this.db.ping();
    const dbLatency = Date.now() - t0;
    let redis: { configured: boolean; ok: boolean | null } = { configured: !!this.cfg.redisUrl, ok: null };
    if (this.redis) {
      try {
        redis = { configured: true, ok: (await this.redis.ping()) === 'PONG' };
      } catch {
        redis = { configured: true, ok: false };
      }
    }
    const workers = await this.db.many<{ worker_id: string; roles: string[]; last_seen_at: Date; started_at: Date; info: Record<string, unknown> }>(
      `SELECT * FROM worker_heartbeats WHERE last_seen_at > now() - interval '1 day' ORDER BY last_seen_at DESC LIMIT 20`,
    );
    const queue = await this.db.one<Record<string, number>>(
      `SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS queued, COUNT(*) FILTER (WHERE status = 'running')::int AS running,
              COUNT(*) FILTER (WHERE status = 'waiting_approval')::int AS waiting_approval,
              COUNT(*) FILTER (WHERE status IN ('failed','timed_out') AND updated_at > now() - interval '1 day')::int AS failed_24h
       FROM agent_tasks ${orgId ? 'WHERE org_id = $1' : ''}`,
      orgId ? [orgId] : [],
    );
    const aliveWorkers = workers.filter((w) => Date.now() - new Date(w.last_seen_at).getTime() < 30_000);
    const sandbox = await this.sandboxAvailable();
    const status = !dbOk ? 'down' : !aliveWorkers.length || (redis.configured && redis.ok === false) || !sandbox ? 'degraded' : 'ok';
    return {
      status,
      version: '0.1.0',
      env: this.cfg.env,
      uptimeSec: Math.round((Date.now() - STARTED) / 1000),
      database: { ok: dbOk, kind: this.db.kind, latencyMs: dbLatency },
      redis,
      workers: workers.map((w) => ({ id: w.worker_id, roles: w.roles, lastSeenAt: new Date(w.last_seen_at).toISOString(), startedAt: new Date(w.started_at).toISOString(), alive: Date.now() - new Date(w.last_seen_at).getTime() < 30_000, info: w.info })),
      queue,
      sandbox: { driver: this.cfg.sandbox.driver, available: sandbox },
      integrations: integrationStatus(this.cfg),
      warnings: [
        ...(this.cfg.secrets.ephemeral ? ['APP_SECRET/ENCRYPTION_KEY are ephemeral (not set) — sessions and stored secrets will not survive a restart.'] : []),
        ...(!aliveWorkers.length ? ['No worker heartbeat in the last 30s — queued agent tasks will not run.'] : []),
        ...(!sandbox ? [`Sandbox driver "${this.cfg.sandbox.driver}" unavailable — generated code will not be executed.`] : []),
        ...(this.db.kind === 'pglite' ? ['Using embedded PGlite (single process). Use PostgreSQL for multi-process / production.'] : []),
      ],
    };
  }
}
