import type { FastifyInstance } from 'fastify';
import { expenseCreateSchema, portfolioAllocateSchema, revenueManualSchema, roadmapAssumptionsSchema, z } from '@roos/shared';
import { parse, type ApiDeps } from '../context';
import type { Authed } from '../server';

export function registerFinanceRoutes(_app: FastifyInstance, deps: ApiDeps, authed: Authed) {
  const { core } = deps;

  authed('GET', '/api/revenue', 'revenue:read', async (_req, _reply, ctx) => core.revenue.summary(ctx.orgId));
  authed('GET', '/api/revenue/events', 'revenue:read', async (_req, _reply, ctx) => core.revenue.listEvents(ctx.orgId));
  authed('POST', '/api/revenue/events', 'revenue:write', async (req, reply, ctx) => {
    reply.status(201);
    return core.revenue.recordManual(ctx.orgId, parse(revenueManualSchema, req.body), ctx.actor);
  });
  authed('POST', '/api/revenue/stripe/sync', 'revenue:write', async (_req, _reply, ctx) => core.revenue.syncStripe(ctx.orgId, ctx.actor));
  authed('GET', '/api/revenue/cashflow', 'revenue:read', async (req, _reply, ctx) => {
    const q = parse(z.object({ cashOnHandUsd: z.coerce.number().min(0).optional(), months: z.coerce.number().int().min(1).max(60).optional() }), req.query);
    return core.revenue.cashflow(ctx.orgId, q);
  });
  authed('GET', '/api/expenses', 'revenue:read', async (_req, _reply, ctx) => core.revenue.listExpenses(ctx.orgId));
  authed('POST', '/api/expenses', 'revenue:write', async (req, reply, ctx) => {
    reply.status(201);
    return core.revenue.recordExpense(ctx.orgId, parse(expenseCreateSchema, req.body), ctx.actor);
  });

  authed('GET', '/api/portfolio', 'revenue:read', async (_req, _reply, ctx) => core.portfolio.kpis(ctx.orgId));
  authed('POST', '/api/portfolio/allocate', 'revenue:read', async (req, _reply, ctx) => core.portfolio.allocate(ctx.orgId, parse(portfolioAllocateSchema, req.body)));

  authed('GET', '/api/roadmap', 'revenue:read', async (_req, _reply, ctx) => core.portfolio.roadmap(ctx.orgId));
  /** Preview with ad-hoc assumptions (not saved). */
  authed('POST', '/api/roadmap/preview', 'revenue:read', async (req, _reply, ctx) => core.portfolio.roadmap(ctx.orgId, parse(roadmapAssumptionsSchema, req.body)));
  authed('PUT', '/api/roadmap/assumptions', 'org:write', async (req, _reply, ctx) => core.portfolio.saveRoadmapAssumptions(ctx.orgId, parse(roadmapAssumptionsSchema, req.body)));

  authed('GET', '/api/ledger', 'revenue:read', async (_req, _reply, ctx) => ({ balances: await core.ledger.balances(ctx.orgId), entries: await core.ledger.list(ctx.orgId), note: 'Paper (simulated) ledger — no real money moves through ROOS.' }));
}
