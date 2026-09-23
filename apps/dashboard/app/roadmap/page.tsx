'use client';

import { useEffect, useState } from 'react';
import { post, put } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { num, pct, sci, usd } from '@/lib/format';
import { ErrorBox, KindBadge, Loading, Panel, StatusBadge } from '@/components/blocks';
import { LineChart, type Series } from '@/components/charts';

const FIELDS: { key: string; label: string; step?: number; pct?: boolean }[] = [
  { key: 'horizonYears', label: 'Horizon (years)', step: 1 },
  { key: 'startingArrUsd', label: 'Hypothetical starting ARR (if no verified revenue)', step: 1000 },
  { key: 'conservativeGrowth', label: 'Conservative year-1 growth', step: 0.05, pct: true },
  { key: 'baseGrowth', label: 'Base year-1 growth', step: 0.05, pct: true },
  { key: 'aggressiveGrowth', label: 'Aggressive year-1 growth', step: 0.1, pct: true },
  { key: 'growthDecay', label: 'Annual growth decay', step: 0.01, pct: true },
  { key: 'avgArrPerBusinessUsd', label: 'Avg ARR per mature business', step: 1e6 },
  { key: 'arpuPerYearUsd', label: 'Revenue per customer / year', step: 100 },
  { key: 'burnMultiple', label: 'Burn multiple (capital per $ net new ARR)', step: 0.1 },
  { key: 'worldGdpUsd', label: 'REFERENCE: world GDP (USD / yr)', step: 1e12 },
  { key: 'worldGdpGrowth', label: 'REFERENCE: world GDP growth', step: 0.005, pct: true },
  { key: 'worldPopulation', label: 'REFERENCE: world population', step: 1e8 },
  { key: 'targetUsd', label: 'Target (cumulative revenue, USD)', step: 1e15 },
];

