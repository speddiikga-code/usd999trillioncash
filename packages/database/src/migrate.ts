import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@roos/shared';
import type { Db } from './client';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(path.join(dir, f), 'utf8');
      return { version: f.slice(0, 3), name: f.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Apply pending migrations. Each migration runs in its own transaction guarded by an advisory
 * lock, so API and worker processes starting simultaneously cannot both apply it.
 * Applied migrations whose file content changed are reported (and rejected in production).
 */
export async function migrate(db: Db, opts: { dir?: string; logger?: Logger; strict?: boolean } = {}): Promise<{ applied: string[]; drift: string[] }> {
  await db.script(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = loadMigrations(opts.dir);
  const applied: string[] = [];
  const drift: string[] = [];

  for (const m of files) {
    await db.tx(async () => {
      await db.query('SELECT pg_advisory_xact_lock(727274001)');
      const existing = await db.one<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version = $1', [m.version]);
      if (existing) {
        if (existing.checksum !== m.checksum) drift.push(m.name);
        return;
      }
      await db.script(m.sql);
      await db.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
      applied.push(m.name);
      opts.logger?.info('Applied migration', { migration: m.name });
    });
  }
  if (drift.length) {
    const msg = `Applied migrations were modified after being applied: ${drift.join(', ')}. Add a new migration instead.`;
    if (opts.strict) throw new Error(msg);
    opts.logger?.warn(msg);
  }
  return { applied, drift };
}

export async function migrationStatus(db: Db): Promise<{ version: string; name: string; applied: boolean; appliedAt?: string }[]> {
  const files = loadMigrations();
  let rows: { version: string; applied_at: Date }[] = [];
  try {
    rows = await db.many('SELECT version, applied_at FROM schema_migrations');
  } catch {
    rows = [];
  }
  const map = new Map(rows.map((r) => [r.version, r.applied_at]));
  return files.map((f) => ({ version: f.version, name: f.name, applied: map.has(f.version), appliedAt: map.get(f.version)?.toISOString() }));
}
