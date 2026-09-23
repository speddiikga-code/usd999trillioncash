import type { Db } from '@roos/database';
import { json } from '@roos/database';
import {
  ACTIONS,
  camelize,
  ConflictError,
  errorMessage,
  newId,
  NotFoundError,
  sha256Hex,
  stableStringify,
  type ActionKey,
  type ApprovalRequest,
  type Logger,
  type Reversibility,
  type RiskLevel,
  type SourceRef,
} from '@roos/shared';
import type { AuditService, Actor } from './audit';
import type { EventBus } from './events';

export interface ApprovalInput {
  actionType: ActionKey;
  title: string;
  what: string;
  why: string;
  expectedBenefit: string;
  expectedCostUsd: number;
  risk: { level: RiskLevel; description: string };
  dataSources: SourceRef[];
  reversibility: Reversibility;
  payload: Record<string, unknown>;
  requestedBy: string;
  taskId?: string | null;
  expiresInHours?: number;
}

export type ApprovalExecutor = (approval: ApprovalRequest, actor: Actor) => Promise<Record<string, unknown>>;

/**
 * Human approval center. Every approval request states WHAT will happen, WHY, the expected
 * BENEFIT and COST, the RISK, the DATA SOURCES it relies on and whether it is REVERSIBLE.
 * Approving runs the registered executor for the action type; the outcome is stored and audited.
 * If the request came from a paused agent task, that task is resumed (approve) or cancelled (reject).
 */
export class ApprovalService {
  private executors = new Map<string, ApprovalExecutor>();

  constructor(
    private db: Db,
    private audit: AuditService,
    private events: EventBus,
    private logger: Logger,
  ) {}

  registerExecutor(action: ActionKey, fn: ApprovalExecutor) {
    this.executors.set(action, fn);
  }

  hasExecutor(action: ActionKey) {
    return this.executors.has(action);
  }

