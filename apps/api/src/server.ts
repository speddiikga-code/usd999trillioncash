import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Permission } from '@roos/security';
import { isAppError, RateLimitError } from '@roos/shared';
import { authenticate, checkCsrf, rateLimit, requireOrg, type ApiDeps, type OrgContext } from './context';
import { registerAuthRoutes } from './routes/auth';
import { registerFinanceRoutes } from './routes/finance';
import { registerOperationsRoutes } from './routes/operations';
import { registerOpportunityRoutes } from './routes/opportunities';
import { registerPublicRoutes } from './routes/public';
import { registerSystemRoutes } from './routes/system';

export type Authed = <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, permission: Permission, handler: (req: FastifyRequest, reply: FastifyReply, ctx: OrgContext) => Promise<T>) => void;

const PUBLIC_PREFIXES = ['/api/track', '/api/webhooks/', '/api/public/', '/api/health'];

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const cfg = deps.core.cfg;
  const app = Fastify({
    logger: false,
    trustProxy: cfg.api.trustProxy,
    bodyLimit: cfg.api.bodyLimitBytes,
    routerOptions: { ignoreTrailingSlash: true },
  });
  await app.register(cookie);

  // Keep the raw body (Stripe signature verification) while parsing JSON ourselves.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    (req as FastifyRequest).rawBody = raw;
    if (!raw.trim()) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      const e = new Error('Invalid JSON body') as Error & { statusCode: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    (req as FastifyRequest & { startedAt: number }).startedAt = performance.now();
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (cfg.auth.cookieSecure) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    const url = req.url.split('?')[0]!;
    if (url !== '/api/health' && url !== '/api/metrics' && !url.startsWith('/api/events/stream')) {
      await rateLimit(deps, reply, `ip:${req.ip}`, cfg.api.rateLimitPerMin);
    }
    if (!PUBLIC_PREFIXES.some((p) => url.startsWith(p))) {
      const auth = await authenticate(deps, req);
      if (auth) req.auth = auth;
    }
  });

  app.addHook('preHandler', async (req) => {
    checkCsrf(req);
  });

  app.addHook('onResponse', async (req, reply) => {
    const started = (req as FastifyRequest & { startedAt?: number }).startedAt ?? performance.now();
    const route = req.routeOptions?.url ?? 'unmatched';
    deps.metrics.observe(req.method, route, reply.statusCode, performance.now() - started);
    if (reply.statusCode >= 500 || performance.now() - started > 2000) {
      deps.core.logger.warn('Slow or failed request', { method: req.method, route, status: reply.statusCode, ms: Math.round(performance.now() - started) });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (isAppError(err)) {
      if (err instanceof RateLimitError) reply.header('retry-after', String(err.retryAfterSec));
      if (err.status >= 500) deps.errors.capture(err, { route: req.routeOptions?.url, method: req.method });
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Bad request' } });
    }
    deps.errors.capture(err, { route: req.routeOptions?.url, method: req.method });
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.url.split('?')[0]}` } }));

  const authed: Authed = (method, url, permission, handler) => {
    app.route({
      method,
      url,
      handler: async (req, reply) => {
        const ctx = await requireOrg(deps, req, permission);
        const out = await handler(req, reply, ctx);
        return out === undefined ? reply.send() : out;
      },
    });
  };

  registerPublicRoutes(app, deps);
  registerAuthRoutes(app, deps, authed);
  registerOpportunityRoutes(app, deps, authed);
  registerOperationsRoutes(app, deps, authed);
  registerFinanceRoutes(app, deps, authed);
  registerSystemRoutes(app, deps, authed);
  return app;
}
