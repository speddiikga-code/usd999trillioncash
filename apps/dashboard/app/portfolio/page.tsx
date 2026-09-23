'use client';

import Link from 'next/link';
import { useState } from 'react';
import { post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { num, pct, usd } from '@/lib/format';
import { Empty, ErrorBox, KindBadge, Loading, Panel, StatTile, Pending } from '@/components/blocks';
import { BarList } from '@/components/charts';

export default function PortfolioPage() {
  const k = useApi<any>('/api/portfolio', { refreshOn: ['revenue.', 'experiment.', 'opportunity.'] });
  const [form, setForm] = useState({ budgetUsd: 5000, maxShare: 0.5, explorationFloor: 0.1, minPerOpportunityUsd: 0 });
  const [alloc, setAlloc] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setAlloc(await post('/api/portfolio/allocate', form));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!k.data) return <Pending q={k} />;
  const d = k.data;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Portfolio</h1>
          <div className="page-sub">Business portfolio metrics and capital allocation under uncertainty. Allocation is a recommendation — committing money is the approval-gated <code>spend.commit</code> action.</div>
        </div>
      </div>
      {d.notes.map((n: string) => <div key={n} className="banner">{n}</div>)}
      <div className="tiles">
        <StatTile label="Total opportunities" value={num(d.totalOpportunities)} />
        <StatTile label="Validated" value={num(d.validatedOpportunities)} />
        <StatTile label="Active experiments" value={num(d.activeExperiments)} />
        <StatTile label="Products launched" value={num(d.productsLaunched)} />
        <StatTile label="Users (30d)" value={num(d.users30d)} />
        <StatTile label="Customers" value={num(d.customers)} />
        <StatTile label={d.isDemo ? 'MRR (demo)' : 'Verified MRR'} value={usd(d.mrr)} badge={d.isDemo ? <KindBadge kind="DEMO" /> : undefined} />
        <StatTile label="ARR" value={usd(d.arr, { compact: true })} />
        <StatTile label="Gross margin" value={pct(d.grossMargin, 0)} />
        <StatTile label="CAC" value={usd(d.cac)} />
        <StatTile label="LTV" value={usd(d.ltv)} sub={d.ltvAssumedLifetime ? 'assumed lifetime' : undefined} />
        <StatTile label="Cash burn (30d)" value={usd(d.cashBurn30d)} />
        <StatTile label="Pipeline (weighted)" value={usd(d.pipelineWeighted, { compact: true })} />
        <StatTile label="Experiment win rate" value={pct(d.experimentWinRate, 0)} sub={`${d.experimentsDecided} decided`} />
        <StatTile label="Portfolio value" value={usd(d.portfolioValue.mid, { compact: true })} sub={`${usd(d.portfolioValue.low, { compact: true })}–${usd(d.portfolioValue.high, { compact: true })}`} badge={<KindBadge kind="MODEL_ASSUMPTION" />} />
        <StatTile label="Automation rate" value={pct(d.automationRate, 0)} />
      </div>

      <Panel title="Capital allocation (Thompson sampling)">
        <div className="form-grid">
          <label className="field">Budget (USD)<input className="in" type="number" min={0} value={form.budgetUsd} onChange={(e) => setForm({ ...form, budgetUsd: Number(e.target.value) })} /></label>
          <label className="field">Max share per opportunity<input className="in" type="number" step={0.05} min={0.05} max={1} value={form.maxShare} onChange={(e) => setForm({ ...form, maxShare: Number(e.target.value) })} /></label>
          <label className="field">Exploration floor<input className="in" type="number" step={0.05} min={0} max={0.5} value={form.explorationFloor} onChange={(e) => setForm({ ...form, explorationFloor: Number(e.target.value) })} /></label>
          <label className="field">Minimum ticket (USD)<input className="in" type="number" min={0} value={form.minPerOpportunityUsd} onChange={(e) => setForm({ ...form, minPerOpportunityUsd: Number(e.target.value) })} /></label>
        </div>
        <button className="btn primary mt" onClick={run} disabled={busy}>{busy ? <span className="spin" /> : null} Recommend allocation</button>
        <ErrorBox error={err} />
        {alloc && (
          <div className="mt">
            {!alloc.allocations.length ? <Empty>No scored opportunities to allocate to.</Empty> : (
              <>
                <BarList items={alloc.allocations.map((a: any) => ({ label: a.name, value: a.amountUsd, sub: a.rationale }))} format={(v) => usd(v)} labelWidth={260} />
                <div className="table-wrap mt">
                  <table className="t">
                    <thead><tr><th>Opportunity</th><th className="r">Allocation</th><th className="r">P(best ROI)</th><th className="r">P(success)</th><th className="r">EV (80% range)</th><th>Evidence basis</th></tr></thead>
                    <tbody>{alloc.allocations.map((a: any) => (
                      <tr key={a.id}><td><Link href={`/opportunities/${a.id}`}>{a.name}</Link></td><td className="r">{usd(a.amountUsd)} ({pct(a.share, 0)})</td><td className="r">{pct(a.probBest)}</td><td className="r">{pct(a.successProbMean)}</td><td className="r small">{usd(a.evMeanUsd, { compact: true })} ({usd(a.evLowUsd, { compact: true })}–{usd(a.evHighUsd, { compact: true })})</td><td><KindBadge kind={a.evidenceBasis === 'experiment' ? 'OBSERVED' : 'MODEL_ASSUMPTION'} /> <span className="small">{a.evidenceBasis === 'experiment' ? 'experiment data' : 'score prior'}</span></td></tr>
                    ))}</tbody>
                  </table>
                </div>
                <div className="small muted mt">Unallocated: {usd(alloc.unallocatedUsd)} · {alloc.draws.toLocaleString()} Monte-Carlo draws · {alloc.notes.join(' ')}</div>
              </>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}