  async request(orgId: string, input: ApprovalInput): Promise<ApprovalRequest> {
    const fingerprint = sha256Hex(stableStringify({ a: input.actionType, p: input.payload }));
    const existing = await this.db.one(`SELECT * FROM approvals WHERE org_id = $1 AND status = 'pending' AND payload->>'_fingerprint' = $2`, [orgId, fingerprint]);
    if (existing) return camelize<ApprovalRequest>(existing);
    const id = newId('approval');
    const expiresAt = new Date(Date.now() + (input.expiresInHours ?? 72) * 3_600_000).toISOString();
    const row = await this.db.one(
      `INSERT INTO approvals (id, org_id, action_type, title, what, why, expected_benefit, expected_cost_usd, risk, data_sources, reversibility, payload, requested_by, task_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        id,
        orgId,
        input.actionType,
        input.title,
        input.what,
        input.why,
        input.expectedBenefit,
        input.expectedCostUsd,
        json(input.risk),
        json(input.dataSources),
        input.reversibility,
        json({ ...input.payload, _fingerprint: fingerprint }),
        input.requestedBy,
        input.taskId ?? null,
        expiresAt,
      ],
    );
    const approval = camelize<ApprovalRequest>(row!);
    await this.audit.record({ orgId, actor: { type: input.requestedBy.startsWith('agent:') ? 'agent' : 'user', id: input.requestedBy }, action: 'approval.request', targetType: 'approval', targetId: id, outcome: 'pending', details: { actionType: input.actionType, title: input.title, expectedCostUsd: input.expectedCostUsd } });
    await this.events.publish(orgId, 'approval.requested', { entityType: 'approval', entityId: id, payload: { title: input.title, actionType: input.actionType, risk: input.risk.level } });
    return approval;
  }

  async get(orgId: string, id: string): Promise<ApprovalRequest> {
    const row = await this.db.one('SELECT * FROM approvals WHERE id = $1 AND org_id = $2', [id, orgId]);
    if (!row) throw new NotFoundError('Approval', id);
    return camelize<ApprovalRequest>(row);
  }

  async list(orgId: string, status?: string) {
    const rows = status
      ? await this.db.many(`SELECT * FROM approvals WHERE org_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 200`, [orgId, status])
      : await this.db.many(`SELECT * FROM approvals WHERE org_id = $1 ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 200`, [orgId]);
    return rows.map((r) => ({ ...camelize<ApprovalRequest>(r), actionMeta: ACTIONS[r.action_type as ActionKey] ?? null }));
  }

  async approve(orgId: string, id: string, actor: Actor, note?: string): Promise<ApprovalRequest> {
    const approval = await this.decide(orgId, id, 'approved', actor, note);
    const executor = this.executors.get(approval.actionType);
    let final = approval;
    if (executor) {
      try {
        const result = await executor(approval, actor);
        final = camelize<ApprovalRequest>(
          (await this.db.one(`UPDATE approvals SET status = 'executed', result = $3, executed_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *`, [id, orgId, json(result)]))!,
        );
        await this.audit.record({ orgId, actor, action: 'approval.execute', targetType: 'approval', targetId: id, details: { actionType: approval.actionType, result } });
        await this.events.publish(orgId, 'approval.executed', { entityType: 'approval', entityId: id, payload: { actionType: approval.actionType } });
      } catch (e) {
        this.logger.error('Approval executor failed', { approvalId: id, error: errorMessage(e) });
        final = camelize<ApprovalRequest>(
          (await this.db.one(`UPDATE approvals SET status = 'failed', result = $3, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *`, [id, orgId, json({ error: errorMessage(e) })]))!,
        );
        await this.audit.record({ orgId, actor, action: 'approval.execute', targetType: 'approval', targetId: id, outcome: 'failed', details: { error: errorMessage(e) } });
      }
    }
    if (approval.taskId) {
      await this.db.query(`UPDATE agent_tasks SET status = 'queued', approval_id = $2, run_after = now(), locked_by = NULL, updated_at = now() WHERE id = $1 AND status = 'waiting_approval'`, [approval.taskId, id]);
    }
    return final;
  }

  async reject(orgId: string, id: string, actor: Actor, note?: string): Promise<ApprovalRequest> {
    const approval = await this.decide(orgId, id, 'rejected', actor, note);
    if (approval.taskId) {
      await this.db.query(`UPDATE agent_tasks SET status = 'cancelled', error = $2, finished_at = now(), updated_at = now() WHERE id = $1 AND status = 'waiting_approval'`, [approval.taskId, `Rejected by ${actor.id}${note ? `: ${note}` : ''}`]);
    }
    return approval;
  }

  private async decide(orgId: string, id: string, status: 'approved' | 'rejected', actor: Actor, note?: string): Promise<ApprovalRequest> {
    const current = await this.get(orgId, id);
    if (current.status !== 'pending') throw new ConflictError(`Approval is already ${current.status}`);
    if (current.expiresAt && new Date(current.expiresAt).getTime() < Date.now()) {
      await this.db.query(`UPDATE approvals SET status = 'expired', updated_at = now() WHERE id = $1`, [id]);
      throw new ConflictError('Approval request has expired');
    }
    const row = await this.db.one(
      `UPDATE approvals SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5, updated_at = now() WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING *`,
      [id, orgId, status, actor.id, note ?? null],
    );
    if (!row) throw new ConflictError('Approval was decided concurrently');
    const approval = camelize<ApprovalRequest>(row);
    await this.audit.record({
      orgId,
      actor,
      action: `approval.${status === 'approved' ? 'approve' : 'reject'}`,
      targetType: 'approval',
      targetId: id,
      details: { actionType: approval.actionType, note: note ?? null, selfApproved: approval.requestedBy === actor.id },
    });
    await this.events.publish(orgId, 'approval.decided', { entityType: 'approval', entityId: id, payload: { status, actionType: approval.actionType } });
    return approval;
  }

  async expireStale(): Promise<number> {
    return this.db.exec(`UPDATE approvals SET status = 'expired', updated_at = now() WHERE status = 'pending' AND expires_at < now()`);
  }
}
