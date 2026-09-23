'use client';

import { useEffect, useState } from 'react';
import { get, post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { dateTime } from '@/lib/format';
import { Empty, ErrorBox, Loading, Markdown, Panel, StatusBadge, Pending } from '@/components/blocks';

export default function ReportsPage() {
  const list = useApi<any[]>('/api/reports', { refreshOn: ['report.'] });
  const recs = useApi<any[]>('/api/recommendations', { refreshOn: ['opportunity.', 'experiment.'] });
  const [selected, setSelected] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!selected && list.data?.[0]) get(`/api/reports/${list.data[0].id}`).then(setSelected).catch(() => undefined);
  }, [list.data, selected]);
  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post('/api/reports/generate');
      setSelected(await get(`/api/reports/${r.id}`));
      await list.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <div className="page-sub">Daily reports built only from recorded data: market changes, new opportunities, experiment results, revenue and customer changes, competitive changes, failures, and evidence-cited recommendations.</div>
        </div>
        <button className="btn primary" onClick={generate} disabled={busy}>{busy ? <span className="spin" /> : null} Generate now</button>
      </div>
      <ErrorBox error={err} />
      <Panel title="Recommended next actions (evidence-based)">
        {!recs.data ? <Pending q={recs} /> : !recs.data.length ? <Empty>No evidence-backed recommendation right now.</Empty> : recs.data.map((r, i) => (
          <div key={i} className="list-item" style={{ paddingLeft: 0 }}>
            <div className="row"><StatusBadge status={r.priority === 'high' ? 'serious' : r.priority === 'medium' ? 'warning' : 'neutral'} label={r.priority} /><strong>{r.action}</strong>{r.command && <code className="small">{r.command}</code>}</div>
            <div className="small secondary">{r.rationale}</div>
            {r.evidence.length > 0 && <div className="tiny muted">Evidence: {r.evidence.map((e: any) => `${e.type} ${e.id} (${e.detail})`).join(' · ')}</div>}
          </div>
        ))}
      </Panel>
      <div className="grid mt2" style={{ gridTemplateColumns: 'minmax(220px, 1fr) 3fr' }}>
        <Panel title="History" flush>
          {!list.data ? <Pending q={list} /> : !list.data.length ? <Empty>No reports yet.</Empty> : list.data.map((r) => (
            <div key={r.id} className="list-item">
              <button className="linkbtn" onClick={() => get(`/api/reports/${r.id}`).then(setSelected)}>{r.title}</button>
              <div className="tiny muted">{dateTime(r.createdAt)}</div>
            </div>
          ))}
        </Panel>
        <Panel title={selected?.title ?? 'Report'}>{selected ? <Markdown text={selected.markdown} /> : <Empty>Select a report.</Empty>}</Panel>
      </div>
    </>
  );
}
