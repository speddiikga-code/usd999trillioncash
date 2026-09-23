'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { patch, post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { ago, dateTime, usd } from '@/lib/format';
import { Collapsible, Empty, ErrorBox, JsonView, Loading, Panel, StatusBadge, Pending } from '@/components/blocks';

function TaskDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useApi<any>(`/api/tasks/${id}`, { refreshOn: ['task.'] });
  const [err, setErr] = useState<string | null>(null);
  const act = async (a: 'cancel' | 'retry') => {
    try {
      await post(`/api/tasks/${id}/${a}`);
      await t.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (!t.data) return <Pending q={t} />;
  const d = t.data;
  return (
    <Panel title={`Task ${d.id}`} actions={<button className="btn sm ghost" onClick={onClose}>Close</button>}>
      <div className="row">
        <strong>{d.agent}</strong> <span className="mono">{d.kind}</span> <StatusBadge status={d.status} />
        <span className="small muted">attempt {d.attempts}/{d.maxAttempts} · AI {usd(d.costUsd, { cents: true })} · {d.tokens} tokens</span>
        <div className="spacer" />
        {['queued', 'waiting_approval'].includes(d.status) && <button className="btn sm danger" onClick={() => act('cancel')}>Cancel</button>}
        {['failed', 'timed_out', 'cancelled'].includes(d.status) && <button className="btn sm" onClick={() => act('retry')}>Retry</button>}
      </div>
      <ErrorBox error={err} />
      {d.error && <div className="banner critical mt">{d.error}</div>}
      {d.approvalId && <div className="small mt">Approval: <Link href="/approvals">{d.approvalId}</Link></div>}
      <div className="small muted mt">Workflow {d.workflowId ?? '—'} · parent {d.parentId ?? '—'} · created by {d.createdBy} · {dateTime(d.createdAt)} → {dateTime(d.finishedAt)}</div>
      <h3 className="mt">Trace</h3>
      <table className="t">
        <thead><tr><th>Span</th><th>Kind</th><th>Status</th><th className="r">Duration</th><th>Detail</th></tr></thead>
        <tbody>{d.spans.map((s: any, i: number) => (
          <tr key={i}><td className="mono small">{s.name}</td><td>{s.kind}</td><td><StatusBadge status={s.status === 'ok' ? 'good' : s.status === 'approval_required' ? 'warning' : 'critical'} label={s.status} /></td><td className="r">{s.durationMs} ms</td><td className="small muted">{s.attributes?.error ?? s.attributes?.reason ?? s.attributes?.mode ?? ''}</td></tr>
        ))}</tbody>
      </table>
      {d.modelCalls.length > 0 && (
        <>
          <h3 className="mt">Model calls</h3>
          <table className="t">
            <thead><tr><th>Provider / model</th><th>Purpose</th><th>Status</th><th className="r">Tokens in/out</th><th className="r">Cost</th><th className="r">Latency</th></tr></thead>
            <tbody>{d.modelCalls.map((m: any, i: number) => (
              <tr key={i}><td className="small">{m.provider}/{m.model}</td><td className="mono small">{m.purpose}</td><td><StatusBadge status={m.status === 'ok' ? 'good' : 'critical'} label={m.status} /></td><td className="r">{m.inputTokens}/{m.outputTokens}</td><td className="r">{usd(m.costUsd, { cents: true })}</td><td className="r">{m.latencyMs} ms</td></tr>
            ))}</tbody>
          </table>
        </>
      )}
      <div className="grid g2 mt">
        <Collapsible label="Input"><JsonView value={d.input} /></Collapsible>
        <Collapsible label="Output" defaultOpen><JsonView value={d.output} /></Collapsible>
      </div>
      {d.children.length > 0 && <div className="small mt">Follow-up tasks: {d.children.map((c: any) => <span key={c.id} className="badge" style={{ marginRight: 4 }}>{c.agent}:{c.kind} · {c.status}</span>)}</div>}
    </Panel>
  );
}

function AgentsInner() {
  const params = useSearchParams();
  const agents = useApi<any>('/api/agents', { refreshOn: ['task.'] });
  const [filter, setFilter] = useState({ status: '', agent: '' });
  const tasks = useApi<any[]>(`/api/tasks?limit=100${filter.status ? `&status=${filter.status}` : ''}${filter.agent ? `&agent=${filter.agent}` : ''}`, { refreshOn: ['task.'] });
  const [selected, setSelected] = useState<string | null>(params.get('task'));
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setSelected(params.get('task')), [params]);

  const update = async (name: string, body: Record<string, unknown>) => {
    setErr(null);
    try {
      await patch(`/api/agents/${name}`, body);
      await agents.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agents & tasks</h1>
          <div className="page-sub">Eleven specialised agents coordinate only through the durable task queue. Each has a tool allow-list, AI budgets, a timeout and a retry policy; every tool call is policy-checked, audited and traced.</div>
        </div>
      </div>
      <ErrorBox error={err} />
      <Panel title="Agents" flush>
        {!agents.data ? <Pending q={agents} /> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Agent</th><th>Status</th><th>Handles</th><th className="r">Queued / running</th><th className="r">7d ok / failed</th><th className="r">AI today / daily cap</th><th className="r">Per task cap</th><th className="r">Timeout</th><th /></tr></thead>
              <tbody>{agents.data.agents.map((a: any) => (
                <tr key={a.name}>
                  <td><strong>{a.name}</strong><div className="tiny muted" style={{ maxWidth: 280 }}>{a.description}</div></td>
                  <td><StatusBadge status={a.enabled ? a.status : 'disabled'} /></td>
                  <td className="mono tiny">{a.kinds.join(', ')}</td>
                  <td className="r">{a.queued} / {a.running}</td>
                  <td className="r">{a.succeeded7d} / {a.failed7d}</td>
                  <td className="r">{usd(a.costTodayUsd, { cents: true })} / {usd(a.budget.dailyCostUsd)}</td>
                  <td className="r">{usd(a.budget.maxCostPerTaskUsd)}</td>
                  <td className="r">{Math.round(a.timeoutMs / 1000)}s</td>
                  <td className="nowrap">
                    <button className="btn sm" onClick={() => update(a.name, { enabled: !a.enabled })}>{a.enabled ? 'Disable' : 'Enable'}</button>{' '}
                    <button className="btn sm ghost" onClick={() => setEditing(editing === a.name ? null : a.name)}>Tools</button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {editing && agents.data && (() => {
          const a = agents.data.agents.find((x: any) => x.name === editing);
          return (
            <div className="panel-body">
              <h3>{editing} — tool allow-list</h3>
              <div className="row mt">
                {Object.values(agents.data.tools).map((t: any) => (
                  <label key={t.name} className="row small" style={{ gap: 4 }} title={t.description + (t.action ? ` (policy: ${t.action})` : '')}>
                    <input type="checkbox" checked={a.tools.includes(t.name)} onChange={(e) => update(editing, { tools: e.target.checked ? [...a.tools, t.name] : a.tools.filter((x: string) => x !== t.name) })} />
                    <span className="mono">{t.name}</span>
                  </label>
                ))}
              </div>
              <div className="row mt">
                <label className="field">Daily AI cap (USD)<input className="in" type="number" min={0} defaultValue={a.budget.dailyCostUsd} onBlur={(e) => update(editing, { budget: { dailyCostUsd: Number(e.target.value) } })} /></label>
                <label className="field">Per-task AI cap (USD)<input className="in" type="number" min={0} step={0.05} defaultValue={a.budget.maxCostPerTaskUsd} onBlur={(e) => update(editing, { budget: { maxCostPerTaskUsd: Number(e.target.value) } })} /></label>
              </div>
            </div>
          );
        })()}
      </Panel>

      {selected && <div className="mt2"><TaskDetail id={selected} onClose={() => setSelected(null)} /></div>}

      <div className="row mt2" style={{ marginBottom: 8 }}>
        <select className="in" style={{ width: 180 }} value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          {['', 'queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'timed_out', 'cancelled'].map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
        </select>
        <select className="in" style={{ width: 180 }} value={filter.agent} onChange={(e) => setFilter({ ...filter, agent: e.target.value })}>
          <option value="">All agents</option>
          {agents.data?.agents.map((a: any) => <option key={a.name}>{a.name}</option>)}
        </select>
      </div>
      <Panel title="Task queue" flush>
        {!tasks.data ? <Pending q={tasks} /> : !tasks.data.length ? <Empty>No tasks.</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Task</th><th>Agent</th><th>Status</th><th className="r">Attempts</th><th className="r">AI cost</th><th>Error</th><th>Created</th></tr></thead>
              <tbody>{tasks.data.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => setSelected(t.id)}>
                  <td className="mono small">{t.kind}</td><td>{t.agent}</td><td><StatusBadge status={t.status} /></td><td className="r">{t.attempts}</td><td className="r">{usd(t.costUsd, { cents: true })}</td><td className="small err" style={{ maxWidth: 320 }}>{t.status !== 'succeeded' && t.error ? String(t.error).slice(0, 120) : ''}</td><td className="small muted nowrap">{ago(t.createdAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

export default function AgentsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <AgentsInner />
    </Suspense>
  );
}
