import type { FastifyInstance, FastifyReply } from 'fastify';
import { escapeHtml } from '@roos/security';
import { trackEventSchema, UnauthorizedError } from '@roos/shared';
import { clientIp, parse, rateLimit, type ApiDeps } from '../context';

/**
 * Unauthenticated endpoints, each with its own authentication mechanism:
 *  - POST /api/track                    product write key (public, CORS-enabled, rate-limited)
 *  - GET  /api/public/unsubscribe       HMAC token bound to org + email
 *  - POST /api/webhooks/stripe/:org     Stripe-Signature (HMAC-SHA256 over the raw body)
 */
export function registerPublicRoutes(app: FastifyInstance, deps: ApiDeps) {
  const { core } = deps;
  const cors = (reply: FastifyReply) =>
    reply
      .header('access-control-allow-origin', '*')
      .header('access-control-allow-methods', 'POST, OPTIONS')
      .header('access-control-allow-headers', 'content-type, x-roos-write-key')
      .header('access-control-max-age', '600')
      .header('cross-origin-resource-policy', 'cross-origin');

  app.options('/api/track', async (_req, reply) => cors(reply).status(204).send());

  app.post('/api/track', async (req, reply) => {
    cors(reply);
    const key = String(req.headers['x-roos-write-key'] ?? '');
    if (!/^pk_[A-Za-z0-9_-]{10,}$/.test(key)) throw new UnauthorizedError('Missing or invalid x-roos-write-key');
    await rateLimit(deps, reply, `track:${clientIp(req)}`, core.cfg.api.trackRateLimitPerMin);
    await rateLimit(deps, reply, `trackkey:${key}`, core.cfg.api.trackRateLimitPerMin * 10);
    const input = parse(trackEventSchema, req.body);
    const r = await core.tracking.ingest(key, input, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    reply.status(202);
    return { ok: true, id: r.id };
  });

  app.get('/api/public/unsubscribe', async (req, reply) => {
    const q = req.query as { o?: string; e?: string; t?: string };
    const ok = q.o && q.e && q.t ? await core.campaigns.unsubscribe(q.o, q.e, q.t) : false;
    reply.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    return `<!doctype html><meta charset="utf-8"><title>Unsubscribe</title><body style="font-family:system-ui;max-width:520px;margin:64px auto;padding:0 16px">
      <h1>${ok ? 'You are unsubscribed' : 'Link not valid'}</h1>
      <p>${ok ? `${escapeHtml(q.e)} will not receive further messages.` : 'This unsubscribe link is invalid or incomplete. Reply "unsubscribe" to any message instead.'}</p></body>`;
  });

  app.post('/api/webhooks/stripe/:orgSlug', async (req) => {
    const raw = req.rawBody ?? JSON.stringify(req.body ?? {});
    return core.revenue.handleStripeWebhook((req.params as { orgSlug: string }).orgSlug, raw, req.headers['stripe-signature'] as string | undefined);
  });
}
