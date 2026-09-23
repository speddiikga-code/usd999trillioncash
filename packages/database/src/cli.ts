import { createLogger, loadConfig, loadEnvFile } from '@roos/shared';
import { connectDb } from './client';
import { migrate, migrationStatus } from './migrate';

/**
 * Usage: tsx packages/database/src/cli.ts <migrate|status>
 * NOTE: with embedded PGlite, stop the API first — PGlite allows a single process per data dir.
 */
loadEnvFile();
const cfg = loadConfig();
const logger = createLogger({ bindings: { service: 'db' } });
const cmd = process.argv[2] ?? 'status';
const db = await connectDb(cfg, logger);
try {
  if (cmd === 'migrate') {
    const r = await migrate(db, { logger, strict: cfg.isProd });
    logger.info(r.applied.length ? `Applied ${r.applied.length} migration(s)` : 'Database is up to date', { applied: r.applied });
  } else if (cmd === 'status') {
    for (const m of await migrationStatus(db)) console.log(`${m.applied ? '✔' : '·'} ${m.name}${m.appliedAt ? '  ' + m.appliedAt : ''}`);
  } else {
    console.error(`Unknown command ${cmd}. Use migrate | status`);
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
