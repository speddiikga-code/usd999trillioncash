'use client';

import { useState } from 'react';
import { post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { dateTime, pct, usd } from '@/lib/format';
import { useSession } from '@/components/providers';
import { Empty, ErrorBox, KindBadge, Loading, Panel, StatTile, StatusBadge, Tabs, Pending } from '@/components/blocks';
import { FanChart, LineChart } from '@/components/charts';

type Tab = 'events' | 'expenses' | 'record';

export default function RevenuePage() {
  const { session } = useSession();
  const demo = session?.org.isDemo;
  const rev = useApi<any>('/api/revenue', { refreshOn: ['revenue.', 'expense.'] });
  const cash = useApi<any>('/api/revenue/cashflow', { refreshOn: ['revenue.', 'expense.'] });
  const events = useApi<any[]>('/api/revenue/events', { refreshOn: ['revenue.'] });
  const expenses = useApi<any[]>('/api/expenses', { refreshOn: ['expense.'] });
  const [tab, setTab] = useState<Tab>('events');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rf, setRf] = useState({ type: 'charge', amountUsd: 0, mrrUsd: 0, customerEmail: '', note: '' });
  const [ef, setEf] = useState({ category: 'ads', amountUsd: 0, description: '' });

  const submit = async (path: string, body: unknown) => {
    setErr(null);
    setMsg(null);
    try {
      await post(path, body);
      setMsg('Recorded.');
      void rev.reload();
      void events.reload();
      void expenses.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const sync = () => submit('/api/revenue/stripe/sync', {});

  if (!rev.data) return <Pending q={rev} />;
  const v = rev.data.verified;
  const r = rev.data.reported;
  const primary = demo ? r : v;
  const months = r.series.map((p: any) => p.month);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Revenue</h1>
          <div className="page-sub">
            <strong>Verified</strong> revenue comes only from signature-checked Stripe webhooks or read-only API sync — the database refuses to mark anything else verified. <strong>Reported</strong> adds manual entries (user input).
          </div>
        </div>
        <div className="row">
          {!demo && <button className="btn" onClick={sync} disabled={!rev.data.stripeConfigured} title={rev.data.stripeConfigured ? '' : 'Configure a Stripe key in Settings → Secrets'}>Sync from Stripe (read-only)</button>}
        </div>
      </div>
      {rev.data.notes.map((n: string) => <div key={n} className={`banner ${demo ? '' : 'good'}`}>{n}</div>)}
      <ErrorBox error={err} />
      {msg && <div className="ok">{msg}</div>}

      <div className="tiles">
        <StatTile label={demo ? 'MRR (demo)' : 'Verified MRR'} value={usd(primary.mrr)} sub={`ARR ${usd(primary.arr, { compact: true })}`} badge={<KindBadge kind={demo ? 'DEMO' : 'OBSERVED'} />} />
        {!demo && <StatTile label="Reported MRR" value={usd(r.mrr)} sub="verified + user input" badge={<KindBadge kind="USER_INPUT" />} />}
        <StatTile label="Revenue (all time)" value={usd(primary.revenueTotal, { compact: true })} sub={`last 30 days ${usd(primary.revenueLast30)}`} />
        <StatTile label="Net revenue" value={usd(primary.netRevenue, { compact: true })} sub={`refunds ${usd(primary.refundsTotal)}`} />
        <StatTile label="Gross profit" value={usd(primary.grossProfit, { compact: true })} sub={`margin ${pct(primary.grossMargin, 0)}`} />
        <StatTile label="Customers" value={String(primary.activeCustomers)} sub={`+${primary.newCustomersLast30} / −${primary.churnedCustomersLast30} (30d)`} />
        <StatTile label="Churn (monthly)" value={pct(primary.customerChurnRate)} sub={`revenue churn ${pct(primary.revenueChurnRate)}`} />
        <StatTile label="CAC · LTV" value={`${usd(primary.cac)} · ${usd(primary.ltv)}`} sub={primary.ltvAssumedLifetime ? 'LTV uses an assumed lifetime' : `LTV/CAC ${primary.ltvToCac ?? '—'} · payback ${primary.paybackMonths ?? '—'} mo`} />
        <StatTile label="MoM growth" value={pct(primary.momGrowth)} sub="geometric mean, last 3 months" />
      </div>
      {primary.notes.length > 0 && <div className="small muted" style={{ marginBottom: 12 }}>{primary.notes.join(' · ')}</div>}

      <div className="grid g2">
        <Panel title="Monthly recurring revenue">
          {r.series.some((p: any) => p.mrr > 0) ? (
            <LineChart
              series={
                demo
                  ? [{ key: 'demo', name: 'MRR (demo)', color: 'var(--series-1)', values: r.series.map((p: any, i: number) => ({ x: i, y: p.mrr })) }]
                  : [
                      { key: 'verified', name: 'Verified MRR', color: 'var(--series-1)', values: v.series.map((p: any, i: number) => ({ x: i, y: p.mrr })) },
                      { key: 'reported', name: 'Reported MRR', color: 'var(--series-2)', values: r.series.map((p: any, i: number) => ({ x: i, y: p.mrr })) },
                    ]
              }
              area={demo}
              xFormat={(i) => months[i] ?? ''}
              yFormat={(n) => usd(n, { compact: true })}
            />
          ) : <Empty>No recurring revenue recorded yet.</Empty>}
        </Panel>
        <Panel title="12-month cash projection (Monte Carlo)">
          {!cash.data ? <Pending q={cash} /> : (
            <>
              <FanChart name="Cash balance (median)" points={cash.data.months.map((m: any) => ({ x: m.month, p10: m.cashP10, p50: m.cashP50, p90: m.cashP90 }))} xFormat={(m) => `M${m}`} yFormat={(n) => usd(n, { compact: true })} />
              <div className="small secondary">
                Runway (median): {cash.data.runwayMonthsP50 ? `${cash.data.runwayMonthsP50} months` : '> 12 months'} · P(cash &lt; 0 within 12 months): {pct(cash.data.probCashNegative, 0)}
              </div>
              <div className="tiny muted">Inputs — growth: {cash.data.inputs.growthSource}; churn: {cash.data.inputs.churnSource}; margin: {cash.data.inputs.marginSource}; expenses: {cash.data.inputs.expensesSource}. {cash.data.assumptions.join(' ')}</div>
            </>
          )}
        </Panel>
      </div>

      <div className="mt2">
        <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'events', label: 'Revenue ledger' }, { id: 'expenses', label: 'Expenses' }, ...(demo ? [] : [{ id: 'record' as Tab, label: 'Record manually' }])]} />
        {tab === 'events' && (
          <Panel flush>
            {!events.data?.length ? <Empty>No revenue events.</Empty> : (
              <div className="table-wrap"><table className="t">
                <thead><tr><th>When</th><th>Type</th><th className="r">Amount</th><th className="r">MRR Δ</th><th>Source</th><th>Verified</th><th>Note</th></tr></thead>
                <tbody>{events.data.slice(0, 150).map((e) => (
                  <tr key={e.id}><td className="small nowrap">{dateTime(e.occurredAt)}</td><td className="mono small">{e.type}</td><td className="r">{usd(e.amountUsd, { cents: true })}</td><td className="r">{e.mrrDeltaUsd ? usd(e.mrrDeltaUsd, { cents: true }) : '—'}</td><td>{e.source}</td><td>{e.verified ? <StatusBadge status="good" label="verified" /> : <KindBadge kind={e.isDemo ? 'DEMO' : 'USER_INPUT'} />}</td><td className="small muted">{e.note ?? ''}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </Panel>
        )}
        {tab === 'expenses' && (
          <Panel flush>
            {!expenses.data?.length ? <Empty>No expenses.</Empty> : (
              <div className="table-wrap"><table className="t">
                <thead><tr><th>When</th><th>Category</th><th className="r">Amount</th><th>Description</th><th>Source</th></tr></thead>
                <tbody>{expenses.data.slice(0, 150).map((e) => (<tr key={e.id}><td className="small nowrap">{dateTime(e.occurredAt)}</td><td>{e.category}</td><td className="r">{usd(e.amountUsd, { cents: true })}</td><td className="small">{e.description}</td><td>{e.source}</td></tr>))}</tbody>
              </table></div>
            )}
          </Panel>
        )}
        {tab === 'record' && !demo && (
          <div className="grid g2">
            <Panel title="Manual revenue (USER INPUT — never counted as verified)">
              <div className="form-grid">
                <label className="field">Type<select className="in" value={rf.type} onChange={(e) => setRf({ ...rf, type: e.target.value })}>{['charge', 'refund', 'subscription_started', 'subscription_changed', 'subscription_canceled'].map((t) => <option key={t}>{t}</option>)}</select></label>
                <label className="field">Amount (USD)<input className="in" type="number" min={0} value={rf.amountUsd} onChange={(e) => setRf({ ...rf, amountUsd: Number(e.target.value) })} /></label>
                <label className="field">MRR (USD, subscriptions)<input className="in" type="number" min={0} value={rf.mrrUsd} onChange={(e) => setRf({ ...rf, mrrUsd: Number(e.target.value) })} /></label>
                <label className="field">Customer email<input className="in" value={rf.customerEmail} onChange={(e) => setRf({ ...rf, customerEmail: e.target.value })} /></label>
              </div>
              <label className="field mt">Note<input className="in" value={rf.note} onChange={(e) => setRf({ ...rf, note: e.target.value })} /></label>
              <button className="btn mt" onClick={() => submit('/api/revenue/events', { type: rf.type, amountUsd: rf.amountUsd, mrrUsd: rf.mrrUsd || undefined, customerEmail: rf.customerEmail || undefined, note: rf.note || undefined })}>Record revenue</button>
            </Panel>
            <Panel title="Expense">
              <div className="form-grid">
                <label className="field">Category<select className="in" value={ef.category} onChange={(e) => setEf({ ...ef, category: e.target.value })}>{['ads', 'infrastructure', 'ai', 'tools', 'contractors', 'payment_fees', 'other'].map((t) => <option key={t}>{t}</option>)}</select></label>
                <label className="field">Amount (USD)<input className="in" type="number" min={0} value={ef.amountUsd} onChange={(e) => setEf({ ...ef, amountUsd: Number(e.target.value) })} /></label>
              </div>
              <label className="field mt">Description<input className="in" value={ef.description} onChange={(e) => setEf({ ...ef, description: e.target.value })} /></label>
              <button className="btn mt" onClick={() => submit('/api/expenses', ef)}>Record expense</button>
            </Panel>
          </div>
        )}
      </div>
    </>
  );
}
