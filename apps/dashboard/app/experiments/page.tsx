'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApi } from '@/lib/hooks';
import { dateTime, num, pct, usd } from '@/lib/format';
import { Empty, Loading, Panel, StatusBadge, Pending } from '@/components/blocks';

export default function ExperimentsPage() {
  const router = useRouter();
  const [status, setStatus] = useState('');
  const list = useApi<any[]>(`/api/experiments${status ? `?status=${status}` : ''}`, { refreshOn: ['experiment.', 'tracking.'] });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Experiments</h1>
          <div className="page-sub">
            Each business runs as a sequence of measurable experiments with thresholds fixed in advance. Decisions (SCALE / ITERATE / PAUSE / KILL / CONTINUE) come from Bayesian posteriors, minimum sample sizes and guardrails — never from moving goalposts.
          </div>
        </div>
        <select className="in" style={{ width: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          {['', 'draft', 'pending_approval', 'running', 'paused', 'completed', 'killed'].map((s) => (
            <option key={s} value={s}>{s || 'All statuses'}</option>
          ))}
        </select>
      </div>
      <Panel flush>
        {!list.data ? <Pending q={list} /> : !list.data.length ? <Empty>No experiments. Open an opportunity and click “Start experiment”, or run <code>/experiment &lt;id&gt;</code>.</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Experiment</th><th>Status</th><th>Decision</th><th className="r">Rate</th><th className="r">90% interval</th><th className="r">n</th><th className="r">P(&gt; target)</th><th className="r">Target</th><th className="r">Spent / budget</th><th>Started</th></tr></thead>
              <tbody>
                {list.data.map((x) => {
                  const s = x.decisionRationale?.stats;
                  return (
                    <tr key={x.id} className="clickable" onClick={() => router.push(`/experiments/${x.id}`)}>
                      <td style={{ maxWidth: 360 }}><Link href={`/experiments/${x.id}`}>{x.name}</Link><div className="tiny muted ellipsis">{x.opportunityTitle}</div></td>
                      <td><StatusBadge status={x.status} /></td>
                      <td>{x.decision ? <StatusBadge status={x.decision} /> : <span className="muted">—</span>}</td>
                      <td className="r">{s ? pct(s.rate, 2) : '—'}</td>
                      <td className="r small">{s ? `${pct(s.rateLow)}–${pct(s.rateHigh)}` : '—'}</td>
                      <td className="r">{s ? num(s.denominator) : '—'}</td>
                      <td className="r">{s ? pct(s.probAboveTarget, 0) : '—'}</td>
                      <td className="r">{pct(x.thresholds.targetRate)}</td>
                      <td className="r">{usd(x.spentUsd)} / {usd(x.budgetUsd)}</td>
                      <td className="small muted">{dateTime(x.startedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
