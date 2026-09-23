import type { FastifyInstance } from 'fastify';
import { COMMAND_PERMISSIONS, parseCommand, TOOLS, type ToolName } from '@roos/agents';
import { can, maskSecret, safeEqual, type Permission } from '@roos/security';
import {
  AGENT_NAMES,
  approvalDecisionSchema,
  commandSchema,
  ForbiddenError,
  integrationStatus,
  NotFoundError,
  policyUpdateSchema,
  secretSetSchema,
  z,
  type AgentName,
} from '@roos/shared';
import { authenticate, parse, requireOrg, type ApiDeps } from '../context';
import type { Authed } from '../server';

type IdParams = { id: string };

export function registerSystemRoutes(app: FastifyInstance, deps: ApiDeps, authed: Authed) {
  const { core, orchestrator, commands } = deps;

  // ───────────── Health & observability ─────────────
  app.get('/api/health', async (_req, reply) => {
    const ok = await core.db.ping();
    reply.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'down', db: core.db.kind, time: new Date().toISOString() };
  });
  authed('GET', '/api/system/status', 'org:read', async (_req, _reply, ctx) => core.system.health(ctx.orgId));

  /** Prometheus metrics: authenticated admins, or `Authorization: Bearer $METRICS_TOKEN` for scrapers. */
  app.get('/api/metrics', async (req, reply) => {
    const token = process.env.METRICS_TOKEN;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/, '') ?? '';
    let allowed = !!token && safeEqual(bearer, token);
    if (!allowed) {
      req.auth = (await authenticate(deps, req)) ?? undefined;
      if (req.auth) allowed = can((await requireOrg(deps, req, 'settings:read')).role, 'settings:read');
    }
    if (!allowed) throw new ForbiddenError('Metrics require settings:read or METRICS_TOKEN');
    const q = await core.db.one<Record<string, number>>(
      `SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS queued, COUNT(*) FILTER (WHERE status = 'running')::int AS running,
              COUNT(*) FILTER (WHERE status = 'waiting_approval')::int AS waiting, COUNT(*) FILTER (WHERE status IN ('failed','timed_out'))::int AS failed FROM agent_tasks`,
    );
    const cost = Number((await core.db.value(`SELECT COALESCE(SUM(cost_usd), 0) FROM model_calls WHERE created_at > date_trunc('day', now())`)) ?? 0);
    reply.header('content-type', 'text/plain; version=0.0.4');
    return deps.metrics.render({
      roos_tasks_queued: q!.queued,
      roos_tasks_running: q!.running,
      roos_tasks_waiting_approval: q!.waiting,
      roos_tasks_failed_total: q!.failed,
      roos_ai_cost_usd_today: cost,
      roos_active_local_workers: orchestrator.activeCount,
    });
  });

  // ───────────── Agents, tasks, workflows, commands ─────────────
  authed('GET', '/api/agents', 'agent:read', async (_req, _reply, ctx) => ({ agents: await orchestrator.agents(ctx.orgId), tools: TOOLS }));
  authed('PATCH', '/api/agents/:name', 'agent:manage', async (req, _reply, ctx) => {
    const name = (req.params as { name: string }).name as AgentName;
    if (!(AGENT_NAMES as readonly string[]).includes(name)) throw new NotFoundError('Agent', name);
    const body = parse(
      z.object({
        enabled: z.boolean().optional(),
        tools: z.array(z.string().max(40)).max(30).optional(),
        budget: z.object({ maxCostPerTaskUsd: z.number().min(0).max(100).optional(), dailyCostUsd: z.number().min(0).max(1000).optional() }).optional(),
        timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
      }),
      req.body,
    );
    await orchestrator.updateAgent(ctx.orgId, name, { ...body, tools: body.tools as ToolName[] | undefined }, ctx.principal.userId);
    return { ok: true };
  });
  authed('GET', '/api/tasks', 'agent:read', async (req, _reply, ctx) => {
    const q = req.query as { status?: string; agent?: string; workflowId?: string; limit?: string };
    return orchestrator.list(ctx.orgId, { ...q, limit: q.limit ? Number(q.limit) : undefined });
  });
  authed('GET', '/api/tasks/:id', 'agent:read', async (req, _reply, ctx) => orchestrator.detail(ctx.orgId, (req.params as IdParams).id));
  authed('POST', '/api/tasks/:id/cancel', 'agent:run', async (req, _reply, ctx) => ({ cancelled: await orchestrator.cancel(ctx.orgId, (req.params as IdParams).id, ctx.actor.id) }));
  authed('POST', '/api/tasks/:id/retry', 'agent:run', async (req, _reply, ctx) => ({ retried: await orchestrator.retryTask(ctx.orgId, (req.params as IdParams).id, ctx.actor.id) }));
  authed('GET', '/api/workflows/:id', 'agent:read', async (req, _reply, ctx) => {
    const tasks = await orchestrator.list(ctx.orgId, { workflowId: (req.params as IdParams).id, limit: 200 });
    const done = tasks.every((t) => ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(t.status));
    return { workflowId: (req.params as IdParams).id, done, tasks: tasks.reverse() };
  });

  authed('POST', '/api/commands', 'org:read', async (req, reply, ctx) => {
    const { command } = parse(commandSchema, req.body);
    const parsed = parseCommand(command);
    const perm = COMMAND_PERMISSIONS[parsed.name] as Permission;
    if (!can(ctx.role, perm)) throw new ForbiddenError(`/${parsed.name} requires permission "${perm}"`);
    const r = await commands.execute(ctx.orgId, parsed, ctx.actor);
    if (r.workflowId) reply.status(202);
    return r;
  });

  // ───────────── Approvals ─────────────
  authed('GET', '/api/approvals', 'approval:read', async (req, _reply, ctx) => core.approvals.list(ctx.orgId, (req.query as { status?: string }).status));
  authed('GET', '/api/approvals/:id', 'approval:read', async (req, _reply, ctx) => core.approvals.get(ctx.orgId, (req.params as IdParams).id));
  authed('POST', '/api/approvals/:id/approve', 'approval:decide', async (req, _reply, ctx) => core.approvals.approve(ctx.orgId, (req.params as IdParams).id, ctx.actor, parse(approvalDecisionSchema, req.body).note));
  authed('POST', '/api/approvals/:id/reject', 'approval:decide', async (req, _reply, ctx) => core.approvals.reject(ctx.orgId, (req.params as IdParams).id, ctx.actor, parse(approvalDecisionSchema, req.body).note));

  // ───────────── Audit, reports, graph, alerts ─────────────
  authed('GET', '/api/audit', 'audit:read', async (req, _reply, ctx) => {
    const q = req.query as { before?: string; action?: string; targetId?: string; limit?: string };
    return core.audit.list(ctx.orgId, { before: q.before ? Number(q.before) : undefined, action: q.action, targetId: q.targetId, limit: q.limit ? Number(q.limit) : undefined });
  });
  authed('GET', '/api/audit/verify', 'audit:read', async (_req, _reply, ctx) => core.audit.verifyChain(ctx.orgId));

  authed('GET', '/api/reports', 'report:read', async (_req, _reply, ctx) => core.reports.list(ctx.orgId));
  authed('GET', '/api/reports/:id', 'report:read', async (req, _reply, ctx) => {
    const r = await core.reports.get(ctx.orgId, (req.params as IdParams).id);
    if (!r) throw new NotFoundError('Report');
    return r;
  });
  authed('POST', '/api/reports/generate', 'report:read', async (_req, _reply, ctx) => core.reports.generateDaily(ctx.orgId));
  authed('GET', '/api/recommendations', 'report:read', async (_req, _reply, ctx) => core.reports.recommendations(ctx.orgId));

  authed('GET', '/api/graph', 'opportunity:read', async (req, _reply, ctx) => {
    const q = req.query as { types?: string; limit?: string };
    return core.graph.graph(ctx.orgId, { types: q.types ? (q.types.split(',') as never) : undefined, limit: q.limit ? Number(q.limit) : undefined });
  });
  authed('GET', '/api/graph/nodes/:id', 'opportunity:read', async (req, _reply, ctx) => core.graph.neighborhood(ctx.orgId, (req.params as IdParams).id, Number((req.query as { depth?: string }).depth ?? 1)));

  authed('GET', '/api/alerts', 'org:read', async (req, _reply, ctx) => core.alerts.list(ctx.orgId, { includeAcknowledged: (req.query as { all?: string }).all === 'true' }));
  authed('POST', '/api/alerts/:id/ack', 'org:read', async (req, _reply, ctx) => {
    await core.alerts.acknowledge(ctx.orgId, (req.params as IdParams).id, ctx.principal.userId);
    return { ok: true };
  });

  // ───────────── Settings: policies, secrets, AI providers ─────────────
  authed('GET', '/api/policies', 'settings:read', async (_req, _reply, ctx) => core.policy.list(ctx.orgId));
  authed('PUT', '/api/policies', 'policy:write', async (req, _reply, ctx) => {
    const input = parse(policyUpdateSchema, req.body);
    return core.requestPolicyChange(ctx.orgId, input.action, input.mode, input.limits ?? {}, ctx.actor);
  });

  authed('GET', '/api/secrets', 'settings:read', async (_req, _reply, ctx) => core.secrets.list(ctx.orgId));
  authed('PUT', '/api/secrets', 'secrets:write', async (req, _reply, ctx) => {
    const { name, value } = parse(secretSetSchema, req.body);
    await core.secrets.set(ctx.orgId, name, value, ctx.principal.userId);
    if (name.startsWith('ai.')) {
      core.ai.invalidate(ctx.orgId);
      await core.orgs.markOnboarding(ctx.orgId, 'connect_ai');
    }
    return { ok: true, name, hint: maskSecret(value) };
  });
  authed('DELETE', '/api/secrets/:name', 'secrets:write', async (req, _reply, ctx) => {
    await core.secrets.remove(ctx.orgId, (req.params as { name: string }).name, ctx.principal.userId);
    core.ai.invalidate(ctx.orgId);
    return { ok: true };
  });

  authed('GET', '/api/ai/providers', 'settings:read', async (_req, _reply, ctx) => {
    const router = await core.ai.routerFor(ctx.orgId);
    const keys = await core.ai.providerKeys(ctx.orgId);
    return {
      available: router.available(),
      configured: router.configuredProviders(),
      providerOrder: core.cfg.ai.providerOrder,
      keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v ? maskSecret(v) : null])),
      quality: router.qualityStats(),
      note: router.available() ? undefined : 'No AI provider configured — agents use transparent heuristic methods (labelled "heuristic").',
    };
  });
  authed('GET', '/api/ai/usage', 'settings:read', async (_req, _reply, ctx) => core.ai.usage(ctx.orgId));
  authed('GET', '/api/ai/pricing', 'settings:read', async () => core.db.many('SELECT * FROM model_costs ORDER BY provider, tier'));
  authed('PUT', '/api/ai/pricing', 'settings:write', async (req) => {
    const b = parse(
      z.object({ provider: z.enum(['anthropic', 'openai', 'google', 'ollama']), model: z.string().min(1).max(100), tier: z.enum(['fast', 'balanced', 'deep']), inputPerMtok: z.number().min(0), outputPerMtok: z.number().min(0), note: z.string().max(300).default('Set by operator') }),
      req.body,
    );
    await core.ai.setPrice(b.provider, b.model, b.tier, b.inputPerMtok, b.outputPerMtok, b.note);
    return { ok: true };
  });
  authed('GET', '/api/integrations', 'settings:read', async () => integrationStatus(core.cfg));

  // ───────────── Event stream (SSE) & polling ─────────────
  authed('GET', '/api/events', 'org:read', async (req, _reply, ctx) => core.events.tail(ctx.orgId, Number((req.query as { after?: string }).after ?? 0), 200));

  app.get('/api/events/stream', async (req, reply) => {
    // EventSource cannot set headers; the org may be passed as ?org= (membership is still verified).
    const orgParam = (req.query as { org?: string }).org;
    if (orgParam && !req.headers['x-org-id']) req.headers['x-org-id'] = orgParam;
    const ctx = await requireOrg(deps, req, 'org:read');
    let last = Number(req.headers['last-event-id'] ?? (req.query as { after?: string }).after ?? 0);
    if (!last) last = Math.max(0, (await core.events.latestId()) - 20);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    let closed = false;
    let busy = false;
    const flush = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        for (const e of await core.events.tail(ctx.orgId, last, 200)) {
          last = e.id;
          res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        }
      } catch {
        /* transient DB error — next tick retries */
      } finally {
        busy = false;
      }
    };
    const poll = setInterval(flush, 1000);
    const heartbeat = setInterval(() => !closed && res.write(': ping\n\n'), 15_000);
    const off = core.events.on((e) => {
      if (e.orgId === ctx.orgId || e.orgId === null) void flush();
    });
    req.raw.on('close', () => {
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      off();
    });
    await flush();
  });
}
