'use client';

import { useState } from 'react';
import { post } from '@/lib/api';
import { ago, dateTime, pct, usd } from '@/lib/format';
import { ScoreRange } from './charts';
import { Collapsible, JsonView, KindBadge, StatusBadge } from './ui';

export * from './ui';

export function ScoreRangeCell({ o }: { o: { score: number | null; scoreBreakdown?: { low: number; high: number } | null } }) {
  return <ScoreRange score={o.score} low={o.scoreBreakdown?.low} high={o.scoreBreakdown?.high} width={90} />;
}

/** An estimated value with its range, unit, provenance kind and rationale. */
export function Estimate({ v, fmt = (x: number) => String(x) }: { v?: { value: number; low?: number; high?: number; kind: string; rationale?: string; unit?: string; confidence?: number } | null; fmt?: (x: number) => string }) {
  if (!v) return <span className="muted">not estimated</span>;
  return (
    <span title={v.rationale}>
      <strong className="num">{fmt(Number(v.value))}</strong>
      {v.low !== undefined && v.high !== undefined && (
        <span className="muted small num">
          {' '}
          ({fmt(v.low)}–{fmt(v.high)})
        </span>
      )}{' '}
      <KindBadge kind={v.kind} />
    </span>
  );
}

export function ScoreBreakdownTable({ breakdown }: { breakdown: any }) {
  if (!breakdown) return <div className="muted small">Not scored yet.</div>;
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Criterion</th>
            <th>Value (80% range)</th>
            <th className="r">Weight</th>
            <th>Source</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.criteria.map((c: any) => (
            <tr key={c.key}>
              <td className="nowrap">{c.label}</td>
              <td>
                <ScoreRange score={c.value} low={c.low} high={c.high} width={110} />
              </td>
              <td className="r">{pct(c.weight, 0)}</td>
              <td>
                <KindBadge kind={c.kind} />
              </td>
              <td className="small secondary">{c.rationale}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="tiny muted mt">
        Weighted score {breakdown.score.toFixed(3)} · Monte-Carlo 80% range {breakdown.low.toFixed(2)}–{breakdown.high.toFixed(2)} · confidence {pct(breakdown.confidence, 0)} · weights {breakdown.weightsVersion}
      </div>
    </div>
  );
}

export function EvidenceList({ evidence }: { evidence: any[] }) {
  if (!evidence.length) return <div className="muted small">No evidence recorded.</div>;
  return (
    <div className="stack">
      {evidence.map((e) => (
        <div key={e.id} className="list-item" style={{ paddingLeft: 0, paddingRight: 0 }}>
          <div className="row">
            <KindBadge kind={e.kind} />
            <strong className="small">{e.claim}</strong>
          </div>
          {e.quote && <blockquote className="q">{e.quote}</blockquote>}
          <div className="row tiny muted">
            <span>
              Source:{' '}
              {e.sourceUrl ? (
                <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                  {e.sourceName}
                </a>
              ) : (
                e.sourceName
              )}
            </span>
            <span>· observed {dateTime(e.observedAt)}</span>
            <span>· confidence {pct(e.confidence, 0)}</span>
            {e.provenance?.retrievedAt && <span>· retrieved {ago(e.provenance.retrievedAt)}</span>}
            {e.provenance?.injectionScore >= 0.5 && <StatusBadge status="warning" label="prompt-injection text detected" />}
            {e.provenance?.quoteVerified && <StatusBadge status="good" label="quote verified verbatim" />}
          </div>
          <Collapsible label="Provenance">
            <JsonView value={e.provenance} max={1500} />
          </Collapsible>
        </div>
      ))}
    </div>
  );
}

/** Approval card: WHAT / WHY / BENEFIT / COST / RISK / DATA SOURCES / REVERSIBILITY + decision. */
export function ApprovalCard({ a, onDecided, canDecide = true }: { a: any; onDecided?: () => void; canDecide?: boolean }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (d: 'approve' | 'reject') => {
    setBusy(d);
    setError(null);
    try {
      await post(`/api/approvals/${a.id}/${d}`, { note: note || undefined });
      onDecided?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const samples = a.payload?.samples as { to: string; subject: string; body: string }[] | undefined;
  return (
    <div className="approval">
      <div className="row between">
        <h2>{a.title}</h2>
        <div className="row">
          <StatusBadge status={a.status} />
          <span className="badge">{a.actionType}</span>
        </div>
      </div>
      <dl className="kv mt">
        <dt>What will happen</dt>
        <dd>{a.what}</dd>
        <dt>Why</dt>
        <dd>{a.why}</dd>
        <dt>Expected benefit</dt>
        <dd>{a.expectedBenefit}</dd>
        <dt>Expected cost</dt>
        <dd className="num">{usd(a.expectedCostUsd)}</dd>
        <dt>Risk</dt>
        <dd>
          <StatusBadge status={a.risk?.level} label={`${a.risk?.level} risk`} /> {a.risk?.description}
        </dd>
        <dt>Data sources</dt>
        <dd>
          {a.dataSources?.length
            ? a.dataSources.map((s: any, i: number) => (
                <div key={i} className="small">
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">
                      {s.name}
                    </a>
                  ) : (
                    s.name
                  )}
                  {s.retrievedAt ? <span className="muted"> · {dateTime(s.retrievedAt)}</span> : null}
                </div>
              ))
            : <span className="muted">None cited</span>}
        </dd>
        <dt>Reversibility</dt>
        <dd>
          <StatusBadge status={a.reversibility === 'irreversible' ? 'critical' : a.reversibility === 'reversible' ? 'good' : 'warning'} label={a.reversibility.replace('_', ' ')} />
        </dd>
        <dt>Requested</dt>
        <dd className="small secondary">
          by {a.requestedBy} · {dateTime(a.createdAt)}
          {a.expiresAt ? ` · expires ${dateTime(a.expiresAt)}` : ''}
          {a.taskId ? ` · paused agent task ${a.taskId}` : ''}
        </dd>
        {a.decidedBy && (
          <>
            <dt>Decision</dt>
            <dd className="small secondary">
              {a.status} by {a.decidedBy} {dateTime(a.decidedAt)}
              {a.decisionNote ? ` — “${a.decisionNote}”` : ''}
            </dd>
          </>
        )}
      </dl>
      {samples?.length ? (
        <div className="mt">
          <Collapsible label={`Sample messages (${samples.length})`}>
            {samples.map((s, i) => (
              <div key={i} className="mt">
                <div className="small">
                  <strong>To:</strong> {s.to} · <strong>Subject:</strong> {s.subject}
                </div>
                <pre className="code-view" style={{ whiteSpace: 'pre-wrap' }}>
                  {s.body}
                </pre>
              </div>
            ))}
          </Collapsible>
        </div>
      ) : null}
      {a.result && (
        <div className="mt">
          <Collapsible label="Execution result" defaultOpen={a.status === 'failed'}>
            <JsonView value={a.result} />
          </Collapsible>
        </div>
      )}
      {a.status === 'pending' && canDecide && (
        <div className="row mt">
          <input className="in" style={{ maxWidth: 360 }} placeholder="Decision note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn good" disabled={!!busy} onClick={() => decide('approve')}>
            {busy === 'approve' ? <span className="spin" /> : '✓'} Approve
          </button>
          <button className="btn danger" disabled={!!busy} onClick={() => decide('reject')}>
            {busy === 'reject' ? <span className="spin" /> : '✕'} Reject
          </button>
          {error && <span className="err">{error}</span>}
        </div>
      )}
    </div>
  );
}
