import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CommandCenter, Orchestrator } from '@roos/agents';
import type { Actor, Core, Principal } from '@roos/core';
import { can, MemoryRateLimiter, RedisRateLimiter, safeEqual, type Permission, type RateLimiter, type RedisLike } from '@roos/security';
import { ForbiddenError, RateLimitError, UnauthorizedError, ValidationError, type Role, type z } from '@roos/shared';
import type { ErrorReporter, Metrics } from './observability';

export const SESSION_COOKIE = 'roos_session';
export const CSRF_COOKIE = 'roos_csrf';

export interface ApiDeps {
  core: Core;
  orchestrator: Orchestrator;
  commands: CommandCenter;
  limiter: RateLimiter;
  metrics: Metrics;
  errors: ErrorReporter;
}

export interface AuthContext {
  principal: Principal;
  sessionId?: string;
  csrfToken?: string;
  via: 'session' | 'api_key';
}

export interface OrgContext {
  orgId: string;
  role: Role;
  actor: Actor;
  principal: Principal;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    rawBody?: string;
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw new ValidationError(
      'Invalid request',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export function clientIp(req: FastifyRequest): string {
  return req.ip ?? 'unknown';
}

export async function rateLimit(deps: ApiDeps, reply: FastifyReply, key: string, limit: number, windowMs = 60_000) {
  const r = await deps.limiter.hit(key, limit, windowMs);
  reply.header('x-ratelimit-limit', String(r.limit));
  reply.header('x-ratelimit-remaining', String(r.remaining));
  if (!r.allowed) {
    const retry = Math.ceil(r.resetMs / 1000);
    reply.header('retry-after', String(retry));
    throw new RateLimitError(retry);
  }
}

/** Resolve the caller from an API key (Authorization: Bearer roos_…) or the session cookie. */
export async function authenticate(deps: ApiDeps, req: FastifyRequest): Promise<AuthContext | null> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const p = await deps.core.auth.validateApiKey(header.slice(7).trim());
    if (!p) throw new UnauthorizedError('Invalid API key');
    return { principal: p, via: 'api_key' };
  }
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const s = await deps.core.auth.validateSession(token);
  return s ? { principal: s.principal, sessionId: s.sessionId, csrfToken: s.csrfToken, via: 'session' } : null;
}

/** CSRF: cookie-authenticated, state-changing requests must echo the session's CSRF token. */
export function checkCsrf(req: FastifyRequest) {
  if (!req.auth || req.auth.via !== 'session') return;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const sent = String(req.headers['x-csrf-token'] ?? '');
  if (!sent || !req.auth.csrfToken || !safeEqual(sent, req.auth.csrfToken)) throw new ForbiddenError('Missing or invalid CSRF token');
}

/**
 * Resolve organisation + role and enforce a permission. The org comes from the `x-org-id` header
 * (validated against memberships); API keys are pinned to their own org.
 */
export async function requireOrg(deps: ApiDeps, req: FastifyRequest, permission: Permission): Promise<OrgContext> {
  if (!req.auth) throw new UnauthorizedError();
  const p = req.auth.principal;
  let orgId = (req.headers['x-org-id'] as string | undefined)?.trim() || p.scope?.orgId;
  if (!orgId) {
    const ms = await deps.core.auth.memberships(p.userId);
    orgId = (ms.find((m) => !m.isDemo) ?? ms[0])?.orgId;
  }
  if (!orgId) throw new ForbiddenError('No workspace membership');
  const role = await deps.core.auth.resolveRole(p, orgId);
  if (!role) throw new ForbiddenError('Not a member of this workspace');
  if (!can(role, permission)) throw new ForbiddenError(`Your role (${role}) lacks permission "${permission}"`);
  const actor: Actor = p.kind === 'api_key' ? { type: 'api_key', id: p.apiKeyId!, ip: clientIp(req) } : { type: 'user', id: p.userId, ip: clientIp(req) };
  return { orgId, role, actor, principal: p };
}

/** Shared (Redis) limiter across API replicas when Redis is configured; per-process otherwise. */
export function newLimiter(redis?: RedisLike): RateLimiter {
  return redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter();
}
