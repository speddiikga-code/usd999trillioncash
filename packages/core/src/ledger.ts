import type { Db } from '@roos/database';
import { camelize, newId, round } from '@roos/shared';

/**
 * Paper (simulated) ledger. Financial actions in SIMULATE mode — and every approved financial
 * action, because ROOS never moves real money itself — are recorded here so their would-be effect
 * can be analysed without touching bank, brokerage, payment or crypto accounts.
 */
export class PaperLedger {
  constructor(private db: Db) {}

  async record(orgId: string, e: { account: string; entryType: string; amountUsd: number; memo: string; approvalId?: string; experimentId?: string }) {
    const id = newId('ledger');
    await this.db.query(`INSERT INTO paper_ledger (id, org_id, account, entry_type, amount_usd, memo, approval_id, experiment_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      id,
      orgId,
      e.account,
      e.entryType,
      e.amountUsd,
      e.memo,
      e.approvalId ?? null,
      e.experimentId ?? null,
    ]);
    return id;
  }

  async list(orgId: string, limit = 200) {
    return (await this.db.many('SELECT * FROM paper_ledger WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2', [orgId, limit])).map((r) => camelize(r));
  }

  async balances(orgId: string) {
    const rows = await this.db.many<{ account: string; total: number }>('SELECT account, SUM(amount_usd) AS total FROM paper_ledger WHERE org_id = $1 GROUP BY account ORDER BY account', [orgId]);
    return rows.map((r) => ({ account: r.account, balanceUsd: round(Number(r.total), 2) }));
  }
}
