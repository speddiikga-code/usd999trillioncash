import { randomBytes } from 'node:crypto';
import { createDb, type Db } from './client';
import { migrate } from './migrate';

/**
 * Fresh, fully-migrated database for tests. Uses in-memory PGlite by default so the suite runs
 * without Docker. Set TEST_DATABASE_URL (a server you can CREATE DATABASE on, e.g. a disposable
 * container) to run against real PostgreSQL: every call then gets its own throwaway database,
 * dropped again on close, so parallel test files never share state.
 */
export async function createTestDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const db = await createDb({ pgliteDir: 'memory' });
    await migrate(db);
    return db;
  }

  const name = `roos_test_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  await onServer(url, `CREATE DATABASE ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const db = await createDb({ url: target.toString(), poolMax: 5 });
  const close = db.close.bind(db);
  db.close = async () => {
    await close();
    await onServer(url, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
  };
  await migrate(db);
  return db;
}

async function onServer(url: string, sql: string) {
  const admin = await createDb({ url, poolMax: 1 });
  try {
    await admin.script(sql);
  } finally {
    await admin.close();
  }
}
