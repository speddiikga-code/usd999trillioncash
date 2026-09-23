import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { signStripePayload } from '@roos/billing';
import { clearConnectorCache } from '@roos/connectors';
import { createTestCore, fixtureFetcher, type Core } from '@roos/core';
import { createApi } from '../src/app';
import { DISCOVERY_ROUTES } from '../../../packages/core/test/fixtures';

let core: Core;
let app: FastifyInstance;
let close: () => Promise<void>;
let cookie = '';
let csrf = '';
let orgId = '';

const cookiesFrom = (res: LightMyRequestResponse) =>
  (res.headers['set-cookie'] as string[] | string | undefined ?? [])
    .toString()
    .split(/,(?=\s*roos_)/)
    .map((c) => c.split(';')[0]!.trim())
    .join('; ');

const api = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, 'x-org-id': orgId, ...headers } });

beforeAll(async () => {
  clearConnectorCache();
  core = await createTestCore({ connectorFetch: fixtureFetcher(DISCOVERY_ROUTES), env: { STRIPE_WEBHOOK_SECRET: 'whsec_api', AUTH_RATE_LIMIT_PER_MIN: '8' } });
  const built = await createApi(core);
  app = built.app;
  close = built.close;
});
afterAll(async () => {
  await close?.();
  await core?.db.close();
});

describe('authentication & sessions', () => {
  it('reports first-run state, registers the first user and sets secure cookies', async () => {
    const state = await app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(state.json()).toMatchObject({ hasUsers: false, allowRegistration: true, authenticated: false });
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'Owner@Example.com', password: 'correct horse battery', name: 'Owner', orgName: 'Acme' }) });
    expect(res.statusCode).toBe(201);
    const setCookie = res.headers['set-cookie']!.toString();
    expect(setCookie).toMatch(/roos_session=[^;]+;.*HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    cookie = cookiesFrom(res);
    csrf = res.json().csrfToken;
    orgId = res.json().orgId;
    expect(res.json().user.email).toBe('owner@example.com');
    const me = await api('GET', '/api/auth/me');
    expect(me.json().memberships.some((m: { role: string }) => m.role === 'owner')).toBe(true);
  });

  it('requires a CSRF token for cookie-authenticated writes', async () => {
    const noToken = await api('POST', '/api/opportunities', { title: 'x', problem: 'p', customer: 'c', market: 'm' }, { 'x-csrf-token': '' });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json().error.message).toMatch(/CSRF/);
    const ok = await api('POST', '/api/opportunities', { title: 'Manual opp <script>alert(1)</script>', problem: 'A real problem', customer: 'SMBs', market: 'Tools' });
    expect(ok.statusCode).toBe(201);
    expect(ok.headers['content-type']).toMatch(/application\/json/);
  });

  it('rejects unauthenticated requests and bad credentials', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/opportunities' })).statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'owner@example.com', password: 'nope' }) });
    expect(bad.statusCode).toBe(401);
  });

  it('rate-limits authentication attempts', async () => {
    let last: LightMyRequestResponse | undefined;
    for (let i = 0; i < 10; i++) last = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '198.51.100.7', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'nobody@example.com', password: 'wrong password 1' }) });
    expect(last!.statusCode).toBe(429);
    expect(last!.headers['retry-after']).toBeDefined();
  });

  it('sets security headers and returns JSON 404s', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.json().status).toBe('ok');
    const nf = await api('GET', '/api/nope');
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe('NOT_FOUND');
  });
});

