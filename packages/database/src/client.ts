import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import type { AppConfig, Logger } from '@roos/shared';

export type Row = Record<string, any>;

export interface QueryResult<T = Row> {
  rows: T[];
  rowCount: number;
}

/** Minimal driver surface implemented by node-postgres and PGlite adapters. */
interface Driver {
  kind: 'postgres' | 'pglite';
  query<T = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run a multi-statement script (migrations). */
  script(sql: string): Promise<void>;
  transaction<T>(fn: (tx: TxDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface TxDriver {
  query<T = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  script(sql: string): Promise<void>;
}

/**
 * Database handle. Transactions are tracked with AsyncLocalStorage: any `db.query` issued inside
 * `db.tx(fn)` — even from deeply nested service code — automatically runs on the transaction's
 * connection. Nested `tx` calls join the outer transaction.
 */
export class Db {
  private als = new AsyncLocalStorage<TxDriver>();

  constructor(private driver: Driver) {}

  get kind() {
    return this.driver.kind;
  }

  private current(): TxDriver | Driver {
    return this.als.getStore() ?? this.driver;
  }

  query<T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.current().query<T>(sql, params);
  }

  async many<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.query<T>(sql, params)).rows;
  }

  async one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.query<T>(sql, params)).rows[0] ?? null;
  }

  async value<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    const row = await this.one<Row>(sql, params);
    if (!row) return null;
    const k = Object.keys(row)[0];
    return k === undefined ? null : (row[k] as T);
  }

  async exec(sql: string, params: unknown[] = []): Promise<number> {
    return (await this.query(sql, params)).rowCount;
  }

  script(sql: string): Promise<void> {
    return this.current().script(sql);
  }

  inTransaction(): boolean {
    return this.als.getStore() !== undefined;
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn();
    return this.driver.transaction((tx) => this.als.run(tx, fn));
  }

  async ping(): Promise<boolean> {
    try {
      await this.driver.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return this.driver.close();
  }
}

/** Serialise a value for a jsonb parameter (both drivers accept JSON text for jsonb). */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

async function pgDriver(url: string, poolMax: number): Promise<Driver> {
  const pg = await import('pg');
  const { Pool, types } = pg.default ?? pg;
  // int8 / numeric → JS number (amounts are stored as double precision; counts fit in 2^53)
  types.setTypeParser(20, (v: string) => Number(v));
  types.setTypeParser(1700, (v: string) => Number(v));
  const pool = new Pool({ connectionString: url, max: poolMax, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on('error', () => {
    /* idle client errors are surfaced on next query */
  });
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<any> }): TxDriver => ({
    query: async (sql, params) => {
      const r = await c.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
    script: async (sql) => {
      await c.query(sql);
    },
  });
  const base = wrap(pool);
  return {
    kind: 'postgres',
    query: base.query,
    script: base.script,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function pgliteDriver(dataDir: string | 'memory'): Promise<Driver> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  if (dataDir !== 'memory') mkdirSync(dataDir, { recursive: true });
  const parsers = { [types.INT8]: (v: string) => Number(v), [types.NUMERIC]: (v: string) => Number(v) };
  const db = dataDir === 'memory' ? new PGlite({ parsers }) : new PGlite(dataDir, { parsers });
  await db.waitReady;
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<any>; exec: (s: string) => Promise<unknown> }): TxDriver => ({
    query: async (sql, params) => {
      const r = await c.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    script: async (sql) => {
      await c.exec(sql);
    },
  });
  const base = wrap(db);
  return {
    kind: 'pglite',
    query: base.query,
    script: base.script,
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx as any))),
    close: () => db.close(),
  };
}

/** Quick TCP reachability check (avoids long pg connection timeouts during dev fallback). */
export function canReachPostgres(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let host = 'localhost';
    let port = 5432;
    try {
      const u = new URL(url);
      host = u.hostname || 'localhost';
      port = Number(u.port || 5432);
    } catch {
      return resolve(false);
    }
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export async function createDb(opts: { url?: string; pgliteDir?: string | 'memory'; poolMax?: number }): Promise<Db> {
  if (opts.url) return new Db(await pgDriver(opts.url, opts.poolMax ?? 10));
  return new Db(await pgliteDriver(opts.pgliteDir ?? 'memory'));
}

/**
 * Connect according to configuration. In development, if DATABASE_URL is unset or unreachable and
 * DB_FALLBACK=pglite, an embedded PGlite database is used instead (single process only).
 */
export async function connectDb(cfg: AppConfig, logger?: Logger): Promise<Db> {
  if (cfg.db.url) {
    if (await canReachPostgres(cfg.db.url)) {
      const db = await createDb({ url: cfg.db.url, poolMax: cfg.db.poolMax });
      logger?.info('Connected to PostgreSQL', { url: cfg.db.url.replace(/\/\/[^@]*@/, '//***@') });
      return db;
    }
    if (cfg.db.fallback !== 'pglite') throw new Error(`PostgreSQL at ${cfg.db.url.replace(/\/\/[^@]*@/, '//***@')} is unreachable`);
    logger?.warn('PostgreSQL unreachable — falling back to embedded PGlite. Run `docker compose up -d` for the full stack.', {
      pgliteDir: cfg.db.pgliteDir,
    });
  } else if (cfg.db.fallback !== 'pglite') {
    throw new Error('DATABASE_URL is required (DB_FALLBACK=none)');
  } else {
    logger?.info('DATABASE_URL not set — using embedded PGlite', { pgliteDir: cfg.db.pgliteDir });
  }
  return createDb({ pgliteDir: cfg.db.pgliteDir });
}
