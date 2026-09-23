import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@roos/shared';
import { createTestDb, json, loadMigrations, migrate, migrationStatus, type Db } from '../src';

let db: Db;
const realOrg = newId('org');
const demoOrg = newId('org');

beforeAll(async () => {
  db = await createTestDb();
  await db.query(`INSERT INTO organizations (id, name, slug, is_demo) VALUES ($1, 'Real', 'real', false), ($2, 'Demo', 'demo', true)`, [realOrg, demoOrg]);
});
afterAll(async () => db?.close());

describe('migrations', () => {
  it('applies all migrations and is idempotent', async () => {
    const status = await migrationStatus(db);
    expect(status.length).toBe(loadMigrations().length);
    expect(status.every((s) => s.applied)).toBe(true);
    const again = await migrate(db);
    expect(again.applied).toEqual([]);
    expect(again.drift).toEqual([]);
  });

  it('creates every table required by the specification', async () => {
    const rows = await db.many<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of [
      'users', 'organizations', 'agents', 'agent_tasks', 'opportunities', 'markets', 'companies', 'customers', 'products',
      'experiments', 'metrics', 'revenue_events', 'expenses', 'leads', 'campaigns', 'approvals', 'audit_logs', 'sources',
      'documents', 'model_calls', 'model_costs', 'deployments', 'projects',
    ]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });
});

describe('demo data isolation', () => {
  it('forces is_demo from the organisation regardless of the value supplied', async () => {
    const a = newId('opportunity');
    const b = newId('opportunity');
    await db.query(`INSERT INTO opportunities (id, org_id, title, problem, customer, market, is_demo) VALUES ($1, $2, 't', 'p', 'c', 'm', true)`, [a, realOrg]);
    await db.query(`INSERT INTO opportunities (id, org_id, title, problem, customer, market, is_demo) VALUES ($1, $2, 't', 'p', 'c', 'm', false)`, [b, demoOrg]);
    expect(await db.value('SELECT is_demo FROM opportunities WHERE id = $1', [a])).toBe(false);
    expect(await db.value('SELECT is_demo FROM opportunities WHERE id = $1', [b])).toBe(true);
    await db.query('UPDATE opportunities SET is_demo = false WHERE id = $1', [b]);
    expect(await db.value('SELECT is_demo FROM opportunities WHERE id = $1', [b])).toBe(true);
  });
});

describe('revenue integrity constraints', () => {
  it('rejects verified revenue that did not come from a payment provider', async () => {
    await expect(
      db.query(`INSERT INTO revenue_events (id, org_id, type, amount_usd, occurred_at, source, verified) VALUES ($1, $2, 'charge', 10, now(), 'manual', true)`, [newId('revenue'), realOrg]),
    ).rejects.toThrow();
  });

  it('rejects verified revenue in a demo organisation', async () => {
    await expect(
      db.query(`INSERT INTO revenue_events (id, org_id, type, amount_usd, occurred_at, source, verified, external_id) VALUES ($1, $2, 'charge', 10, now(), 'stripe', true, 'ch_1')`, [newId('revenue'), demoOrg]),
    ).rejects.toThrow();
  });

  it('accepts provider-verified revenue in a real organisation and dedupes external ids', async () => {
    const q = `INSERT INTO revenue_events (id, org_id, type, amount_usd, occurred_at, source, verified, external_id) VALUES ($1, $2, 'charge', 49, now(), 'stripe', true, 'ch_42')`;
    await db.query(q, [newId('revenue'), realOrg]);
    await expect(db.query(q, [newId('revenue'), realOrg])).rejects.toThrow();
  });
});

describe('audit log', () => {
  it('is append-only', async () => {
    const id = newId('audit');
    await db.query(`INSERT INTO audit_logs (id, org_id, actor_type, actor_id, action, hash) VALUES ($1, $2, 'system', 'test', 'test.action', 'h')`, [id, realOrg]);
    await expect(db.query(`UPDATE audit_logs SET action = 'tampered' WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit_logs WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
  });
});

describe('transactions', () => {
  it('rolls back all statements issued inside db.tx, including nested calls', async () => {
    const id = newId('market');
    await expect(
      db.tx(async () => {
        await db.query(`INSERT INTO markets (id, org_id, name) VALUES ($1, $2, 'rollback-me')`, [id, realOrg]);
        await db.tx(async () => {
          await db.query(`SELECT 1`);
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.one('SELECT id FROM markets WHERE id = $1', [id])).toBeNull();
  });

  it('round-trips jsonb values', async () => {
    const id = newId('market');
    await db.query(`INSERT INTO markets (id, org_id, name, size_estimate) VALUES ($1, $2, 'json', $3)`, [id, realOrg, json({ value: 5, sources: [{ name: 'x' }] })]);
    const row = await db.one<{ size_estimate: { value: number; sources: { name: string }[] } }>('SELECT size_estimate FROM markets WHERE id = $1', [id]);
    expect(row?.size_estimate.value).toBe(5);
    expect(row?.size_estimate.sources[0]?.name).toBe('x');
  });
});

describe('task queue claim', () => {
  it('claims each queued task exactly once under concurrency', async () => {
    const ids = Array.from({ length: 6 }, () => newId('task'));
    for (const id of ids) {
      await db.query(`INSERT INTO agent_tasks (id, org_id, agent, kind) VALUES ($1, $2, 'ResearchAgent', 'research.discover')`, [id, realOrg]);
    }
    const claim = () =>
      db.one<{ id: string }>(
        `UPDATE agent_tasks SET status = 'running', locked_by = 'w', locked_at = now(), attempts = attempts + 1
         WHERE id = (SELECT id FROM agent_tasks WHERE status = 'queued' AND run_after <= now()
                     ORDER BY priority DESC, created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id`,
      );
    const results = await Promise.all(Array.from({ length: 10 }, () => db.tx(claim)));
    const claimed = results.filter(Boolean).map((r) => r!.id);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.length).toBe(6);
  });
});