describe('authorization (RBAC)', () => {
  it('enforces roles for members and API keys', async () => {
    const add = await api('POST', '/api/members', { email: 'viewer@example.com', name: 'Viewer', role: 'viewer', password: 'viewer password 123' });
    expect(add.statusCode).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'viewer@example.com', password: 'viewer password 123' }) });
    const vCookie = cookiesFrom(login);
    const vCsrf = login.json().csrfToken;
    const read = await app.inject({ method: 'GET', url: '/api/opportunities', headers: { cookie: vCookie, 'x-org-id': orgId } });
    expect(read.statusCode).toBe(200);
    const write = await app.inject({ method: 'POST', url: '/api/opportunities', headers: { cookie: vCookie, 'x-csrf-token': vCsrf, 'x-org-id': orgId, 'content-type': 'application/json' }, payload: JSON.stringify({ title: 't', problem: 'p', customer: 'c', market: 'm' }) });
    expect(write.statusCode).toBe(403);
    // Cross-tenant: the viewer is not a member of another org
    const other = await core.orgs.create('Other tenant');
    const cross = await app.inject({ method: 'GET', url: '/api/opportunities', headers: { cookie: vCookie, 'x-org-id': other.id } });
    expect(cross.statusCode).toBe(403);

    const key = (await api('POST', '/api/api-keys', { name: 'analyst-bot', role: 'analyst' })).json();
    expect(key.key).toMatch(/^roos_/);
    const bearer = { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' };
    expect((await app.inject({ method: 'GET', url: '/api/opportunities', headers: bearer })).statusCode).toBe(200);
    const approve = await app.inject({ method: 'POST', url: '/api/approvals/apr_x/approve', headers: bearer, payload: '{}' });
    expect(approve.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/opportunities', headers: { authorization: 'Bearer roos_invalid' } })).statusCode).toBe(401);
  });
});

