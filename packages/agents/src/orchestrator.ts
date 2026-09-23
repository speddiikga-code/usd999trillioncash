import { hostname } from 'node:os';
import type { Core } from '@roos/core';
import { json } from '@roos/database';
import {
  ApprovalRequiredError,
  AppError,
  BudgetExceededError,
  camelize,
  errorMessage,
  newId,
  nullLogger,
  PolicyDeniedError,
  randomToken,
  sleep,
  withTimeout,
  type AgentName,
  type AgentTask,
  type Logger,
} from '@roos/shared';
import { AGENT_DEFINITIONS, AGENTS } from './agents';
import { TOOLS } from './tools';
import type { AgentBudget, AgentContext, AgentDefinition, MemoryItem, RetryPolicy, TaskResult, ToolName } from './types';

export interface EnqueueInput {
  agent: AgentName;
  kind: string;
  input: Record<string, unknown>;
  priority?: number;
  parentId?: string | null;
  workflowId?: string | null;
  createdBy: string;
  idempotencyKey?: string;
  delayMs?: number;
}

interface AgentRow {
  name: AgentName;
  enabled: boolean;
  tools: ToolName[];
  budget: AgentBudget;
  timeout_ms: number;
  retry_policy: RetryPolicy;
}

const toTask = (r: Record<string, unknown>) => camelize<AgentTask>(r);

/**
 * Agent orchestrator. Agents never talk to each other directly: every unit of work is a row in
 * `agent_tasks` (a durable queue claimed with FOR UPDATE SKIP LOCKED), and follow-up work is
 * expressed as new tasks. Each execution gets: tool permissions (allow-list + policy engine),
 * AI budgets (per task and per agent per day), a timeout, retries with exponential backoff,
 * persistent memory, execution tracing (agent_spans) and an audit trail. Tasks that need a human
 * decision pause in `waiting_approval` and resume (or are cancelled) when the approval is decided.
 */
export class Orchestrator {
  readonly workerId: string;
  private running = 0;
  private stopped = true;
  private loop?: Promise<void>;
  private logger: Logger;
  private ensured = new Set<string>();

  constructor(
    private core: Core,
    private opts: { workerId?: string; concurrency?: number; pollMs?: number; agents?: AgentName[]; logger?: Logger } = {},
  ) {
    this.workerId = opts.workerId ?? `${hostname()}-${process.pid}-${randomToken(3)}`;
    this.logger = opts.logger ?? core.logger?.child({ component: 'orchestrator' }) ?? nullLogger;
  }

  async ensureAgents(orgId: string) {
    if (this.ensured.has(orgId)) return;
    for (const d of AGENT_DEFINITIONS) {
      await this.core.db.query(
        `INSERT INTO agents (org_id, name, description, tools, budget, timeout_ms, retry_policy, model_tier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (org_id, name) DO UPDATE SET description = EXCLUDED.description`,
        [orgId, d.name, d.description, json(d.tools), json(d.budget), d.timeoutMs, json(d.retry), d.modelTier],
      );
    }
    this.ensured.add(orgId);
  }

  async enqueue(orgId: string, t: EnqueueInput): Promise<AgentTask> {
    const def = AGENTS.get(t.agent);
    if (!def || !def.handlers[t.kind]) throw new AppError(`Unknown agent task ${t.agent}/${t.kind}`, { status: 400, code: 'UNKNOWN_TASK' });
    await this.ensureAgents(orgId);
    const row = await this.core.db.one(
      `INSERT INTO agent_tasks (id, org_id, agent, kind, input, priority, parent_id, workflow_id, created_by, idempotency_key, run_after, timeout_ms, max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11::int * interval '1 millisecond'), $12, $13)
       ON CONFLICT (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`,
      [newId('task'), orgId, t.agent, t.kind, json(t.input), t.priority ?? 0, t.parentId ?? null, t.workflowId ?? null, t.createdBy, t.idempotencyKey ?? null, t.delayMs ?? 0, def.timeoutMs, def.retry.maxAttempts],
    );
    const task = row ? toTask(row) : toTask((await this.core.db.one('SELECT * FROM agent_tasks WHERE org_id = $1 AND idempotency_key = $2', [orgId, t.idempotencyKey]))!);
    if (row) await this.core.events.publish(orgId, 'task.queued', { entityType: 'agent_task', entityId: task.id, payload: { agent: t.agent, kind: t.kind, workflowId: t.workflowId } });
    return task;
  }

