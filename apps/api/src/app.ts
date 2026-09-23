import { CommandCenter, Orchestrator, Scheduler } from '@roos/agents';
import type { Core } from '@roos/core';
import type { RedisLike } from '@roos/security';
import { newLimiter, type ApiDeps } from './context';
import { ErrorReporter, Metrics } from './observability';
import { buildServer } from './server';

/** Assemble the API (and optionally an embedded worker) around a Core instance. */
export async function createApi(core: Core, opts: { redis?: RedisLike; embeddedWorker?: boolean } = {}) {
  const orchestrator = new Orchestrator(core, { concurrency: core.cfg.worker.concurrency, pollMs: core.cfg.worker.pollMs, logger: core.logger.child({ component: 'orchestrator' }) });
  const deps: ApiDeps = {
    core,
    orchestrator,
    commands: new CommandCenter(core, orchestrator),
    limiter: newLimiter(opts.redis),
    metrics: new Metrics(),
    errors: new ErrorReporter(core.cfg, core.logger),
  };
  const app = await buildServer(deps);
  let scheduler: Scheduler | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  if (opts.embeddedWorker) {
    orchestrator.start();
    scheduler = new Scheduler(core, orchestrator, core.cfg, core.logger.child({ component: 'scheduler' }));
    scheduler.start();
    const beat = () => core.system.heartbeat(orchestrator.workerId, ['embedded', 'all'], { pid: process.pid, active: orchestrator.activeCount }).catch(() => undefined);
    void beat();
    heartbeat = setInterval(beat, 10_000);
  }
  const close = async () => {
    scheduler?.stop();
    if (heartbeat) clearInterval(heartbeat);
    await orchestrator.stop();
    await core.products.deployer.stopAll();
    await app.close();
  };
  return { app, deps, orchestrator, close };
}