export default function RoadmapPage() {
  const saved = useApi<any>('/api/roadmap', { refreshOn: ['revenue.'] });
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (saved.data && !draft) setDraft({ ...saved.data.assumptions });
  }, [saved.data, draft]);

  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => {
      post('/api/roadmap/preview', draft).then(setPreview).catch((e) => setErr((e as Error).message));
    }, 300);
    return () => clearTimeout(t);
  }, [draft]);

  const save = async () => {
    setSaving(true);
    try {
      await put('/api/roadmap/assumptions', draft);
      await saved.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const d = preview ?? saved.data;
  if (!d || !draft) return <Loading />;
  const years = d.scenarios[0]?.trajectory.map((p: any) => p.year) ?? [];
  const palette = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
  const series: Series[] = [
    ...d.scenarios.map((s: any, i: number) => ({ key: s.name, name: s.name, color: palette[i % 4]!, dashed: s.name.startsWith('Required'), values: s.trajectory.map((p: any) => ({ x: p.year, y: p.cumulativeUsd })) })),
    { key: 'target', name: 'Target (cumulative)', color: 'var(--text-secondary)', reference: true, values: years.map((y: number) => ({ x: y, y: d.assumptions.targetUsd })) },
  ];
  const arrSeries: Series[] = [
    ...d.scenarios.map((s: any, i: number) => ({ key: s.name, name: s.name, color: palette[i % 4]!, dashed: s.name.startsWith('Required'), values: s.trajectory.map((p: any) => ({ x: p.year, y: p.arrUsd })) })),
    { key: 'gdp', name: 'World GDP (reference)', color: 'var(--text-secondary)', reference: true, values: d.scenarios[0].trajectory.map((p: any) => ({ x: p.year, y: p.worldGdpUsd })) },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Quadrillion roadmap</h1>
          <div className="page-sub">
            The target of <strong>{usd(d.assumptions.targetUsd)}</strong> is an intentionally extreme, long-term <em>optimisation objective</em> — <strong>not a forecast and not a promise</strong>. This page measures whether real, verified progress is happening and shows what would have to be true.
          </div>
        </div>
        <div className="row">
          {d.isDemo && <KindBadge kind="DEMO" />}
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : null} Save assumptions</button>
        </div>
      </div>
      <ErrorBox error={err} />

      <div className="grid g2">
        <Panel title="Empirical progress">
          <div className="small secondary">{d.isDemo ? 'Demo cumulative revenue' : 'Verified cumulative revenue'}</div>
          <div className="hero">{usd(d.current.verifiedCumulativeRevenueUsd)}</div>
          <div className="secondary mt">
            = <strong className="num">{sci(d.current.progressFraction * 100)}%</strong> of the target · {d.isDemo ? 'Demo' : 'Verified'} ARR {usd(d.current.verifiedArrUsd)} · observed annual growth {d.current.observedAnnualGrowth === null ? 'not yet measurable (< 3 months of MRR)' : pct(d.current.observedAnnualGrowth)}
          </div>
          <div className="stack mt">
            {d.milestones.map((m: any) => (
              <div key={m.label} className="row">
                <StatusBadge status={m.reached ? 'good' : 'neutral'} label={m.reached ? 'reached' : 'not yet'} />
                <span className="small">{m.label}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="What would have to be true">
          <dl className="kv small">
            <dt>Starting point</dt><dd>{usd(d.current.startingArrUsed)} ARR {d.current.startingArrIsHypothetical ? <StatusBadge status="warning" label="HYPOTHETICAL" /> : <KindBadge kind={d.isDemo ? 'DEMO' : 'OBSERVED'} />}</dd>
            <dt>Required growth</dt><dd><strong>{d.required.cagr === null ? '—' : pct(d.required.cagr)}</strong> every year for {d.assumptions.horizonYears} years</dd>
            <dt>Final-year revenue</dt><dd>{usd(d.required.finalYearArrUsd, { compact: true })} = {num(d.required.finalArrToWorldGdp, { digits: 1 })}× world GDP (reference)</dd>
            <dt>Businesses needed</dt><dd>{num(d.required.businesses, { compact: true })} at {usd(d.assumptions.avgArrPerBusinessUsd, { compact: true })} ARR each</dd>
            <dt>Customers needed</dt><dd>{num(d.required.customers, { compact: true })} ({num(d.required.customersToWorldPopulation, { digits: 1 })}× world population)</dd>
            <dt>Capital needed</dt><dd>{usd(d.required.capitalUsd, { compact: true })} at a {d.assumptions.burnMultiple}× burn multiple</dd>
            {d.observedGrowthProjection && <><dt>At observed growth</dt><dd>{d.observedGrowthProjection.yearsToTarget ? `${d.observedGrowthProjection.yearsToTarget} years` : 'never within 300 years'}</dd></>}
          </dl>
          <div className="stack mt">
            {d.feasibility.map((f: string) => <div key={f} className="banner" style={{ marginBottom: 0 }}>{f}</div>)}
          </div>
        </Panel>
      </div>

      <div className="grid g2 mt2">
        <Panel title="Cumulative revenue by scenario (log scale)">
          <LineChart series={series} log height={280} xFormat={(y) => `Y${y}`} yFormat={(v) => usd(v, { compact: true })} />
        </Panel>
        <Panel title="Annual revenue vs world GDP (log scale)">
          <LineChart series={arrSeries} log height={280} xFormat={(y) => `Y${y}`} yFormat={(v) => usd(v, { compact: true })} />
        </Panel>
      </div>

      <div className="grid g2 mt2">
        <Panel title="Scenarios">
          <table className="t">
            <thead><tr><th>Scenario</th><th className="r">Year-1 growth</th><th className="r">Decay</th><th className="r">Cumulative at horizon</th><th className="r">% of target</th><th className="r">Years to target</th></tr></thead>
            <tbody>{d.scenarios.map((s: any) => (
              <tr key={s.name}><td>{s.name}</td><td className="r">{pct(s.initialGrowth, 0)}</td><td className="r">{pct(s.decay, 0)}</td><td className="r">{usd(s.cumulativeAtHorizonUsd, { compact: true })}</td><td className="r">{sci(s.pctOfTarget * 100)}%</td><td className="r">{s.yearsToTarget ?? 'never'}</td></tr>
            ))}</tbody>
          </table>
        </Panel>
        <Panel title="Assumptions (edit to explore — preview updates live)">
          <div className="form-grid">
            {FIELDS.map((f) => (
              <label key={f.key} className="field" title={d.notes?.[f.key]}>
                {f.label}
                <input className="in" type="number" step={f.step} value={draft[f.key] ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })} />
                <span className="tiny muted">{f.pct ? pct(draft[f.key] ?? 0) : num(draft[f.key] ?? 0, { compact: true })} · {d.notes?.[f.key]}</span>
              </label>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