  async claim(): Promise<AgentTask | null> {
    const agents = this.opts.agents?.length ? this.opts.agents : null;
    const row = await this.core.db.tx(() =>
      this.core.db.one(
        `UPDATE agent_tasks SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1, started_at = now(), updated_at = now()
         WHERE id = (SELECT id FROM agent_tasks WHERE status = 'queued' AND run_after <= now() ${agents ? 'AND agent = ANY($2)' : ''}
                     ORDER BY priority DESC, run_after ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
        agents ? [this.workerId, agents] : [this.workerId],
      ),
    );
    return row ? toTask(row) : null;
  }

  private async agentRow(orgId: string, name: AgentName): Promise<AgentRow> {
    await this.ensureAgents(orgId);
    return (await this.core.db.one<AgentRow>('SELECT name, enabled, tools, budget, timeout_ms, retry_policy FROM agents WHERE org_id = $1 AND name = $2', [orgId, name]))!;
  }

  private async recordSpan(task: AgentTask, name: string, kind: 'task' | 'step' | 'tool' | 'model' | 'policy', started: number, status: 'ok' | 'error' | 'denied' | 'approval_required', attributes: Record<string, unknown> = {}) {
    await this.core.db.query(`INSERT INTO agent_spans (id, org_id, task_id, name, kind, status, started_at, ended_at, duration_ms, attributes) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9)`, [
      newId('span'),
      task.orgId,
      task.id,
      name.slice(0, 200),
      kind,
      status,
      new Date(started).toISOString(),
      Date.now() - started,
      json(attributes),
    ]);
  }

  private buildContext(task: AgentTask, def: AgentDefinition, row: AgentRow, controller: AbortController, router: AgentContext['router'], guard: ReturnType<Core['ai']['budgetGuard']>): AgentContext {
    const core = this.core;
    const actor = { type: 'agent' as const, id: `agent:${def.name}` };
    const log = this.logger.child({ agent: def.name, taskId: task.id });
    const ctx: AgentContext = {
      orgId: task.orgId,
      task,
      agent: def,
      actor,
      core,
      router,
      callCtx: { orgId: task.orgId, taskId: task.id, agent: def.name, budget: guard, signal: controller.signal },
      log,
      signal: controller.signal,
      approvalId: task.approvalId,
      memory: {
        recall: async (scope?: string | null, limit = 20) => {
          const rows = await core.db.many(
            `SELECT kind, content, scope, data, importance, created_at FROM agent_memory
             WHERE org_id = $1 AND (agent = $2 OR kind = 'lesson') ${scope ? 'AND (scope = $4 OR scope IS NULL)' : ''} AND (expires_at IS NULL OR expires_at > now())
             ORDER BY importance DESC, created_at DESC LIMIT $3`,
            scope ? [task.orgId, def.name, limit, scope] : [task.orgId, def.name, limit],
          );
          return rows.map((r) => camelize<MemoryItem>(r));
        },
      },
      span: async <T>(name: string, fn: () => Promise<T>, attrs: Record<string, unknown> = {}) => {
        const started = Date.now();
        try {
          const r = await fn();
          await this.recordSpan(task, name, 'step', started, 'ok', attrs);
          return r;
        } catch (e) {
          await this.recordSpan(task, name, 'step', started, e instanceof ApprovalRequiredError ? 'approval_required' : 'error', { ...attrs, error: errorMessage(e) });
          throw e;
        }
      },
      tool: async <T>(name: ToolName, args: Record<string, unknown>, run: () => Promise<T>): Promise<T> => {
        const started = Date.now();
        const tool = TOOLS[name];
        if (!row.tools.includes(name)) {
          await this.recordSpan(task, `tool:${name}`, 'policy', started, 'denied', { reason: 'not on allow-list' });
          await core.audit.record({ orgId: task.orgId, actor, action: `tool.${name}`, outcome: 'denied', targetType: 'agent_task', targetId: task.id, details: { reason: 'Tool not permitted for this agent' } });
          throw new PolicyDeniedError(`${def.name} is not permitted to use tool "${name}"`);
        }
        if (tool.action && tool.gate !== 'service') {
          const decision = await core.policy.evaluate(task.orgId, tool.action);
          if (decision.decision === 'deny' || decision.decision === 'simulate') {
            await this.recordSpan(task, `tool:${name}`, 'policy', started, 'denied', { mode: decision.mode });
            await core.audit.record({ orgId: task.orgId, actor, action: `tool.${name}`, outcome: 'denied', targetType: 'agent_task', targetId: task.id, details: { mode: decision.mode, reason: decision.reason } });
            throw new PolicyDeniedError(decision.reason);
          }
          if (decision.decision === 'require_approval') {
            const granted = task.approvalId ? await core.approvals.get(task.orgId, task.approvalId).catch(() => null) : null;
            const ok = granted && ['approved', 'executed'].includes(granted.status) && granted.actionType === tool.action && granted.payload.tool === name;
            if (!ok) {
              const a = await core.approvals.request(task.orgId, {
                actionType: tool.action,
                title: `${def.name}: ${tool.description}`,
                what: `Run tool "${name}" with ${JSON.stringify(args).slice(0, 400)}`,
                why: `Step "${task.kind}" of an agent workflow; the "${tool.action}" policy requires human approval.`,
                expectedBenefit: 'Allows the workflow to continue.',
                expectedCostUsd: 0,
                risk: { level: 'medium', description: `Policy for ${tool.action} is REQUIRE_APPROVAL in this workspace.` },
                dataSources: [],
                reversibility: 'reversible',
                payload: { tool: name, args },
                requestedBy: actor.id,
                taskId: task.id,
              });
              await this.recordSpan(task, `tool:${name}`, 'policy', started, 'approval_required', { approvalId: a.id });
              throw new ApprovalRequiredError(a.id);
            }
          }
        }
        try {
          const result = await run();
          await this.recordSpan(task, `tool:${name}`, 'tool', started, 'ok', { args });
          if (!tool.readOnly) await core.audit.record({ orgId: task.orgId, actor, action: `tool.${name}`, targetType: 'agent_task', targetId: task.id, details: { args } });
          return result;
        } catch (e) {
          await this.recordSpan(task, `tool:${name}`, 'tool', started, e instanceof ApprovalRequiredError ? 'approval_required' : 'error', { args, error: errorMessage(e) });
          throw e;
        }
      },
    };
    return ctx;
  }

  /** Execute one claimed task to completion (success, retry, wait for approval, or failure). */
  async runTask(task: AgentTask): Promise<AgentTask> {
    const core = this.core;
    const def = AGENTS.get(task.agent);
    const started = Date.now();
    const finish = async (status: string, patch: { output?: unknown; error?: string; runAfterMs?: number; approvalId?: string; cost?: number; tokens?: number }) => {
      await core.db.query(
        `UPDATE agent_tasks SET status = $3, output = COALESCE($4, output), error = $5, cost_usd = cost_usd + $6, tokens = tokens + $7,
           approval_id = COALESCE($8, approval_id), locked_by = NULL,
           run_after = CASE WHEN $3 = 'queued' THEN now() + ($9::int * interval '1 millisecond') ELSE run_after END,
           finished_at = CASE WHEN $3 IN ('succeeded','failed','timed_out','cancelled') THEN now() ELSE NULL END, updated_at = now()
         WHERE id = $1 AND org_id = $2`,
        [task.id, task.orgId, status, patch.output === undefined ? null : json(patch.output), patch.error ?? null, patch.cost ?? 0, patch.tokens ?? 0, patch.approvalId ?? null, patch.runAfterMs ?? 0],
      );
    };
    if (!def || !def.handlers[task.kind]) {
      await finish('failed', { error: `No handler for ${task.agent}/${task.kind}` });
      return this.get(task.orgId, task.id);
    }
    const row = await this.agentRow(task.orgId, task.agent);
    if (!row.enabled) {
      await finish('cancelled', { error: `${task.agent} is disabled in this workspace` });
      return this.get(task.orgId, task.id);
    }
    const spentToday = Number(
      (await core.db.value(`SELECT COALESCE(SUM(cost_usd), 0) FROM agent_tasks WHERE org_id = $1 AND agent = $2 AND created_at > date_trunc('day', now())`, [task.orgId, task.agent])) ?? 0,
    );
    if (spentToday >= row.budget.dailyCostUsd) {
      await finish('failed', { error: `${task.agent} daily AI budget exhausted ($${spentToday.toFixed(4)} / $${row.budget.dailyCostUsd})` });
      await core.alerts.raise(task.orgId, { severity: 'warning', title: `${task.agent} budget exhausted`, message: 'Agent tasks will fail until tomorrow or until the budget is raised.' });
      return this.get(task.orgId, task.id);
    }

    await core.db.query(`UPDATE agents SET status = 'running', last_run_at = now() WHERE org_id = $1 AND name = $2`, [task.orgId, task.agent]);
    await core.events.publish(task.orgId, 'task.started', { entityType: 'agent_task', entityId: task.id, payload: { agent: task.agent, kind: task.kind, attempt: task.attempts } });
    const controller = new AbortController();
    const guard = core.ai.budgetGuard(task.orgId, { maxTaskUsd: row.budget.maxCostPerTaskUsd, label: `${task.agent}/${task.kind}` });
    const aiAllowed = (await core.policy.evaluate(task.orgId, 'ai.model_call')).decision === 'allow';
    const router = aiAllowed ? await core.ai.routerFor(task.orgId) : null;
    const ctx = this.buildContext(task, def, row, controller, router && router.available() ? router : null, guard);
    const retry = row.retry_policy ?? def.retry;

    try {
      const result: TaskResult = await withTimeout(def.handlers[task.kind]!(ctx, task.input as Record<string, any>), row.timeout_ms ?? def.timeoutMs, () => controller.abort(), `Task timed out after ${row.timeout_ms}ms`);
      for (const m of result.memory ?? []) {
        await core.db.query(`INSERT INTO agent_memory (id, org_id, agent, scope, kind, content, data, importance, source_task_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
          newId('memory'),
          task.orgId,
          task.agent,
          m.scope ?? null,
          m.kind,
          m.content.slice(0, 2000),
          json(m.data ?? {}),
          m.importance ?? 0.5,
          task.id,
        ]);
      }
      await finish('succeeded', { output: result.output, cost: guard.spentUsd(), tokens: guard.tokens() });
      await this.recordSpan(task, `task:${task.kind}`, 'task', started, 'ok', { attempt: task.attempts, costUsd: guard.spentUsd() });
      for (const n of result.next ?? []) {
        await this.enqueue(task.orgId, { ...n, parentId: task.id, workflowId: task.workflowId ?? task.id, createdBy: `agent:${task.agent}`, delayMs: n.delayMs });
      }
      await core.events.publish(task.orgId, 'task.succeeded', { entityType: 'agent_task', entityId: task.id, payload: { agent: task.agent, kind: task.kind, next: (result.next ?? []).length } });
    } catch (e) {
      const cost = guard.spentUsd();
      const tokens = guard.tokens();
      if (e instanceof ApprovalRequiredError) {
        await finish('waiting_approval', { approvalId: e.approvalId, cost, tokens });
        await this.recordSpan(task, `task:${task.kind}`, 'task', started, 'approval_required', { approvalId: e.approvalId });
        await core.events.publish(task.orgId, 'task.waiting_approval', { entityType: 'agent_task', entityId: task.id, payload: { approvalId: e.approvalId, agent: task.agent } });
      } else {
        const timedOut = e instanceof Error && e.name === 'TimeoutError';
        const nonRetryable = e instanceof BudgetExceededError || e instanceof PolicyDeniedError || (e instanceof AppError && !e.retryable && !timedOut);
        const canRetry = !nonRetryable && task.attempts < (retry.maxAttempts ?? 3);
        const msg = errorMessage(e).slice(0, 2000);
        if (canRetry) {
          const delay = Math.round(retry.backoffMs * Math.pow(retry.factor, task.attempts - 1) * (0.8 + Math.random() * 0.4));
          await finish('queued', { error: msg, runAfterMs: delay, cost, tokens });
          this.logger.warn('Task failed; retrying', { taskId: task.id, attempt: task.attempts, delayMs: delay, error: msg });
        } else {
          await finish(timedOut ? 'timed_out' : 'failed', { error: msg, cost, tokens });
          await core.alerts.raise(task.orgId, { severity: 'warning', title: `Agent task failed: ${task.agent}/${task.kind}`, message: msg.slice(0, 500), entityType: 'agent_task', entityId: task.id });
          await core.events.publish(task.orgId, 'task.failed', { entityType: 'agent_task', entityId: task.id, payload: { agent: task.agent, kind: task.kind, error: msg.slice(0, 300) } });
        }
        await this.recordSpan(task, `task:${task.kind}`, 'task', started, 'error', { error: msg, retrying: canRetry });
      }
    } finally {
      const stillRunning = Number(await core.db.value(`SELECT COUNT(*) FROM agent_tasks WHERE org_id = $1 AND agent = $2 AND status = 'running'`, [task.orgId, task.agent]));
      await core.db.query(`UPDATE agents SET status = $3 WHERE org_id = $1 AND name = $2`, [task.orgId, task.agent, stillRunning ? 'running' : 'idle']);
    }
    return this.get(task.orgId, task.id);
  }

  /** Run queued tasks until none are claimable (tests, CLI, embedded mode). */
  async drain(maxTasks = 100): Promise<AgentTask[]> {
    const done: AgentTask[] = [];
    for (let i = 0; i < maxTasks; i++) {
      const t = await this.claim();
      if (!t) break;
      done.push(await this.runTask(t));
    }
    return done;
  }

  /** Recover tasks whose worker died mid-execution. */
  async requeueStale(): Promise<number> {
    return this.core.db.exec(
      `UPDATE agent_tasks SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'timed_out' END,
         error = COALESCE(error, 'Worker lost while running (lock expired)'), locked_by = NULL, run_after = now(), updated_at = now(),
         finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END
       WHERE status = 'running' AND locked_at < now() - ((timeout_ms + 60000) * interval '1 millisecond')`,
    );
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const concurrency = this.opts.concurrency ?? 2;
    const pollMs = this.opts.pollMs ?? 1000;
    this.loop = (async () => {
      let lastMaintenance = 0;
      while (!this.stopped) {
        try {
          if (Date.now() - lastMaintenance > 30_000) {
            lastMaintenance = Date.now();
            const n = await this.requeueStale();
            if (n) this.logger.warn('Requeued stale tasks', { count: n });
            await this.core.approvals.expireStale();
          }
          let claimed = false;
          while (this.running < concurrency && !this.stopped) {
            const task = await this.claim();
            if (!task) break;
            claimed = true;
            this.running++;
            void this.runTask(task)
              .catch((e) => this.logger.error('Task execution crashed', { taskId: task.id, error: errorMessage(e) }))
              .finally(() => this.running--);
          }
          if (!claimed) await sleep(pollMs);
        } catch (e) {
          this.logger.error('Orchestrator loop error', { error: errorMessage(e) });
          await sleep(pollMs * 3);
        }
      }
    })();
  }

  async stop(timeoutMs = 15_000) {
    this.stopped = true;
    const deadline = Date.now() + timeoutMs;
    while (this.running > 0 && Date.now() < deadline) await sleep(100);
    await this.loop;
  }

  get activeCount() {
    return this.running;
  }

  // ───────────── queries used by the API ─────────────

  async get(orgId: string, id: string): Promise<AgentTask> {
    const row = await this.core.db.one('SELECT * FROM agent_tasks WHERE id = $1 AND org_id = $2', [id, orgId]);
    if (!row) throw new AppError(`Task ${id} not found`, { status: 404, code: 'NOT_FOUND' });
    return toTask(row);
  }

  async detail(orgId: string, id: string) {
    const task = await this.get(orgId, id);
    const [spans, modelCalls, children] = await Promise.all([
      this.core.db.many('SELECT name, kind, status, started_at, ended_at, duration_ms, attributes FROM agent_spans WHERE task_id = $1 ORDER BY started_at', [id]),
      this.core.db.many('SELECT provider, model, purpose, tier, input_tokens, output_tokens, cost_usd, latency_ms, status, error, created_at FROM model_calls WHERE task_id = $1 ORDER BY created_at', [id]),
      this.core.db.many('SELECT id, agent, kind, status FROM agent_tasks WHERE parent_id = $1 ORDER BY created_at', [id]),
    ]);
    return { ...task, spans: spans.map((s) => camelize(s)), modelCalls: modelCalls.map((m) => camelize(m)), children: children.map((c) => camelize(c)) };
  }

  async list(orgId: string, q: { status?: string; agent?: string; workflowId?: string; limit?: number } = {}) {
    const params: unknown[] = [orgId];
    let where = 'org_id = $1';
    for (const [col, v] of [['status', q.status], ['agent', q.agent], ['workflow_id', q.workflowId]] as const) {
      if (v) {
        params.push(v);
        where += ` AND ${col} = $${params.length}`;
      }
    }
    params.push(Math.min(q.limit ?? 100, 500));
    return (await this.core.db.many(`SELECT * FROM agent_tasks WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params)).map(toTask);
  }

  async cancel(orgId: string, id: string, actorId: string) {
    const n = await this.core.db.exec(`UPDATE agent_tasks SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2 AND status IN ('queued','waiting_approval')`, [id, orgId]);
    await this.core.audit.record({ orgId, actor: { type: 'user', id: actorId }, action: 'task.cancel', targetType: 'agent_task', targetId: id, outcome: n ? 'success' : 'failed' });
    return n > 0;
  }

  async retryTask(orgId: string, id: string, actorId: string) {
    const n = await this.core.db.exec(
      `UPDATE agent_tasks SET status = 'queued', attempts = 0, error = NULL, run_after = now(), finished_at = NULL, updated_at = now() WHERE id = $1 AND org_id = $2 AND status IN ('failed','timed_out','cancelled')`,
      [id, orgId],
    );
    await this.core.audit.record({ orgId, actor: { type: 'user', id: actorId }, action: 'task.retry', targetType: 'agent_task', targetId: id, outcome: n ? 'success' : 'failed' });
    return n > 0;
  }

  async agents(orgId: string) {
    await this.ensureAgents(orgId);
    const rows = await this.core.db.many<Record<string, any>>(
      `SELECT a.*,
         (SELECT COUNT(*) FROM agent_tasks t WHERE t.org_id = a.org_id AND t.agent = a.name AND t.status = 'running')::int AS running,
         (SELECT COUNT(*) FROM agent_tasks t WHERE t.org_id = a.org_id AND t.agent = a.name AND t.status = 'queued')::int AS queued,
         (SELECT COUNT(*) FROM agent_tasks t WHERE t.org_id = a.org_id AND t.agent = a.name AND t.status = 'succeeded' AND t.created_at > now() - interval '7 days')::int AS succeeded_7d,
         (SELECT COUNT(*) FROM agent_tasks t WHERE t.org_id = a.org_id AND t.agent = a.name AND t.status IN ('failed','timed_out') AND t.created_at > now() - interval '7 days')::int AS failed_7d,
         (SELECT COALESCE(SUM(cost_usd), 0) FROM agent_tasks t WHERE t.org_id = a.org_id AND t.agent = a.name AND t.created_at > date_trunc('day', now())) AS cost_today_usd
       FROM agents a WHERE a.org_id = $1 ORDER BY a.name`,
      [orgId],
    );
    return rows.map((r) => ({ ...camelize<Record<string, any>>(r), kinds: Object.keys(AGENTS.get(r.name as AgentName)?.handlers ?? {}) }));
  }

  async updateAgent(orgId: string, name: AgentName, patch: { enabled?: boolean; tools?: ToolName[]; budget?: Partial<AgentBudget>; timeoutMs?: number }, actorId: string) {
    const def = AGENTS.get(name);
    if (!def) throw new AppError(`Unknown agent ${name}`, { status: 404, code: 'NOT_FOUND' });
    if (patch.tools?.some((t) => !(t in TOOLS))) throw new AppError('Unknown tool in allow-list', { status: 400, code: 'VALIDATION_ERROR' });
    const current = await this.agentRow(orgId, name);
    await this.core.db.query(`UPDATE agents SET enabled = COALESCE($3, enabled), tools = COALESCE($4, tools), budget = $5, timeout_ms = COALESCE($6, timeout_ms), updated_at = now() WHERE org_id = $1 AND name = $2`, [
      orgId,
      name,
      patch.enabled ?? null,
      patch.tools ? json(patch.tools) : null,
      json({ ...current.budget, ...(patch.budget ?? {}) }),
      patch.timeoutMs ?? null,
    ]);
    await this.core.audit.record({ orgId, actor: { type: 'user', id: actorId }, action: 'agent.update', targetType: 'agent', targetId: name, details: patch });
  }
}
