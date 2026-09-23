'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { ago, pct, usd } from '@/lib/format';
import { Collapsible, Empty, ErrorBox, Estimate, Loading, Panel, ScoreRangeCell, StatusBadge, Pending } from '@/components/blocks';
import { WorkflowProgress } from '@/components/workflow';

const STATUSES = ['', 'discovered', 'analyzed', 'validated', 'built', 'launched', 'experimenting', 'scaling', 'paused', 'killed'];

export default function OpportunitiesPage() {
  const router = useRouter();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const list = useApi<any>(`/api/opportunities?limit=100&sort=score${status ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`, { refreshOn: ['opportunity.'] });
  const sources = useApi<any>('/api/sources');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [wf, setWf] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState({ title: '', problem: '', customer: '', market: '' });

  const discover = async () => {
    setErr(null);
    try {
      const r = await post('/api/opportunities/discover', { query, sources: picked.length ? picked : undefined, limitPerSource: 30 });
      setWf(r.workflowId);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const createManual = async () => {
    setErr(null);
    try {
      const o = await post('/api/opportunities', { ...manual, tags: [], industries: [], sourceUrls: [] });
      router.push(`/opportunities/${o.id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const connectors = (sources.data?.connectors ?? []).filter((c: any) => c.queryable);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Opportunities</h1>
          <div className="page-sub">Discovered from public data with cited evidence, or entered manually. Every score carries an uncertainty range; unmeasured inputs are labelled as assumptions.</div>
        </div>
      </div>

      <Panel title="Discover">
        <div className="row">
          <input className="in" style={{ flex: 1, minWidth: 260 }} placeholder='e.g. "invoice reconciliation for small accounting firms"' value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && query && discover()} />
          <button className="btn primary" disabled={!query.trim()} onClick={discover}>
            Run discovery
          </button>
        </div>
        <div className="row mt small">
          <span className="muted">Sources:</span>
          {connectors.map((c: any) => (
            <label key={c.id} className="row" style={{ gap: 4 }} title={c.available ? c.terms : `Requires: ${c.missing.join(', ')}`}>
              <input type="checkbox" disabled={!c.available} checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((p) => p !== c.id))} />
              <span className={c.available ? '' : 'muted'}>{c.name}</span>
            </label>
          ))}
          <span className="tiny muted">(none selected = your enabled sources)</span>
        </div>
        {wf && (
          <div className="mt">
            <WorkflowProgress workflowId={wf} onDone={() => void list.reload()} />
          </div>
        )}
        <div className="mt">
          <Collapsible label="Add an opportunity manually (recorded as USER INPUT)">
            <div className="form-grid">
              <label className="field">Title<input className="in" value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} /></label>
              <label className="field">Customer<input className="in" value={manual.customer} onChange={(e) => setManual({ ...manual, customer: e.target.value })} /></label>
              <label className="field">Market<input className="in" value={manual.market} onChange={(e) => setManual({ ...manual, market: e.target.value })} /></label>
            </div>
            <label className="field mt">Problem<textarea className="in" rows={3} value={manual.problem} onChange={(e) => setManual({ ...manual, problem: e.target.value })} /></label>
            <button className="btn mt" disabled={!manual.title || !manual.problem || !manual.customer || !manual.market} onClick={createManual}>Create</button>
          </Collapsible>
        </div>
        <ErrorBox error={err} />
      </Panel>

      <div className="row mt2" style={{ marginBottom: 8 }}>
        <input className="in" style={{ maxWidth: 280 }} placeholder="Search title, problem, customer" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="in" style={{ maxWidth: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s || 'All statuses'}</option>
          ))}
        </select>
        <span className="small muted">{list.data?.total ?? '…'} opportunities</span>
      </div>

      <Panel flush>
        {!list.data ? <Pending q={list} /> : !list.data.items.length ? <Empty>No opportunities match. Run a discovery above.</Empty> : (
          <div className={`table-wrap ${list.loading ? 'refetching' : ''}`}>
            <table className="t">
              <thead>
                <tr><th>Opportunity</th><th>Status</th><th>Score (80% range)</th><th className="r">Confidence</th><th className="r">Evidence</th><th>Market size</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {list.data.items.map((o: any) => (
                  <tr key={o.id} className="clickable" onClick={() => router.push(`/opportunities/${o.id}`)}>
                    <td style={{ maxWidth: 420 }}>
                      <Link href={`/opportunities/${o.id}`}>{o.title}</Link>
                      <div className="tiny muted ellipsis">{o.customer}</div>
                    </td>
                    <td><StatusBadge status={o.status} /></td>
                    <td><ScoreRangeCell o={o} /></td>
                    <td className="r">{pct(o.confidence, 0)}</td>
                    <td className="r">{o.evidenceCount}</td>
                    <td className="small"><Estimate v={o.estimatedMarketSize} fmt={(x) => usd(x, { compact: true })} /></td>
                    <td className="small muted nowrap">{ago(o.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
