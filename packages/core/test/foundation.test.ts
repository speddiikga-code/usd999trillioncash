import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@roos/shared';
import { createTestCore, type Core } from '../src';

let core: Core;
let orgId: string;
let userId: string;
const actor = () => ({ type: 'user' as const, id: userId });

beforeAll(async () => {
  core = await createTestCore();
  const r = await core.auth.register({ email: 'owner@example.com', password: 'correct horse battery', name: 'Owner', orgName: 'Acme' });
  orgId = r.org.id;
  userId = r.userId;
});
afterAll(async () => core?.db.close());

describe('authentication', () => {
  it('logs in, validates sessions and revokes them', async () => {
    const s = await core.auth.login('owner@example.com', 'correct horse battery');
    const v = await core.auth.validateSession(s.token);
    expect(v?.principal.userId).toBe(userId);
    expect(v?.csrfToken).toBe(s.csrfToken);
    await core.auth.logout(s.token);
    expect(await core.auth.validateSession(s.token)).toBeNull();
  });

  it('rejects wrong passwords and locks the account after repeated failures', async () => {
    await core.auth.register({ email: 'victim@example.com', password: 'another long password', name: 'V', orgName: 'V' });
    for (let i = 0; i < 5; i++) await expect(core.auth.login('victim@example.com', 'wrong password!!')).rejects.toThrow(/Invalid/);
    await expect(core.auth.login('victim@example.com', 'another long password')).rejects.toThrow(/Too many failed attempts/);
  });

  it('rejects weak passwords and duplicate emails', async () => {
    await expect(core.auth.register({ email: 'x@example.com', password: 'short', name: 'X', orgName: 'X' })).rejects.toThrow(/12 characters/);
    await expect(core.auth.register({ email: 'owner@example.com', password: 'correct horse battery', name: 'O', orgName: 'O' })).rejects.toThrow(/already exists/);
  });

  it('issues API keys scoped to one org with a capped role', async () => {
    const k = await core.auth.createApiKey(orgId, userId, 'ci', 'operator');
    const p = await core.auth.validateApiKey(k.key);
    expect(p?.scope).toEqual({ orgId, role: 'operator' });
    expect(await core.auth.resolveRole(p!, 'org_other')).toBeNull();
    await core.auth.revokeApiKey(orgId, k.id, userId);
    expect(await core.auth.validateApiKey(k.key)).toBeNull();
  });
});

describe('audit log', () => {
  it('builds a verifiable hash chain and detects forged entries', async () => {
    await core.audit.record({ orgId, actor: actor(), action: 'test.one' });
    await core.audit.record({ orgId, actor: actor(), action: 'test.two', details: { n: 2 } });
    expect((await core.audit.verifyChain(orgId)).valid).toBe(true);
    // An attacker with DB access inserts a row without the correct chain hash:
    await core.db.query(`INSERT INTO audit_logs (id, org_id, actor_type, actor_id, action, prev_hash, hash) VALUES ($1,$2,'system','x','forged','bogus','bogus')`, [newId('audit'), orgId]);
    const v = await core.audit.verifyChain(orgId);
    expect(v.valid).toBe(false);
    expect(v.brokenAt).toBeDefined();
  });
});

describe('encrypted secrets', () => {
  it('stores ciphertext only, masks hints and binds values to the org', async () => {
    await core.secrets.set(orgId, 'ai.anthropic.api_key', 'sk-ant-test-1234567890', userId);
    const row = await core.db.one<{ ciphertext: string; hint: string }>('SELECT ciphertext, hint FROM secrets WHERE org_id = $1', [orgId]);
    expect(row!.ciphertext).not.toContain('sk-ant');
    expect(row!.hint).toBe('••••7890');
    expect(await core.secrets.get(orgId, 'ai.anthropic.api_key')).toBe('sk-ant-test-1234567890');
    // Moving the ciphertext to another org must fail authentication (AAD binds org id).
    const other = await core.orgs.create('Other');
    await core.db.query(`INSERT INTO secrets (id, org_id, name, ciphertext, iv, tag, key_id) SELECT $1, $2, name, ciphertext, iv, tag, key_id FROM secrets WHERE org_id = $3`, [newId('secret'), other.id, orgId]);
    await expect(core.secrets.get(other.id, 'ai.anthropic.api_key')).rejects.toThrow();
  });
});

