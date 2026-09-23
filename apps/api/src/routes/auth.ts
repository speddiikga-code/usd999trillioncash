import type { FastifyInstance, FastifyReply } from 'fastify';
import { seedDemo } from '@roos/core';
import { apiKeyCreateSchema, loginSchema, memberInviteSchema, onboardingStepSchema, orgSettingsSchema, registerSchema, UnauthorizedError, type OnboardingStep } from '@roos/shared';
import { clientIp, CSRF_COOKIE, parse, rateLimit, SESSION_COOKIE, type ApiDeps } from '../context';
import type { Authed } from '../server';

export function registerAuthRoutes(app: FastifyInstance, deps: ApiDeps, authed: Authed) {
  const { core } = deps;
  const cfg = core.cfg;

  const setSessionCookies = (reply: FastifyReply, token: string, csrf: string, expiresAt: string) => {
    const base = { path: '/', secure: cfg.auth.cookieSecure, sameSite: 'lax' as const, expires: new Date(expiresAt) };
    reply.setCookie(SESSION_COOKIE, token, { ...base, httpOnly: true });
    reply.setCookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false });
  };

  const me = async (userId: string) => {
    const user = await core.db.one<{ id: string; email: string; name: string }>('SELECT id, email, name FROM users WHERE id = $1', [userId]);
    return { user, memberships: await core.auth.memberships(userId) };
  };

  /** First-run: does the system have any users yet, and may this visitor register? */
  app.get('/api/auth/state', async (req) => {
    const users = await core.auth.userCount();
    return {
      hasUsers: users > 0,
      allowRegistration: users === 0 || cfg.auth.allowRegistration,
      demoGuestLogin: cfg.auth.demoGuestLogin,
      authenticated: !!req.auth,
      ...(req.auth ? { ...(await me(req.auth.principal.userId)), csrfToken: req.auth.csrfToken, via: req.auth.via } : {}),
    };
  });

  app.post('/api/auth/register', async (req, reply) => {
    await rateLimit(deps, reply, `auth:${clientIp(req)}`, cfg.api.authRateLimitPerMin);
    const input = parse(registerSchema, req.body);
    const r = await core.auth.register(input, clientIp(req));
    const s = await core.auth.createSession(r.userId, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    setSessionCookies(reply, s.token, s.csrfToken, s.expiresAt);
    return reply.status(201).send({ ...(await me(r.userId)), orgId: r.org.id, csrfToken: s.csrfToken });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const input = parse(loginSchema, req.body);
    await rateLimit(deps, reply, `auth:${clientIp(req)}`, cfg.api.authRateLimitPerMin);
    await rateLimit(deps, reply, `login:${input.email}`, cfg.api.authRateLimitPerMin);
    const s = await core.auth.login(input.email, input.password, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    setSessionCookies(reply, s.token, s.csrfToken, s.expiresAt);
    return { ...(await me(s.user.id)), csrfToken: s.csrfToken };
  });

  /** Read-only guest session on the synthetic demo workspace (DEMO_GUEST_LOGIN; off in production). */
  app.post('/api/auth/demo', async (req, reply) => {
    await rateLimit(deps, reply, `auth:${clientIp(req)}`, cfg.api.authRateLimitPerMin);
    const s = await core.auth.demoGuestSession({ ip: clientIp(req), userAgent: req.headers['user-agent'] });
    setSessionCookies(reply, s.token, s.csrfToken, s.expiresAt);
    return { ...(await me(s.userId)), orgId: s.orgId, csrfToken: s.csrfToken };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await core.auth.logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).clearCookie(CSRF_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.auth) throw new UnauthorizedError();
    return me(req.auth.principal.userId);
  });

  authed('GET', '/api/api-keys', 'settings:read', async (_req, _reply, ctx) => core.auth.listApiKeys(ctx.orgId));
  authed('POST', '/api/api-keys', 'settings:write', async (req, reply, ctx) => {
    const input = parse(apiKeyCreateSchema, req.body);
    reply.status(201);
    return core.auth.createApiKey(ctx.orgId, ctx.principal.userId, input.name, input.role);
  });
  authed('DELETE', '/api/api-keys/:id', 'settings:write', async (req, _reply, ctx) => {
    await core.auth.revokeApiKey(ctx.orgId, (req.params as { id: string }).id, ctx.principal.userId);
    return { ok: true };
  });

  authed('GET', '/api/members', 'org:read', async (_req, _reply, ctx) => core.auth.listMembers(ctx.orgId));
  authed('POST', '/api/members', 'members:manage', async (req, reply, ctx) => {
    reply.status(201);
    return core.auth.addMember(ctx.orgId, ctx.principal.userId, parse(memberInviteSchema, req.body));
  });

  // Organisation & first-run onboarding
  authed('GET', '/api/org', 'org:read', async (_req, _reply, ctx) => {
    const org = await core.orgs.get(ctx.orgId);
    return { ...org, role: ctx.role, onboarding: core.orgs.onboardingState(org) };
  });
  authed('PATCH', '/api/org', 'org:write', async (req, _reply, ctx) => {
    const input = parse(orgSettingsSchema, req.body);
    let org = await core.orgs.updateSettings(ctx.orgId, input);
    if (input.constraints) org = await core.orgs.markOnboarding(ctx.orgId, 'constraints');
    if (input.industries) org = await core.orgs.markOnboarding(ctx.orgId, 'industries');
    await core.audit.record({ orgId: ctx.orgId, actor: ctx.actor, action: 'org.update', details: input });
    return { ...org, onboarding: core.orgs.onboardingState(org) };
  });
  authed('POST', '/api/onboarding/step', 'org:write', async (req, _reply, ctx) => {
    const input = parse(onboardingStepSchema, req.body);
    const org = await core.orgs.markOnboarding(ctx.orgId, input.step as OnboardingStep, input.done);
    return core.orgs.onboardingState(org);
  });
  authed('POST', '/api/demo/seed', 'settings:write', async (req, _reply, ctx) => {
    const reset = !!(req.body as { reset?: boolean } | undefined)?.reset;
    const r = await seedDemo(core, { reset });
    await core.audit.record({ orgId: ctx.orgId, actor: ctx.actor, action: 'demo.seed', details: { reset, demoOrgId: r.orgId } });
    return r;
  });
}
