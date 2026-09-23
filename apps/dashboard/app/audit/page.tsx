'use client';

import { useState } from 'react';
import { get } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { dateTime } from '@/lib/format';
import { Collapsible, Empty, JsonView, Loading, Panel, StatusBadge, Pending } from '@/components/blocks';

export default function AuditPage() {
  const [action, setAction] = useState('');
  const log = useApi<any[]>(`/api/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`);
  const [verify, setVerify] = useState<any>(null);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <div className="page-sub">Append-only (enforced by a database trigger) and tamper-evident: each entry stores the hash of the previous one. Every agent tool call, policy change, approval, login and data export is recorded.</div>
        </div>
        <button className="btn" onClick={() => get('/api/audit/verify').then(setVerify)}>Verify hash chain</button>
      </div>
      {verify && (
        <div className={`banner ${verify.valid ? 'good' : 'critical'}`}>
          {verify.valid ? `✓ Chain intact — ${verify.entries} entries verified.` : `✕ Chain broken at ${verify.brokenAt} (${verify.entries} entries).`}
        </div>
      )}
      <input className="in" style={{ maxWidth: 320, marginBottom: 8 }} placeholder="Filter by action prefix (e.g. approval, tool., policy)" value={action} onChange={(e) => setAction(e.target.value)} />
      <Panel flush>
        {!log.data ? <Pending q={log} /> : !log.data.length ? <Empty>No entries.</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th><th>Details</th></tr></thead>
              <tbody>{log.data.map((a) => (
                <tr key={a.id}>
                  <td className="small nowrap">{dateTime(a.createdAt)}</td>
                  <td className="small">{a.actorType}<div className="tiny muted mono">{a.actorId}</div></td>
                  <td className="mono small">{a.action}</td>
                  <td className="tiny mono">{a.targetType ? `${a.targetType} ${a.targetId ?? ''}` : '—'}</td>
                  <td><StatusBadge status={a.outcome === 'success' ? 'good' : a.outcome === 'denied' ? 'critical' : a.outcome === 'pending' ? 'warning' : 'serious'} label={a.outcome} /></td>
                  <td style={{ maxWidth: 380 }}><Collapsible label="details"><JsonView value={a.details} max={1500} /><div className="tiny muted mono">hash {a.hash.slice(0, 16)}… prev {a.prevHash ? `${a.prevHash.slice(0, 16)}…` : '∅'}</div></Collapsible></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