describe('input validation & injection resistance', () => {
  it('validates bodies and reports field errors', async () => {
    const r = await api('POST', '/api/experiments', { budgetUsd: -5, variants: ['bad variant!'] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(r.json().error.details)).toBe(true);
  });

  it('treats SQL-injection payloads as data', async () => {
    const r1 = await api('GET', `/api/opportunities?q=${encodeURIComponent("' OR 1=1; DROP TABLE opportunities; --")}`);
    expect(r1.statusCode).toBe(200);
    expect(r1.json().items).toEqual([]);
    const r2 = await api('GET', `/api/opportunities/${encodeURIComponent("x' OR '1'='1")}`);
    expect(r2.statusCode).toBe(404);
    expect((await api('GET', '/api/opportunities')).json().total).toBeGreaterThan(0);
  });

  it('rejects oversized and malformed bodies', async () => {
    const big = await api('POST', '/api/leads/import', { csv: 'x'.repeat(3 * 1024 * 1024), source: 'x' });
    expect(big.statusCode).toBe(413);
    const bad = await app.inject({ method: 'POST', url: '/api/commands', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, payload: '{not json' });
    expect(bad.statusCode).toBe(400);
  });

  it('blocks SSRF through operator-configured web sources', async () => {
    const ssrfCore = await createTestCore();
    const reg = await ssrfCore.auth.register({ email: 'a@example.com', password: 'correct horse battery', name: 'A', orgName: 'A' });
    await ssrfCore.db.query(`INSERT INTO sources (id, org_id, connector, name, config) VALUES ('src_ssrf', $1, 'web_page', 'meta', $2)`, [reg.org.id, JSON.stringify({ urls: ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:4000/api/health'] })]);
    const r = await ssrfCore.discovery.scan(reg.org.id, { query: 'x', sources: ['web_page'], limitPerSource: 5 }, { actor: { type: 'user', id: reg.userId } });
    expect(r.documentsStored).toBe(0);
    expect(r.runs[0]!.error).toMatch(/private|reserved|not allowed|internal/i);
    await ssrfCore.db.close();
  });
});

describe('research, approvals and commands', () => {
  it('runs discovery inline and returns scored opportunities', async () => {
    const r = await api('POST', '/api/opportunities/discover', { query: 'invoice reconciliation', sources: ['hackernews', 'stackexchange'], wait: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().opportunitiesCreated.length).toBeGreaterThan(0);
  });

  it('queues command workflows and answers /status', async () => {
    const research = await api('POST', '/api/commands', { command: '/research "invoice reconciliation"' });
    expect(research.statusCode).toBe(202);
    expect(research.json().workflowId).toMatch(/^wf_/);
    const status = await api('POST', '/api/commands', { command: '/status' });
    expect(status.json().message).toMatch(/System:/);
    const wf = await api('GET', `/api/workflows/${research.json().workflowId}`);
    expect(wf.json().tasks[0].status).toBe('queued');
  });

  it('decides approvals through the API', async () => {
    const opp = (await api('GET', '/api/opportunities')).json().items[0];
    const exp = await api('POST', '/api/experiments', { opportunityId: opp.id, budgetUsd: 75, funnel: 'landing_signup' });
    const started = await api('POST', `/api/experiments/${exp.json().id}/start`);
    expect(started.json().status).toBe('pending_approval');
    const list = await api('GET', '/api/approvals?status=pending');
    expect(list.json().some((a: { id: string }) => a.id === started.json().approvalId)).toBe(true);
    const approve = await api('POST', `/api/approvals/${started.json().approvalId}/approve`, { note: 'ok' });
    expect(approve.json().status).toBe('executed');
    expect((await api('GET', `/api/experiments/${exp.json().id}`)).json().experiment.status).toBe('running');
    const audit = await api('GET', '/api/audit?action=approval');
    expect(audit.json().length).toBeGreaterThan(0);
    expect((await api('GET', '/api/audit/verify')).json().valid).toBe(true);
  });
});

describe('public endpoints', () => {
  it('ingests tracking events with a write key and CORS', async () => {
    const product = (await api('POST', '/api/products', { name: 'External landing page' })).json();
    const pre = await app.inject({ method: 'OPTIONS', url: '/api/track' });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    const bad = await app.inject({ method: 'POST', url: '/api/track', headers: { 'content-type': 'application/json', 'x-roos-write-key': 'nope' }, payload: JSON.stringify({ event: 'page_view', anonymousId: 'a' }) });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/track', headers: { 'content-type': 'application/json', 'x-roos-write-key': product.writeKey }, payload: JSON.stringify({ event: 'signup', anonymousId: 'a1', email: 'lead@example.com' }) });
    expect(ok.statusCode).toBe(202);
    const leads = (await api('GET', '/api/leads')).json();
    expect(leads.find((l: { email: string }) => l.email === 'lead@example.com').consentBasis).toBe('inbound');
  });

  it('verifies Stripe webhook signatures', async () => {
    const org = (await api('GET', '/api/org')).json();
    const body = JSON.stringify({ id: 'evt_api', type: 'invoice.paid', created: Math.floor(Date.now() / 1000), data: { object: { id: 'in_api', amount_paid: 2500, currency: 'usd', customer: 'cus_api' } } });
    const forged = await app.inject({ method: 'POST', url: `/api/webhooks/stripe/${org.slug}`, headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' }, payload: body });
    expect(forged.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: `/api/webhooks/stripe/${org.slug}`, headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(body, 'whsec_api') }, payload: body });
    expect(ok.statusCode).toBe(200);
    expect((await api('GET', '/api/revenue')).json().verified.revenueTotal).toBe(25);
  });

  it('protects metrics', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/metrics' })).statusCode).toBe(403);
    const m = await api('GET', '/api/metrics');
    expect(m.statusCode).toBe(200);
    expect(m.body).toContain('roos_http_requests_total');
  });
});

describe('server-sent events', () => {
  it('streams organisation events to authenticated clients', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events/stream?after=${await core.events.latestId()}`, { headers: { cookie, 'x-org-id': orgId }, signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    await core.events.publish(orgId, 'alert', { payload: { title: 'sse-test' } });
    let text = '';
    const deadline = Date.now() + 5000;
    while (!text.includes('sse-test') && Date.now() < deadline) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    ctrl.abort();
    expect(text).toContain('event: alert');
    expect(text).toContain('sse-test');
  });
});