describe('policy engine', () => {
  it('defaults financial actions to REQUIRE_APPROVAL and trading to SIMULATE', async () => {
    expect((await core.policy.get(orgId, 'financial.payment')).mode).toBe('REQUIRE_APPROVAL');
    expect((await core.policy.get(orgId, 'financial.trade')).mode).toBe('SIMULATE');
    expect((await core.policy.evaluate(orgId, 'spend.commit', { amountUsd: 10 })).decision).toBe('require_approval');
  });

  it('enforces hard ceilings that no organisation can exceed', async () => {
    await expect(core.requestPolicyChange(orgId, 'financial.transfer', 'AUTONOMOUS', {}, actor())).rejects.toThrow(/cannot exceed/);
    await expect(core.requestPolicyChange(orgId, 'financial.trade', 'REQUIRE_APPROVAL', {}, actor())).rejects.toThrow(/cannot exceed/);
    // Even a row written directly to the database is clamped to the ceiling.
    await core.db.query(`INSERT INTO policies (org_id, action, mode) VALUES ($1, 'financial.payment', 'AUTONOMOUS')`, [orgId]);
    expect((await core.policy.get(orgId, 'financial.payment')).mode).toBe('REQUIRE_APPROVAL');
  });

  it('applies tightening immediately but routes relaxation through an approval', async () => {
    const tighten = await core.requestPolicyChange(orgId, 'deploy.local', 'REQUIRE_APPROVAL', {}, actor());
    expect(tighten.applied).toBe(true);
    const relax = await core.requestPolicyChange(orgId, 'deploy.local', 'AUTONOMOUS', {}, actor());
    expect(relax.applied).toBe(false);
    expect((await core.policy.get(orgId, 'deploy.local')).mode).toBe('REQUIRE_APPROVAL');
    await core.approvals.approve(orgId, (relax as { approvalId: string }).approvalId, actor());
    expect((await core.policy.get(orgId, 'deploy.local')).mode).toBe('AUTONOMOUS');
  });

  it('enforces autonomous amount limits', async () => {
    await core.policy.apply(orgId, 'spend.commit', 'AUTONOMOUS', { maxAmountUsd: 100 }, actor());
    expect((await core.policy.evaluate(orgId, 'spend.commit', { amountUsd: 50 })).decision).toBe('allow');
    expect((await core.policy.evaluate(orgId, 'spend.commit', { amountUsd: 500 })).decision).toBe('require_approval');
    await core.policy.apply(orgId, 'spend.commit', 'REQUIRE_APPROVAL', {}, actor());
  });
});

describe('approvals', () => {
  it('shows the full decision context, executes on approve and cannot be decided twice', async () => {
    const opp = await core.opportunities.createManual(orgId, { title: 'Test opp', problem: 'A problem', customer: 'SMBs', market: 'x', tags: [], industries: [], sourceUrls: [] }, actor());
    const exp = await core.experiments.create(orgId, { opportunityId: opp.id, budgetUsd: 250, variants: ['control'], thresholds: {}, funnel: 'landing_signup' }, actor());
    const started = await core.experiments.start(orgId, exp.id, actor());
    expect(started.status).toBe('pending_approval');
    const a = await core.approvals.get(orgId, (started as { approvalId: string }).approvalId);
    expect(a).toMatchObject({ actionType: 'spend.commit', expectedCostUsd: 250, reversibility: 'partially_reversible' });
    expect(a.what && a.why && a.expectedBenefit && a.risk.level).toBeTruthy();
    const done = await core.approvals.approve(orgId, a.id, actor(), 'go');
    expect(done.status).toBe('executed');
    expect((await core.experiments.get(orgId, exp.id)).status).toBe('running');
    expect((await core.ledger.balances(orgId)).find((b) => b.account === 'authorized_budgets')?.balanceUsd).toBe(-250);
    await expect(core.approvals.approve(orgId, a.id, actor())).rejects.toThrow(/already/);
  });

  it('records financial approvals in the paper ledger only', async () => {
    const a = await core.approvals.request(orgId, {
      actionType: 'financial.payment',
      title: 'Pay contractor $300',
      what: 'x',
      why: 'y',
      expectedBenefit: 'z',
      expectedCostUsd: 300,
      risk: { level: 'high', description: 'money' },
      dataSources: [],
      reversibility: 'irreversible',
      payload: { to: 'contractor' },
      requestedBy: 'agent:FinanceAgent',
    });
    const r = await core.approvals.approve(orgId, a.id, actor());
    expect(r.result).toMatchObject({ executed: false, recordedIn: 'paper_ledger' });
  });

  it('rejects and expires requests', async () => {
    const mk = (title: string, hours?: number) =>
      core.approvals.request(orgId, { actionType: 'external.high_risk', title, what: 'x', why: 'y', expectedBenefit: 'z', expectedCostUsd: 0, risk: { level: 'high', description: 'r' }, dataSources: [], reversibility: 'reversible', payload: { title }, requestedBy: 'u', expiresInHours: hours });
    const a = await mk('reject me');
    expect((await core.approvals.reject(orgId, a.id, actor(), 'no')).status).toBe('rejected');
    const b = await mk('expire me', -1);
    await expect(core.approvals.approve(orgId, b.id, actor())).rejects.toThrow(/expired/);
  });
});

describe('code execution switch', () => {
  it('never runs generated code when SANDBOX_DRIVER=disabled (no preview fallback to a plain process)', async () => {
    const off = await createTestCore({ env: { SANDBOX_DRIVER: 'disabled' } });
    try {
      const r = await off.auth.register({ email: 'nosandbox@example.com', password: 'correct horse battery', name: 'N', orgName: 'No Sandbox' });
      await expect(off.products.deployLocal(r.org.id, 'prj_any', { type: 'user', id: r.userId })).rejects.toThrow(/execution is disabled/);
    } finally {
      await off.db.close();
    }
  });
});
