import { DEFAULT_WEIGHTS, DEFAULT_WEIGHTS_VERSION, recalibrateWeights, type Outcome } from '@roos/analytics';
import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { camelize, newId, type ScoreBreakdown } from '@roos/shared';
import type { Actor, AuditService } from './audit';

/**
 * Versioned strategy parameters learned from empirical outcomes (the LEARN step of the
 * OBSERVE → HYPOTHESIZE → BUILD → TEST → DEPLOY → MEASURE → LEARN → ITERATE loop).
 */
export class StrategyService {
  private cache = new Map<string, { weights: Record<string, number>; version: string; at: number }>();

  constructor(
    private db: Db,
    private audit: AuditService,
  ) {}

  async activeWeights(orgId: string): Promise<{ weights: Record<string, number>; version: string }> {
    const c = this.cache.get(orgId);
    if (c && Date.now() - c.at < 30_000) return c;
    const row = await this.db.one<{ params: Record<string, number>; version: number }>(
      `SELECT params, version FROM strategy_versions WHERE org_id = $1 AND kind = 'scoring_weights' AND status = 'active' ORDER BY version DESC LIMIT 1`,
      [orgId],
    );
    const v = row ? { weights: row.params, version: `learned-v${row.version}` } : { weights: DEFAULT_WEIGHTS, version: DEFAULT_WEIGHTS_VERSION };
    this.cache.set(orgId, { ...v, at: Date.now() });
    return v;
  }

  async history(orgId: string) {
    return (await this.db.many(`SELECT * FROM strategy_versions WHERE org_id = $1 ORDER BY version DESC LIMIT 50`, [orgId])).map((r) => camelize(r));
  }

  /** Outcomes = concluded experiments (SCALE = 1, KILL = 0) with the criteria values the opportunity had when scored. */
  async outcomes(orgId: string): Promise<Outcome[]> {
    const rows = await this.db.many<{ decision: string; score_breakdown: ScoreBreakdown | null }>(
      `SELECT DISTINCT ON (x.opportunity_id) x.decision, o.score_breakdown
       FROM experiments x JOIN opportunities o ON o.id = x.opportunity_id
       WHERE x.org_id = $1 AND x.decision IN ('SCALE', 'KILL') AND o.score_breakdown IS NOT NULL
       ORDER BY x.opportunity_id, x.ended_at DESC NULLS LAST`,
      [orgId],
    );
    return rows
      .filter((r) => r.score_breakdown?.criteria?.length)
      .map((r) => ({ criteria: Object.fromEntries(r.score_breakdown!.criteria.map((c) => [c.key, c.value])), success: r.decision === 'SCALE' ? 1 : 0 }));
  }

  async recalibrate(orgId: string, actor: Actor) {
    const outcomes = await this.outcomes(orgId);
    const current = await this.activeWeights(orgId);
    const result = recalibrateWeights(outcomes, current.weights);
    if (result.accepted) {
      await this.db.tx(async () => {
        const version = Number((await this.db.value(`SELECT COALESCE(MAX(version), 0) FROM strategy_versions WHERE org_id = $1 AND kind = 'scoring_weights'`, [orgId])) ?? 0) + 1;
        await this.db.query(`UPDATE strategy_versions SET status = 'retired' WHERE org_id = $1 AND kind = 'scoring_weights' AND status = 'active'`, [orgId]);
        await this.db.query(`INSERT INTO strategy_versions (id, org_id, kind, version, params, metrics, status) VALUES ($1,$2,'scoring_weights',$3,$4,$5,'active')`, [
          newId('strategy'),
          orgId,
          version,
          json(result.weights),
          json({ ...result.metrics, reason: result.reason }),
        ]);
      });
      this.cache.delete(orgId);
    }
    await this.audit.record({ orgId, actor, action: 'strategy.recalibrate', outcome: result.accepted ? 'success' : 'denied', details: { ...result.metrics, reason: result.reason } });
    return result;
  }

  /** Source quality: fraction of concluded opportunities sourced from each connector that scaled. */
  async updateSourceQuality(orgId: string) {
    const rows = await this.db.many<{ connector: string; wins: number; total: number }>(
      `SELECT e.provenance->>'connector' AS connector,
              COUNT(DISTINCT x.opportunity_id) FILTER (WHERE x.decision = 'SCALE')::int AS wins,
              COUNT(DISTINCT x.opportunity_id)::int AS total
       FROM evidence e JOIN experiments x ON x.opportunity_id = e.opportunity_id
       WHERE e.org_id = $1 AND x.decision IN ('SCALE','KILL') AND e.provenance ? 'connector'
       GROUP BY 1`,
      [orgId],
    );
    for (const r of rows) {
      // Laplace-smoothed win rate so a single outcome does not dominate.
      const quality = (r.wins + 1) / (r.total + 2);
      await this.db.query('UPDATE sources SET quality_score = $3, updated_at = now() WHERE org_id = $1 AND connector = $2', [orgId, r.connector, quality]);
    }
    return rows;
  }
}
