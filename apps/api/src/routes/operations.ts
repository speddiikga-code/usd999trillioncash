import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  campaignCreateSchema,
  ConflictError,
  experimentCreateSchema,
  ForbiddenError,
  leadCreateSchema,
  leadImportSchema,
  leadUpdateSchema,
  newId,
  NotFoundError,
  z,
} from '@roos/shared';
import { parse, type ApiDeps } from '../context';
import type { Authed } from '../server';

type IdParams = { id: string };

export function registerOperationsRoutes(_app: FastifyInstance, deps: ApiDeps, authed: Authed) {
  const { core, orchestrator } = deps;

  // ───────────── Experiments ─────────────
  authed('GET', '/api/experiments', 'experiment:read', async (req, _reply, ctx) => core.experiments.list(ctx.orgId, (req.query as { status?: string }).status));
  authed('POST', '/api/experiments', 'experiment:write', async (req, reply, ctx) => {
    reply.status(201);
    return core.experiments.create(ctx.orgId, parse(experimentCreateSchema, req.body), ctx.actor);
  });
  authed('GET', '/api/experiments/:id', 'experiment:read', async (req, _reply, ctx) => {
    const id = (req.params as IdParams).id;
    const [stats, evaluations] = await Promise.all([core.experiments.funnelStats(ctx.orgId, id), core.experiments.evaluations(ctx.orgId, id)]);
    const product = stats.experiment.productId ? await core.products.getProduct(ctx.orgId, stats.experiment.productId) : null;
    return { ...stats, evaluations, product: product ? { id: product.id, name: product.name, url: product.url, writeKey: product.writeKey, status: product.status } : null };
  });
  authed('POST', '/api/experiments/:id/start', 'experiment:write', async (req, _reply, ctx) => core.experiments.start(ctx.orgId, (req.params as IdParams).id, ctx.actor));
  authed('POST', '/api/experiments/:id/evaluate', 'experiment:write', async (req, _reply, ctx) => core.experiments.evaluate(ctx.orgId, (req.params as IdParams).id, ctx.actor));
  authed('POST', '/api/experiments/:id/stop', 'experiment:write', async (req, _reply, ctx) => {
    await core.experiments.stop(ctx.orgId, (req.params as IdParams).id, ctx.actor);
    return { ok: true };
  });
  authed('POST', '/api/experiments/:id/spend', 'revenue:write', async (req, _reply, ctx) => {
    const body = parse(z.object({ amountUsd: z.number().positive().max(1_000_000), description: z.string().min(1).max(300) }), req.body);
    return core.experiments.recordSpend(ctx.orgId, (req.params as IdParams).id, body.amountUsd, body.description, ctx.actor);
  });

  // ───────────── Products, projects, deployments ─────────────
  authed('GET', '/api/products', 'opportunity:read', async (_req, _reply, ctx) => core.products.listProducts(ctx.orgId));
  authed('POST', '/api/products', 'opportunity:write', async (req, reply, ctx) => {
    const body = parse(z.object({ name: z.string().min(1).max(120), opportunityId: z.string().max(64).optional(), description: z.string().max(1000).optional() }), req.body);
    reply.status(201);
    return core.products.createProduct(ctx.orgId, body);
  });
  authed('GET', '/api/products/:id', 'opportunity:read', async (req, _reply, ctx) => {
    const p = await core.products.getProduct(ctx.orgId, (req.params as IdParams).id);
    return { ...p, funnel30d: await core.tracking.productSummary(ctx.orgId, p.id as string), trackUrl: `${core.cfg.api.publicUrl}/api/track` };
  });
  authed('GET', '/api/projects', 'opportunity:read', async (_req, _reply, ctx) => core.products.listProjects(ctx.orgId));
  authed('GET', '/api/projects/:id', 'opportunity:read', async (req, _reply, ctx) => {
    const p = await core.products.getProject(ctx.orgId, (req.params as IdParams).id);
    const runs = await core.db.many('SELECT id, driver, status, exit_code, duration_ms, stdout, stderr, limits, created_at FROM sandbox_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 5', [p.id]);
    return { ...p, sandboxRuns: runs };
  });
  /** Read one generated file (path-guarded, size-capped) for the code viewer. */
  authed('GET', '/api/projects/:id/file', 'opportunity:read', async (req, _reply, ctx) => {
    const p = await core.products.getProject(ctx.orgId, (req.params as IdParams).id);
    const rel = String((req.query as { path?: string }).path ?? '');
    const manifest = p.manifest as { path: string }[];
    if (!manifest.some((m) => m.path === rel)) throw new NotFoundError('File', rel);
    const root = path.resolve(p.path as string);
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) throw new ForbiddenError('Path outside project');
    if (statSync(target).size > 512 * 1024) throw new ConflictError('File too large to preview');
    return { path: rel, content: readFileSync(target, 'utf8') };
  });
  authed('POST', '/api/projects/:id/deploy', 'deploy:run', async (req, _reply, ctx) => {
    const body = parse(z.object({ experimentId: z.string().max(64).optional() }), req.body);
    return core.products.deployLocal(ctx.orgId, (req.params as IdParams).id, ctx.actor, body);
  });
  authed('POST', '/api/projects/:id/production', 'deploy:run', async (req, reply, ctx) => {
    const project = await core.products.getProject(ctx.orgId, (req.params as IdParams).id);
    const t = await orchestrator.enqueue(ctx.orgId, { agent: 'CodeAgent', kind: 'code.request_production', input: { projectId: project.id }, createdBy: ctx.actor.id, workflowId: newId('workflow') });
    reply.status(202);
    return { taskId: t.id, note: 'Production deployment requested — approve it in the approval center.' };
  });
  authed('GET', '/api/deployments', 'opportunity:read', async (_req, _reply, ctx) => core.products.listDeployments(ctx.orgId));
  authed('POST', '/api/deployments/:id/stop', 'deploy:run', async (req, _reply, ctx) => {
    await core.products.stopDeployment(ctx.orgId, (req.params as IdParams).id, ctx.actor);
    return { ok: true };
  });

  // ───────────── Leads / CRM ─────────────
  authed('GET', '/api/leads', 'lead:read', async (req, _reply, ctx) => {
    const q = req.query as { status?: string; minScore?: string; q?: string };
    return core.leads.list(ctx.orgId, { status: q.status as never, minScore: q.minScore ? Number(q.minScore) : undefined, q: q.q });
  });
  authed('POST', '/api/leads', 'lead:write', async (req, reply, ctx) => {
    reply.status(201);
    return core.leads.create(ctx.orgId, parse(leadCreateSchema, req.body), ctx.actor);
  });
  authed('PATCH', '/api/leads/:id', 'lead:write', async (req, _reply, ctx) => core.leads.update(ctx.orgId, (req.params as IdParams).id, parse(leadUpdateSchema, req.body), ctx.actor));
  authed('POST', '/api/leads/import', 'lead:write', async (req, _reply, ctx) => core.leads.importCsv(ctx.orgId, parse(leadImportSchema, req.body), ctx.actor));
  authed('GET', '/api/pipeline', 'lead:read', async (_req, _reply, ctx) => core.leads.pipeline(ctx.orgId));
  /** Exporting personal data is the `data.sensitive` action (approval by default). */
  authed('GET', '/api/leads/export', 'lead:export', async (req, reply, ctx) => {
    const approvalId = (req.query as { approvalId?: string }).approvalId;
    const decision = await core.policy.evaluate(ctx.orgId, 'data.sensitive');
    let allowed = decision.decision === 'allow';
    if (!allowed && approvalId) {
      const a = await core.approvals.get(ctx.orgId, approvalId);
      allowed = a.actionType === 'data.sensitive' && a.status === 'executed' && a.requestedBy === ctx.actor.id && Date.now() - new Date(a.decidedAt ?? 0).getTime() < 3_600_000;
    }
    if (!allowed) {
      const a = await core.approvals.request(ctx.orgId, {
        actionType: 'data.sensitive',
        title: 'Export all leads (personal data) as CSV',
        what: 'Download names, emails, companies and consent basis of all leads.',
        why: 'Requested by an operator.',
        expectedBenefit: 'Use the data in an external tool.',
        expectedCostUsd: 0,
        risk: { level: 'high', description: 'Personal data leaves the system; the recipient becomes responsible for GDPR/CCPA compliance.' },
        dataSources: [{ name: 'ROOS CRM' }],
        reversibility: 'irreversible',
        payload: { scope: 'lead_export', requestedAt: new Date().toISOString().slice(0, 13) },
        requestedBy: ctx.actor.id,
      });
      reply.status(202);
      return { approvalRequired: true, approvalId: a.id };
    }
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="leads.csv"');
    return core.leads.exportCsv(ctx.orgId, ctx.actor);
  });

  // ───────────── Campaigns ─────────────
  authed('GET', '/api/campaigns', 'lead:read', async (_req, _reply, ctx) => core.campaigns.list(ctx.orgId));
  authed('POST', '/api/campaigns', 'campaign:write', async (req, reply, ctx) => {
    reply.status(201);
    return core.campaigns.create(ctx.orgId, parse(campaignCreateSchema, req.body), ctx.actor);
  });
  authed('GET', '/api/campaigns/:id', 'lead:read', async (req, _reply, ctx) => core.campaigns.get(ctx.orgId, (req.params as IdParams).id));
  authed('POST', '/api/campaigns/:id/send', 'campaign:write', async (req, _reply, ctx) => core.campaigns.requestSend(ctx.orgId, (req.params as IdParams).id, ctx.actor));
}
