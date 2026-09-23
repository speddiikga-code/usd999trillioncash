'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { dateTime, num, pct, usd } from '@/lib/format';
import { Collapsible, Empty, ErrorBox, KindBadge, Loading, Panel, StatusBadge, Pending } from '@/components/blocks';
import { Funnel, LineChart, VariantIntervals } from '@/components/charts';

export default function ExperimentDetail() {
  const { id } = useParams<{ id: string }>();
  const d = useApi<any>(`/api/experiments/${id}`, { refreshOn: ['experiment.', 'tracking.', 'expense.'] });
  const [err, setErr] = useState<string | null>(null);
  const [spend, setSpend] = useState({ amountUsd: 0, description: '' });
  const act = async (path: string, body?: unknown) => {
    setErr(null);
    try {
      await post(`/api/experiments/${id}/${path}`, body);
      await d.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (d.error) return <ErrorBox error={d.error} />;
  if (!d.data) return <Pending q={d} />;
  const { experiment: x, stages, variants, daily, spentUsd, evaluations, product } = d.data;
  const r = x.decisionRationale;
  const th = x.thresholds;
  const days = [...new Set(daily.map((p: any) => p.day))].sort() as string[];
  const dayVal = (day: string, ev: string) => daily.find((p: any) => p.day === day && p.event === ev)?.n ?? 0;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const snippet = product
    ? `<script>\n  // Minimal ROOS tracking for an external landing page\n  var anon = localStorage.roosAnon || (localStorage.roosAnon = crypto.randomUUID());\n  function roos(event, extra) {\n    fetch('${origin}/api/track', { method: 'POST', headers: { 'content-type': 'application/json', 'x-roos-write-key': '${product.writeKey}' },\n      body: JSON.stringify(Object.assign({ event: event, anonymousId: anon, experimentId: '${x.id}', variant: 'control' }, extra || {})) });\n  }\n  roos('page_view');\n  // on signup: roos('signup', { email: form.email.value });\n</script>`
    : '';

  return (
    <>
      <div className="page-head">
        <div style={{ maxWidth: 900 }}>
          <div className="small muted"><Link href="/experiments">Experiments</Link> / <span className="mono">{x.id}</span></div>
          <h1>{x.name}</h1>
          <div className="row"><StatusBadge status={x.status} />{x.decision && <StatusBadge status={x.decision} />}{x.isDemo && <KindBadge kind="DEMO" />}</div>
          <p className="secondary mt">Hypothesis: {x.hypothesis}</p>
        </div>
        <div className="row">
          {['draft', 'paused'].includes(x.status) && <button className="btn primary" onClick={() => act('start')}>Start{x.budgetUsd > 0 ? ' (needs approval)' : ''}</button>}
          {x.status === 'pending_approval' && <Link className="btn" href="/approvals">Review approval →</Link>}
          {x.status === 'running' && <button className="btn" onClick={() => act('evaluate')}>Evaluate now</button>}
          {['draft', 'running', 'paused', 'pending_approval'].includes(x.status) && <button className="btn danger" onClick={() => act('stop')}>Stop</button>}
        </div>
      </div>
      <ErrorBox error={err} />

      {r && (
        <div className={`banner ${r.decision === 'KILL' ? 'critical' : r.decision === 'SCALE' ? 'good' : ''}`}>
          <strong>{r.decision}</strong> — {r.reasons.join(' ')} <span className="tiny muted">(evaluated {dateTime(r.evaluatedAt)})</span>
        </div>
      )}

      <div className="tiles">
        <div className="tile"><div className="tile-label">Conversion rate</div><div className="tile-value">{r ? pct(r.stats.rate, 2) : '—'}</div><div className="tile-sub">{r ? `90% interval ${pct(r.stats.rateLow)}–${pct(r.stats.rateHigh)}` : 'not evaluated'}</div></div>
        <div className="tile"><div className="tile-label">Observations</div><div className="tile-value">{r ? num(r.stats.denominator) : '—'}</div><div className="tile-sub">minimum sample {num(th.minSample)}</div></div>
        <div className="tile"><div className="tile-label">P(rate &gt; target)</div><div className="tile-value">{r ? pct(r.stats.probAboveTarget, 0) : '—'}</div><div className="tile-sub">target {pct(th.targetRate)} · scale at ≥ {pct(th.scaleProbability, 0)}</div></div>
        <div className="tile"><div className="tile-label">Spend</div><div className="tile-value">{usd(spentUsd)}</div><div className="tile-sub">budget {usd(x.budgetUsd)}{r?.stats.cacUsd ? ` · CAC ${usd(r.stats.cacUsd)}` : ''}</div></div>
        <div className="tile"><div className="tile-label">Running for</div><div className="tile-value">{r ? `${r.stats.daysRunning.toFixed(1)} d` : '—'}</div><div className="tile-sub">max {th.maxDays} days</div></div>
      </div>

      <div className="grid g2">
        <Panel title="Funnel (unique visitors per stage)">
          {stages.every((s: any) => !s.count) ? <Empty>No tracked events yet. Deploy the MVP (Products) or add the tracking snippet below to any landing page.</Empty> : <Funnel stages={stages.map((s: any) => ({ label: s.label, count: s.count }))} />}
        </Panel>
        <Panel title={`Variants — ${x.primaryNumerator} / ${x.primaryDenominator}`}>
          {variants.every((v: any) => !v.denominator) ? <Empty>No variant data yet.</Empty> : (
            <VariantIntervals variants={variants.map((v: any) => ({ ...v, probBest: r?.stats.variants?.find((s: any) => s.variant === v.variant)?.probBest }))} />
          )}
          {x.variantCopy && Object.keys(x.variantCopy).length > 0 && (
            <div className="small mt">{Object.entries(x.variantCopy).map(([k, v]) => <div key={k}><strong>{k}:</strong> “{String(v)}”</div>)}</div>
          )}
        </Panel>
      </div>

      {days.length > 1 && (
        <Panel title="Daily trend" className="mt2">
          <LineChart
            height={200}
            series={[
              { key: 'v', name: stages[0]?.label ?? 'Visitors', color: 'var(--series-1)', values: days.map((day, i) => ({ x: i, y: dayVal(day, x.primaryDenominator) })) },
              { key: 's', name: stages[1]?.label ?? 'Conversions', color: 'var(--series-2)', values: days.map((day, i) => ({ x: i, y: dayVal(day, x.primaryNumerator) })) },
            ]}
            xFormat={(i) => days[i] ?? ''}
            yFormat={(v) => num(v, { digits: 0 })}
          />
        </Panel>
      )}

      <div className="grid g2 mt2">
        <Panel title="Pre-registered thresholds">
          <dl className="kv small">
            <dt>Target rate</dt><dd>{pct(th.targetRate)}</dd>
            <dt>Minimum sample</dt><dd>{num(th.minSample)}</dd>
            <dt>Scale when</dt><dd>P(rate &gt; target) ≥ {pct(th.scaleProbability, 0)}</dd>
            <dt>Kill when</dt><dd>P(rate &gt; {pct(th.targetRate * th.killFraction)}) &lt; {pct(th.killProbability, 0)}</dd>
            <dt>Time / budget</dt><dd>{th.maxDays} days · {usd(th.maxBudgetUsd)}</dd>
            <dt>Guardrails</dt><dd>complaints ≤ {pct(th.maxComplaintRate ?? 0.01)}{th.maxCacUsd ? ` · CAC ≤ ${usd(th.maxCacUsd)}` : ''}{th.minLtvToCac ? ` · LTV/CAC ≥ ${th.minLtvToCac}` : ''}</dd>
          </dl>
          {x.status === 'running' && (
            <div className="row mt">
              <input className="in" type="number" min={0} style={{ width: 110 }} placeholder="USD" value={spend.amountUsd || ''} onChange={(e) => setSpend({ ...spend, amountUsd: Number(e.target.value) })} />
              <input className="in" style={{ flex: 1 }} placeholder="Spend description (e.g. search ads day 3)" value={spend.description} onChange={(e) => setSpend({ ...spend, description: e.target.value })} />
              <button className="btn" disabled={!spend.amountUsd || !spend.description} onClick={() => act('spend', spend)}>Record spend</button>
            </div>
          )}
        </Panel>
        <Panel title="Measure it">
          {product ? (
            <>
              <div className="small">Product: <strong>{product.name}</strong> <StatusBadge status={product.status} /> {product.url && <a href={product.url} target="_blank" rel="noopener noreferrer">{product.url}</a>}</div>
              <div className="small mt">Generated MVPs deployed from ROOS report events automatically. For any other landing page, add:</div>
              <pre className="code-view mt" style={{ whiteSpace: 'pre-wrap' }}>{snippet}</pre>
            </>
          ) : <Empty>No product attached.</Empty>}
        </Panel>
      </div>

      <Panel title="Evaluation history" className="mt2">
        {!evaluations.length ? <Empty>Not evaluated yet.</Empty> : evaluations.map((e: any, i: number) => (
          <div key={i} className="list-item" style={{ paddingLeft: 0 }}>
            <div className="row"><StatusBadge status={e.decision} /><span className="small muted">{dateTime(e.createdAt)}</span><span className="small">{pct(e.result.stats.rate, 2)} of {num(e.result.stats.denominator)}</span></div>
            <div className="small secondary">{e.result.reasons.join(' ')}</div>
          </div>
        ))}
        <div className="mt"><Collapsible label="Raw decision record"><pre className="code-view">{JSON.stringify(r, null, 2)}</pre></Collapsible></div>
      </Panel>
    </>
  );
}
