import type { Core } from '@roos/core';
import { errorMessage, type AppConfig, type Logger } from '@roos/shared';
import type { Orchestrator } from './orchestrator';

/**
 * Periodic work, expressed as idempotent agent tasks (so multiple workers never duplicate it):
 *  - experiment evaluation every EXPERIMENT_EVAL_INTERVAL_MIN
 *  - daily report + strategy recalibration at DAILY_REPORT_HOUR_UTC
 *  - optional recurring discovery scans for configured industries (DISCOVERY_INTERVAL_MIN)
 * Demo workspaces are skipped for discovery (their data is synthetic).
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;

  constructor(
    private core: Core,
    private orchestrator: Orchestrator,
    private cfg: AppConfig,
    private logger: Logger,
  ) {}

  private slot(minutes: number, now = Date.now()) {
    return Math.floor(now / (minutes * 60_000));
  }

  async tick(now = new Date()) {
    const orgs = await this.core.db.many<{ id: string; is_demo: boolean; settings: { industries?: string[] } }>('SELECT id, is_demo, settings FROM organizations');
    const enq = (orgId: string, agent: Parameters<Orchestrator['enqueue']>[1]['agent'], kind: string, key: string, input: Record<string, unknown> = {}) =>
      this.orchestrator.enqueue(orgId, { agent, kind, input, createdBy: 'system:scheduler', idempotencyKey: key, priority: 1 });
    for (const org of orgs) {
      try {
        const evalEvery = this.cfg.scheduler.experimentEvalIntervalMin;
        if (evalEvery > 0) {
          const running = Number(await this.core.db.value(`SELECT COUNT(*) FROM experiments WHERE org_id = $1 AND status = 'running'`, [org.id]));
          if (running) await enq(org.id, 'AnalyticsAgent', 'analytics.evaluate_experiments', `eval:${this.slot(evalEvery, now.getTime())}`);
        }
        if (now.getUTCHours() === this.cfg.scheduler.dailyReportHourUtc) {
          const day = now.toISOString().slice(0, 10);
          await enq(org.id, 'AnalyticsAgent', 'analytics.daily_report', `report:${day}`);
          await enq(org.id, 'AnalyticsAgent', 'analytics.learn', `learn:${day}`);
        }
        const discEvery = this.cfg.scheduler.discoveryIntervalMin;
        if (discEvery > 0 && !org.is_demo && org.settings.industries?.length) {
          const slot = this.slot(discEvery, now.getTime());
          const industry = org.settings.industries[slot % org.settings.industries.length]!;
          await enq(org.id, 'ResearchAgent', 'research.discover', `discover:${slot}`, { query: industry });
        }
      } catch (e) {
        this.logger.warn('Scheduler tick failed for org', { orgId: org.id, error: errorMessage(e) });
      }
    }
  }

  start(intervalMs = 60_000) {
    const run = () => this.tick().catch((e) => this.logger.error('Scheduler tick failed', { error: errorMessage(e) }));
    void run();
    this.timer = setInterval(run, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
