import { createDb, type Db } from './client';
import { migrate } from './migrate';

/**
 * Fresh, fully-migrated database for tests. Uses in-memory PGlite by default so the suite runs
 * without Docker; set TEST_DATABASE_URL to run against a real PostgreSQL (use a disposable DB).
 */
export async function createTestDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  const db = url ? await createDb({ url }) : await createDb({ pgliteDir: 'memory' });
  if (url) {
    await db.script('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }
  await migrate(db);
  return db;
}
