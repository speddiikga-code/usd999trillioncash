import type { FastifyInstance } from 'fastify';
import { parseCommand } from '@roos/agents';
import { listConnectors, parseCsv } from '@roos/connectors';
import { newId } from '@roos/shared';
import {
  discoverSchema,
  hypothesisSelectSchema,
  NotFoundError,
  opportunityCreateSchema,
  opportunityListQuery,
  opportunityUpdateSchema,
  sourceConfigSchema,
  z,
} from '@roos/shared';
import { parse, type ApiDeps } from '../context';
import type { Authed } from '../server';

type IdParams = { id: string };

export function registerOpportunityRoutes(_app: FastifyInstance, deps: ApiDeps, authed: Authed) {
  const { core, orchestrator, commands } = deps;

  /** Discovery runs as an agent workflow (async). `wait: true` runs it inline (slower, returns results). */
  authed('POST', '/api/opportunities/discover', 'research:run', async (req, reply, ctx) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = parse(discoverSchema, body);
    if (body.wait === true) {
      const router = await core.ai.routerFor(ctx.orgId);
      const budget = core.ai.budgetGuard(ctx.orgId, { label: 'discover (inline)' });
      return core.discovery.scan(ctx.orgId, input, { router: router.available() ? router : null, callCtx: { orgId: ctx.orgId, budget }, actor: ctx.actor });
    }
    const workflowId = newId('workflow');
    const task = await orchestrator.enqueue(ctx.orgId, { agent: 'ResearchAgent', kind: 'research.discover', input, workflowId, createdBy: ctx.actor.id, priority: 10 });
    reply.status(202);
    return { workflowId, taskId: task.id, status: 'queued' };
  });

  authed('GET', '/api/opportunities', 'opportunity:read', async (req, _reply, ctx) => core.opportunities.list(ctx.orgId, parse(opportunityListQuery, req.query)));

  authed('POST', '/api/opportunities', 'opportunity:write', async (req, reply, ctx) => {
    reply.status(201);
    return core.opportunities.createManual(ctx.orgId, parse(opportunityCreateSchema, req.body), ctx.actor);
  });

  authed('GET', '/api/opportunities/:id', 'opportunity:read', async (req, _reply, ctx) => {
    const id = await core.opportunities.resolveId(ctx.orgId, (req.params as IdParams).id);
    return core.opportunities.detail(ctx.orgId, id);
  });

  authed('PATCH', '/api/opportunities/:id', 'opportunity:write', async (req, _reply, ctx) => core.opportunities.update(ctx.orgId, (req.params as IdParams).id, parse(opportunityUpdateSchema, req.body), ctx.actor));

  // Workflow triggers (same semantics as the command center)
  const trigger = (path: string, command: string, permission: Parameters<Authed>[2], opts: (body: Record<string, unknown>) => string = () => '') =>
    authed('POST', `/api/opportunities/:id/${path}`, permission, async (req, reply, ctx) => {
      const id = await core.opportunities.resolveId(ctx.orgId, (req.params as IdParams).id);
      reply.status(202);
      return commands.execute(ctx.orgId, parseCommand(`/${command} ${id} ${opts((req.body ?? {}) as Record<string, unknown>)}`), ctx.actor);
    });
  trigger('analyze', 'analyze', 'research:run');
  trigger('build', 'build', 'build:run', (b) => (typeof b.hypothesisId === 'string' ? `hypothesis=${b.hypothesisId.replace(/\s/g, '')}` : ''));
  trigger('experiment', 'experiment', 'experiment:write', (b) => `budget=${Number(b.budgetUsd ?? 0)} minSample=${Number(b.minSample ?? 200)}`);
  trigger('launch', 'launch', 'deploy:run', (b) => (b.production === true ? 'production=true' : ''));
  trigger('growth', 'growth', 'campaign:write');

  authed('POST', '/api/opportunities/:id/hypotheses/select', 'opportunity:write', async (req, _reply, ctx) => {
    const { hypothesisId } = parse(hypothesisSelectSchema, req.body);
    return core.analysis.selectHypothesis(ctx.orgId, (req.params as IdParams).id, hypothesisId, ctx.actor);
  });

  authed('GET', '/api/opportunities/:id/graph', 'opportunity:read', async (req, _reply, ctx) => {
    const node = await core.graph.findNode(ctx.orgId, 'opportunity', (req.params as IdParams).id);
    if (!node) throw new NotFoundError('Graph node for opportunity');
    return core.graph.neighborhood(ctx.orgId, node.id, 2);
  });

  // Data sources
  authed('GET', '/api/sources', 'org:read', async (_req, _reply, ctx) => {
    await core.discovery.ensureDefaultSources(ctx.orgId);
    const secrets = await core.discovery.connectorSecrets(ctx.orgId);
    const rows = await core.db.many(`SELECT id, connector, name, enabled, config - 'rows' AS config, last_run_at, last_status, last_error, documents_fetched, quality_score, (config ? 'rows') AS has_dataset FROM sources WHERE org_id = $1 ORDER BY connector, name`, [ctx.orgId]);
    return { connectors: listConnectors(secrets), sources: rows };
  });

  authed('POST', '/api/sources', 'settings:write', async (req, reply, ctx) => {
    const input = parse(sourceConfigSchema, req.body);
    const row = await core.db.one(
      `INSERT INTO sources (id, org_id, connector, name, enabled, config) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, connector, name) DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = now() RETURNING id`,
      [newId('source'), ctx.orgId, input.connector, input.name, input.enabled, JSON.stringify(input.config)],
    );
    await core.orgs.markOnboarding(ctx.orgId, 'configure_sources');
    await core.audit.record({ orgId: ctx.orgId, actor: ctx.actor, action: 'source.upsert', targetType: 'source', targetId: row!.id, details: { connector: input.connector, enabled: input.enabled } });
    reply.status(201);
    return row;
  });

  authed('PATCH', '/api/sources/:id', 'settings:write', async (req, _reply, ctx) => {
    const body = parse(z.object({ enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() }), req.body);
    await core.db.query(`UPDATE sources SET enabled = COALESCE($3, enabled), config = COALESCE($4, config), updated_at = now() WHERE id = $1 AND org_id = $2`, [
      (req.params as IdParams).id,
      ctx.orgId,
      body.enabled ?? null,
      body.config ? JSON.stringify(body.config) : null,
    ]);
    await core.orgs.markOnboarding(ctx.orgId, 'configure_sources');
    return { ok: true };
  });

  /** Upload a user-provided dataset (CSV with title,text,url,date,points) as a searchable source. */
  authed('POST', '/api/sources/dataset', 'settings:write', async (req, reply, ctx) => {
    const body = parse(z.object({ name: z.string().min(1).max(100), csv: z.string().max(3_000_000) }), req.body);
    const rows = parseCsv(body.csv, { maxRows: 5000 }).filter((r) => r.title || r.text);
    await core.db.query(
      `INSERT INTO sources (id, org_id, connector, name, config) VALUES ($1,$2,'user_dataset',$3,$4)
       ON CONFLICT (org_id, connector, name) DO UPDATE SET config = EXCLUDED.config, enabled = true, updated_at = now()`,
      [newId('source'), ctx.orgId, body.name, JSON.stringify({ rows, uploadedAt: new Date().toISOString() })],
    );
    await core.audit.record({ orgId: ctx.orgId, actor: ctx.actor, action: 'source.dataset_upload', details: { name: body.name, rows: rows.length } });
    reply.status(201);
    return { name: body.name, rows: rows.length, dataKind: 'USER_INPUT' };
  });
}
