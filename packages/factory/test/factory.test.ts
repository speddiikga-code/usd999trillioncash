import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scanSources } from '@roos/security';
import type { BusinessHypothesis } from '@roos/shared';
import { buildSpec, generateProject, LocalDeployer, normalizeEntities, ProcessSandbox, writeProject } from '../src';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'roos-factory-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const hypothesis = {
  id: 'hyp_test',
  opportunityId: 'opp_test',
  model: 'b2b_saas',
  title: 'Invoice desk',
  targetCustomer: 'Accountants <script>alert(1)</script>',
  valueProposition: 'Stop reconciling invoices by hand "today" & save hours',
  mvpSpec: {
    name: 'Invoice<Desk>',
    tagline: 'Reconcile </script><script>alert("x")</script> faster',
    coreFeatures: ['Track invoices', 'Status workflow', '<img src=x onerror=alert(1)>'],
    entities: [
      { name: 'Invoice', fields: [{ name: 'title', type: 'string', required: true }, { name: 'amount', type: 'number' }, { name: 'dueDate', type: 'date' }, { name: 'owner', type: 'email' }, { name: 'paid', type: 'boolean' }, { name: 'link', type: 'url' }, { name: 'notes', type: 'text' }] },
      { name: 'Client', fields: [{ name: 'name', type: 'string' }, { name: 'email', type: 'email' }] },
    ],
  },
  pricing: { tiers: [{ name: 'Pro', priceUsdMonthly: 49, features: ['Unlimited'] }], metric: 'per month', kind: 'MODEL_ASSUMPTION' },
  experimentPlan: [{ step: 'Landing', metric: 'visitor → signup', threshold: '≥ 5%' }],
} as unknown as BusinessHypothesis;

const opp = { id: 'opp_test', title: 'Invoice reconciliation', problem: 'Accountants reconcile invoices manually in spreadsheets.', customer: 'Accountants' };

describe('MVP factory', () => {
  const spec = buildSpec(opp, hypothesis, { variants: ['a', 'b'], headlines: { a: 'Headline A', b: 'Headline <b>B</b>' } });
  const files = generateProject(spec);
  const dir = path.join(tmp, 'invoice-desk');
  const manifest = writeProject(dir, files);

  it('normalises entities into safe identifiers and unique routes', () => {
    const e = normalizeEntities([{ name: 'Sign-up!', fields: [{ name: 'id', type: 'string' }, { name: 'x-y', type: 'string' }] }, { name: 'Company', fields: [{ name: 'name', type: 'string' }] }]);
    expect(e[0]!.name).toBe('Signup');
    expect(e[0]!.plural).toBe('signups-1');
    expect(e[0]!.fields.map((f) => f.name)).toEqual(['xy']);
    expect(e[0]!.fields[0]!.required).toBe(true);
    expect(e[1]!.plural).toBe('companies');
  });

  it('generates a complete, runnable project', () => {
    for (const f of ['package.json', 'server.js', 'lib/spec.js', 'public/index.html', 'schema.sql', 'openapi.json', 'test/server.test.js', 'Dockerfile', 'docker-compose.yml', 'README.md', 'SPEC.md', 'roos.json']) {
      expect(existsSync(path.join(dir, f)), f).toBe(true);
    }
    expect(manifest.every((m) => m.sha256.length === 64)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies).toBeUndefined();
    const oas = JSON.parse(readFileSync(path.join(dir, 'openapi.json'), 'utf8'));
    expect(Object.keys(oas.paths)).toEqual(expect.arrayContaining(['/api/invoices', '/api/invoices/{id}', '/api/clients']));
    expect(readFileSync(path.join(dir, 'schema.sql'), 'utf8')).toMatch(/CREATE TABLE "invoices"[\s\S]*"due_date" date/);
  });

  it('escapes all generated content in HTML (XSS)', () => {
    const html = readFileSync(path.join(dir, 'public/index.html'), 'utf8');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src&#61;x onerror&#61;alert(1)&gt;');
    expect(html).toContain('Invoice&lt;Desk&gt;');
  });

  it('passes the static security scan with no dependencies', () => {
    const scan = scanSources(files, { dependencyAllowlist: [] });
    expect(scan.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(scan.passed).toBe(true);
  });

  it('refuses to write outside the project directory', () => {
    expect(() => writeProject(path.join(tmp, 'x'), [{ path: '../escape.txt', content: 'x' }])).toThrow(/outside/);
  });

  it('runs its own test-suite inside the process sandbox', async () => {
    const r = await new ProcessSandbox().runTests(dir, { timeoutMs: 60_000, memoryMb: 256, cpus: 1, network: 'none' });
    if (r.status !== 'passed') console.error(r.stdout, r.stderr);
    expect(r.status).toBe('passed');
    expect(r.stdout).toMatch(/pass \d+/);
    expect(r.stdout).toMatch(/fail 0/);
    expect(r.isolation).toContain('node --permission');
  });

  it('deploys a local preview that serves the landing page and API', async () => {
    const deployer = new LocalDeployer({ portStart: 5190, portEnd: 5199 });
    const dep = await deployer.start('dep_test', dir, path.join(tmp, 'data'), {});
    try {
      const health = (await (await fetch(`${dep.url}/health`)).json()) as { ok: boolean };
      expect(health.ok).toBe(true);
      const page = await (await fetch(dep.url)).text();
      expect(page).toContain('"variants":["a","b"]');
      expect(page).toContain('Headline \\u003cb\\u003eB');
      const signup = await fetch(`${dep.url}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com' }) });
      expect(signup.status).toBe(201);
    } finally {
      await deployer.stop('dep_test');
    }
    expect(deployer.isRunning('dep_test')).toBe(false);
  });
});
