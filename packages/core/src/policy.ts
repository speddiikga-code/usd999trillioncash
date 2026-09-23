import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { ACTION_MODE_RANK, ACTIONS, ValidationError, type ActionKey, type ActionMode } from '@roos/shared';
import type { AuditService, Actor } from './audit';

export interface PolicyLimits {
  maxAmountUsd?: number;
  maxPerDay?: number;
}

export interface PolicyDecision {
  action: ActionKey;
  mode: ActionMode;
  decision: 'allow' | 'simulate' | 'require_approval' | 'deny';
  reason: string;
  limits: PolicyLimits;
}

/**
 * Policy engine for consequential actions. Each action has a default mode and a HARD CEILING
 * (e.g. money movement can never be AUTONOMOUS; trading can only ever be SIMULATED). Organisations
 * can tighten any policy immediately; relaxing one is itself an approval-gated action.
 */
export class PolicyEngine {
  constructor(
    private db: Db,
    private audit: AuditService,
  ) {}

  static ceiling(action: ActionKey, mode: ActionMode): ActionMode {
    const max = ACTIONS[action].maxMode;
    return ACTION_MODE_RANK[mode] > ACTION_MODE_RANK[max] ? max : mode;
  }

  async get(orgId: string, action: ActionKey): Promise<{ mode: ActionMode; limits: PolicyLimits; source: 'default' | 'organization' }> {
    const row = await this.db.one<{ mode: ActionMode; limits: PolicyLimits }>('SELECT mode, limits FROM policies WHERE org_id = $1 AND action = $2', [orgId, action]);
    if (!row) return { mode: ACTIONS[action].defaultMode, limits: {}, source: 'default' };
    return { mode: PolicyEngine.ceiling(action, row.mode), limits: row.limits ?? {}, source: 'organization' };
  }

  async list(orgId: string) {
    const rows = await this.db.many<{ action: ActionKey; mode: ActionMode; limits: PolicyLimits; updated_at: Date; updated_by: string }>('SELECT * FROM policies WHERE org_id = $1', [orgId]);
    const byAction = new Map(rows.map((r) => [r.action, r]));
    return (Object.keys(ACTIONS) as ActionKey[]).map((action) => {
      const def = ACTIONS[action];
      const r = byAction.get(action);
      return {
        action,
        description: def.description,
        category: def.category,
        risk: def.risk,
        defaultMode: def.defaultMode,
        maxMode: def.maxMode,
        mode: r ? PolicyEngine.ceiling(action, r.mode) : def.defaultMode,
        limits: r?.limits ?? {},
        source: r ? 'organization' : 'default',
        updatedAt: r?.updated_at ?? null,
        updatedBy: r?.updated_by ?? null,
      };
    });
  }

  /** Returns true if applying `mode` would relax the current policy (requires approval). */
  async isRelaxation(orgId: string, action: ActionKey, mode: ActionMode, limits: PolicyLimits = {}): Promise<boolean> {
    const current = await this.get(orgId, action);
    if (ACTION_MODE_RANK[mode] > ACTION_MODE_RANK[current.mode]) return true;
    if (mode === 'AUTONOMOUS' && current.mode === 'AUTONOMOUS') {
      const loosened = (k: keyof PolicyLimits) => current.limits[k] !== undefined && (limits[k] === undefined || limits[k]! > current.limits[k]!);
      return loosened('maxAmountUsd') || loosened('maxPerDay');
    }
    return false;
  }

  /** Apply a policy. Callers must route relaxations through an approval first (see ApprovalService). */
  async apply(orgId: string, action: ActionKey, mode: ActionMode, limits: PolicyLimits, actor: Actor, approvalId?: string) {
    if (!ACTIONS[action]) throw new ValidationError(`Unknown action ${action}`);
    if (ACTION_MODE_RANK[mode] > ACTION_MODE_RANK[ACTIONS[action].maxMode]) {
      throw new ValidationError(`${action} cannot be set to ${mode}; the hard ceiling is ${ACTIONS[action].maxMode}`);
    }
    await this.db.query(
      `INSERT INTO policies (org_id, action, mode, limits, updated_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, action) DO UPDATE SET mode = EXCLUDED.mode, limits = EXCLUDED.limits, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [orgId, action, mode, json(limits), actor.id],
    );
    await this.audit.record({ orgId, actor, action: 'policy.update', targetType: 'policy', targetId: action, details: { mode, limits, approvalId: approvalId ?? null } });
  }

  async evaluate(orgId: string, action: ActionKey, ctx: { amountUsd?: number } = {}): Promise<PolicyDecision> {
    const { mode, limits } = await this.get(orgId, action);
    const base = { action, mode, limits };
    switch (mode) {
      case 'READ_ONLY':
        return { ...base, decision: 'deny', reason: `${action} is READ_ONLY for this workspace` };
      case 'SIMULATE':
        return { ...base, decision: 'simulate', reason: `${action} runs in SIMULATE mode (paper ledger only)` };
      case 'REQUIRE_APPROVAL':
        return { ...base, decision: 'require_approval', reason: `${action} requires human approval` };
      case 'AUTONOMOUS': {
        if (limits.maxAmountUsd !== undefined && (ctx.amountUsd ?? 0) > limits.maxAmountUsd) {
          return { ...base, decision: 'require_approval', reason: `Amount $${ctx.amountUsd} exceeds the autonomous limit of $${limits.maxAmountUsd}` };
        }
        if (limits.maxPerDay !== undefined) {
          const today = Number(
            await this.db.value(`SELECT COUNT(*) FROM audit_logs WHERE org_id = $1 AND action = $2 AND created_at > now() - interval '1 day'`, [orgId, `autonomous.${action}`]),
          );
          if (today >= limits.maxPerDay) return { ...base, decision: 'require_approval', reason: `Daily autonomous limit (${limits.maxPerDay}) reached for ${action}` };
        }
        return { ...base, decision: 'allow', reason: `${action} is AUTONOMOUS within limits` };
      }
    }
  }

  /** Record an autonomous execution (counts toward maxPerDay). */
  async recordAutonomous(orgId: string, action: ActionKey, actor: Actor, details: Record<string, unknown> = {}) {
    await this.audit.record({ orgId, actor, action: `autonomous.${action}`, details });
  }
}
