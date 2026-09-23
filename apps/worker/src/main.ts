import { Orchestrator, Scheduler } from '@roos/agents';
import { bootstrapCore } from '@roos/core';
import { AGENT_NAMES, type AgentName } from '@roos/shared';

/**
 * Background worker: claims agent tasks from the durable queue and runs the scheduler.
 *
 * WORKER_ROLES selects what this process does, so roles can be scaled independently:
 *   all (default) | scheduler | agents | <AgentName>,<AgentName>…
 * e.g. WORKER_ROLES=ResearchAgent,MarketAgent for a research pool, WORKER_ROLES=scheduler for one
 * scheduler instance. Requires PostgreSQL (embedded PGlite is single-process — the API runs an
 * embedded worker in that case).
 */
const { core, cfg, logger, db, redis } = await bootstrapCore({ service: 'worker' });
if (db.kind === 'pglite') {
  logger.error('The standalone worker needs PostgreSQL (DATABASE_URL). With embedded PGlite the API process runs the worker itself.');
  process.exit(1);
}

const roles = cfg.worker.roles;
const all = roles.includes('all');
const agentFilter = roles.filter((r): r is AgentName => (AGENT_NAMES as readonly string[]).includes(r));
const runAgents = all || roles.includes('agents') || agentFilter.length > 0;
const runScheduler = all || roles.includes('scheduler');

const orchestrator = new Orchestrator(core, {
  concurrency: cfg.worker.concurrency,
  pollMs: cfg.worker.pollMs,
  agents: agentFilter.length ? agentFilter : undefined,
  logger: logger.child({ component: 'orchestrator' }),
});
const scheduler = new Scheduler(core, orchestrator, cfg, logger.child({ component: 'scheduler' }));
if (runAgents) orchestrator.start();
if (runScheduler) scheduler.start();

const beat = () => core.system.heartbeat(orchestrator.workerId, roles, { pid: process.pid, active: orchestrator.activeCount, agents: agentFilter }).catch((e) => logger.warn('Heartbeat failed', { error: (e as Error).message }));
await beat();
const hb = setInterval(beat, 10_000);
logger.info('Worker started', { workerId: orchestrator.workerId, roles, concurrency: cfg.worker.concurrency });

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info('Worker shutting down (finishing running tasks)…', { signal });
  clearInterval(hb);
  scheduler.stop();
  await orchestrator.stop(30_000);
  await core.products.deployer.stopAll();
  await db.close();
  await redis?.quit();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
