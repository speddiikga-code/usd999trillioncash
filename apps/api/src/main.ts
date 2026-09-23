import { bootstrapCore, seedDemo } from '@roos/core';
import { createApi } from './app';

/**
 * API entrypoint. With embedded PGlite (no DATABASE_URL / Postgres unreachable) the database can
 * only be opened by one process, so the worker runs inside the API process automatically.
 */
const { core, cfg, logger, db, redis } = await bootstrapCore({ service: 'api' });
const embedded = cfg.worker.embedded || db.kind === 'pglite';
await core.products.reconcileOnStartup();
if (process.env.SEED_DEMO !== 'false' && !(await core.orgs.demoOrg())) {
  logger.info('Seeding the demo workspace (synthetic data, clearly labelled DEMO)…');
  await seedDemo(core);
}
const api = await createApi(core, { redis, embeddedWorker: embedded });
await api.app.listen({ host: cfg.api.host, port: cfg.api.port });
logger.info(`API listening on http://${cfg.api.host}:${cfg.api.port}`, { db: db.kind, embeddedWorker: embedded, redis: !!redis });

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 20_000);
  try {
    await api.close();
    await db.close();
    await redis?.quit();
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => logger.error('Unhandled rejection', { error: e instanceof Error ? e.message : String(e) }));
