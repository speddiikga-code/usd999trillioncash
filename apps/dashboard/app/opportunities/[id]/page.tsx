'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { dateTime, pct, usd } from '@/lib/format';
import { Collapsible, Empty, ErrorBox, Estimate, EvidenceList, KindBadge, Loading, Panel, ScoreBreakdownTable, StatusBadge, Tabs, Pending } from '@/components/blocks';
import { LineChart } from '@/components/charts';
import { WorkflowProgress } from '@/components/workflow';

type Tab = 'overview' | 'evidence' | 'hypotheses' | 'build' | 'experiments';

export default function OpportunityDetail() {
  const { id } = useParams<{ id: string }>();
  const d = useApi<any>(`/api/opportunities/${id}`, { refreshOn: ['opportunity.', 'hypothesis.', 'project.', 'experiment.'] });
  const [tab, setTab] = useState<Tab>('overview');
  const [wf, setWf] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [budget, setBudget] = useState(0);

  const trigger = async (action: string, body: Record<string, unknown> = {}) => {
    setErr(null);
    try {
      const r = await post(`/api/opportunities/${id}/${action}`, body);
      setWf(r.workflowId);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const select = async (hypothesisId: string) => {
    try {
      await post(`/api/opportunities/${id}/hypotheses/select`, { hypothesisId });
      await d.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (d.error) return <ErrorBox error={d.error} />;
  if (!d.data) return <Pending q={d} />;
  const o = d.data;
  const hist = o.scoreHistory ?? [];

  return (
    <>
      <div className="page-head">
        <div style={{ maxWidth: 900 }}>
          <div className="small muted"><Link href="/opportunities">Opportunities</Link> / <span className="mono">{o.id}</span></div>
          <h1>{o.title}</h1>
          <div className="row">
            <StatusBadge status={o.status} />
            {o.isDemo && <KindBadge kind="DEMO" />}
            {o.tags.map((t: string) => <span key={t} className="badge">{t}</span>)}
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => trigger('analyze')}>Analyze</button>
          <button className="btn" onClick={() => trigger('build')} disabled={!o.hypotheses.length} title={o.hypotheses.length ? '' : 'Analyze first'}>Build MVP</button>
          <button className="btn" onClick={() => trigger('launch')} disabled={!o.projects.length} title={o.projects.length ? '' : 'Build first'}>Launch preview</button>
          <span className="row" style={{ gap: 4 }}>
            <input className="in" type="number" min={0} style={{ width: 90 }} value={budget} onChange={(e) => setBudget(Number(e.target.value))} title="Experiment budget (USD) — above $0 requires approval" />
            <button className="btn primary" onClick={() => trigger('experiment', { budgetUsd: budget })}>Start experiment</button>
          </span>
          <button className="btn" onClick={() => trigger('growth')}>Draft outreach</button>
        </div>
      </div>
      <ErrorBox error={err} />
      {wf && <Panel title="Workflow"><WorkflowProgress workflowId={wf} onDone={() => void d.reload()} /></Panel>}

      <div className="tiles mt">
        <div className="tile">
          <div className="tile-label">Score</div>
          <div className="tile-value">{o.score?.toFixed(2) ?? '—'}</div>
          <div className="tile-sub">80% range {o.scoreBreakdown?.low?.toFixed(2)}–{o.scoreBreakdown?.high?.toFixed(2)} · confidence {pct(o.confidence, 0)}</div>
        </div>
        <div className="tile"><div className="tile-label">Serviceable market / yr</div><div className="tile-value small"><Estimate v={o.estimatedMarketSize} fmt={(x) => usd(x, { compact: true })} /></div></div>
        <div className="tile"><div className="tile-label">Price / month</div><div className="tile-value small"><Estimate v={o.estimatedPrice} fmt={(x) => usd(x)} /></div></div>
        <div className="tile"><div className="tile-label">CAC</div><div className="tile-value small"><Estimate v={o.acquisitionCostEstimate} fmt={(x) => usd(x)} /></div></div>
        <div className="tile"><div className="tile-label">Gross margin</div><div className="tile-value small"><Estimate v={o.grossMarginEstimate} fmt={(x) => pct(x, 0)} /></div></div>
        <div className="tile"><div className="tile-label">Time to MVP</div><div className="tile-value small"><Estimate v={o.timeToMvp} fmt={(x) => `${x.toFixed(1)} wk`} /></div></div>
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview & score' },
          { id: 'evidence', label: `Evidence (${o.evidence.length})` },
          { id: 'hypotheses', label: `Business hypotheses (${o.hypotheses.length})` },
          { id: 'build', label: `Products & builds (${o.projects.length})` },
          { id: 'experiments', label: `Experiments (${o.experiments.length})` },
        ]}
      />

      {tab === 'overview' && (
        <div className="grid g2">
          <Panel title="Problem & customer">
            <p>{o.problem}</p>
            <dl className="kv mt">
              <dt>Customer</dt><dd>{o.customer}</dd>
              <dt>Market</dt><dd>{o.market}</dd>
              <dt>Competition</dt>
              <dd>
                {o.competition ? (
                  <>
                    <StatusBadge status={o.competition.level === 'high' ? 'serious' : o.competition.level === 'unknown' ? 'neutral' : 'info'} label={o.competition.level.replace('_', ' ')} /> <KindBadge kind={o.competition.kind} />
                    <div className="small secondary">{o.competition.rationale}</div>
                    {o.competition.competitors.map((c: any) => <div key={c.name} className="small">• {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer nofollow">{c.name}</a> : c.name} <span className="muted">{c.note}</span></div>)}
                  </>
                ) : '—'}
              </dd>
              <dt>Regulatory risk</dt><dd><Estimate v={o.regulatoryRisk} fmt={(x) => x.toFixed(2)} /><div className="small secondary">{o.regulatoryRisk?.rationale}</div></dd>
              <dt>Technical complexity</dt><dd><Estimate v={o.technicalComplexity} fmt={(x) => x.toFixed(2)} /><div className="small secondary">{o.technicalComplexity?.rationale}</div></dd>
              <dt>Observed signals</dt>
              <dd className="small">{o.signals.documentCount} documents · {o.signals.distinctSources} sources · engagement {o.signals.totalEngagement} · pain {o.signals.painScore} · {o.signals.willingnessToPayMentions} payment mentions · keywords: {o.signals.keywords.join(', ')}</dd>
            </dl>
          </Panel>
          <Panel title="Score breakdown">
            <ScoreBreakdownTable breakdown={o.scoreBreakdown} />
            {hist.length > 1 && (
              <div className="mt">
                <LineChart
                  height={150}
                  endLabels={false}
                  series={[{ key: 's', name: 'Score', color: 'var(--series-1)', values: hist.map((h: any, i: number) => ({ x: i, y: h.score })) }]}
                  xFormat={(i) => dateTime(hist[i]?.createdAt)}
                  yFormat={(v) => v.toFixed(2)}
                />
              </div>
            )}
          </Panel>
        </div>
      )}

      {tab === 'evidence' && (
        <Panel title="Evidence (every claim: source, timestamp, confidence, data type, provenance)">
          <EvidenceList evidence={o.evidence} />
        </Panel>
      )}

      {tab === 'hypotheses' && (
        <div className="stack">
          {!o.hypotheses.length && <Panel><Empty>No hypotheses yet — click <strong>Analyze</strong>.</Empty></Panel>}
          {o.hypotheses.map((h: any) => (
            <Panel
              key={h.id}
              title={<span>{h.model.replace(/_/g, ' ')} · score {h.score.toFixed(2)}</span>}
              actions={
                <div className="row">
                  <StatusBadge status={h.status === 'selected' ? 'good' : h.status === 'invalidated' ? 'critical' : 'neutral'} label={h.status} />
                  {h.status !== 'selected' && <button className="btn sm" onClick={() => select(h.id)}>Select for build</button>}
                </div>
              }
            >
              <h2>{h.title}</h2>
              <p className="secondary">{h.valueProposition}</p>
              <div className="grid g3 mt">
                <div>
                  <h3>Unit economics</h3>
                  <dl className="kv small" style={{ gridTemplateColumns: '110px 1fr' }}>
                    <dt>Price</dt><dd><Estimate v={h.unitEconomics.price} fmt={(x) => usd(x)} /></dd>
                    <dt>CAC</dt><dd><Estimate v={h.unitEconomics.cac} fmt={(x) => usd(x)} /></dd>
                    <dt>Churn / mo</dt><dd><Estimate v={h.unitEconomics.monthlyChurn} fmt={(x) => pct(x)} /></dd>
                    <dt>LTV</dt><dd><Estimate v={h.unitEconomics.ltv} fmt={(x) => usd(x)} /></dd>
                    <dt>LTV / CAC</dt><dd><Estimate v={h.unitEconomics.ltvToCac} fmt={(x) => x.toFixed(1)} /></dd>
                    <dt>Payback</dt><dd><Estimate v={h.unitEconomics.paybackMonths} fmt={(x) => `${x.toFixed(1)} mo`} /></dd>
                  </dl>
                </div>
                <div>
                  <h3>MVP</h3>
                  <div className="small"><strong>{h.mvpSpec.name}</strong> — {h.mvpSpec.tagline}</div>
                  <ul className="small">{h.mvpSpec.coreFeatures.map((f: string) => <li key={f}>{f}</li>)}</ul>
                  <div className="tiny muted">Entities: {h.mvpSpec.entities.map((e: any) => `${e.name}(${e.fields.map((f: any) => f.name).join(', ')})`).join('; ')}</div>
                </div>
                <div>
                  <h3>Pricing ({h.pricing.metric})</h3>
                  {h.pricing.tiers.map((t: any) => <div key={t.name} className="small">{t.name}: <strong>{usd(t.priceUsdMonthly)}</strong>/mo</div>)}
                  <KindBadge kind={h.pricing.kind} />
                </div>
              </div>
              <div className="mt">
                <Collapsible label="Distribution, experiments, retention, costs & architecture">
                  <div className="grid g2 small">
                    <div><h3>Distribution</h3><ul>{h.distribution.map((x: string) => <li key={x}>{x}</li>)}</ul></div>
                    <div><h3>Acquisition experiments</h3><ul>{h.acquisitionExperiments.map((x: any) => <li key={x.name}>{x.name} ({x.channel}) — {x.hypothesis}{x.costUsd ? ` · ${usd(x.costUsd)} (approval required)` : ''}</li>)}</ul></div>
                    <div><h3>Retention</h3><ul>{h.retentionStrategy.map((x: string) => <li key={x}>{x}</li>)}</ul></div>
                    <div><h3>Experiment plan</h3><ul>{h.experimentPlan.map((x: any) => <li key={x.step}>{x.step} — {x.metric} {x.threshold}</li>)}</ul></div>
                    <div><h3>Expected monthly costs</h3><ul>{h.expectedCosts.map((x: any) => <li key={x.item}>{x.item}: {usd(x.monthlyUsd)} <KindBadge kind={x.kind} /></li>)}</ul></div>
                    <div><h3>Technical architecture</h3><ul>{h.technicalArchitecture.map((x: string) => <li key={x}>{x}</li>)}</ul></div>
                  </div>
                  <div className="tiny muted">Generated by {h.generatedBy}</div>
                </Collapsible>
              </div>
            </Panel>
          ))}
        </div>
      )}

      {tab === 'build' && (
        <div className="grid g2">
          <Panel title="Products">
            {!o.products.length ? <Empty>No product yet.</Empty> : o.products.map((p: any) => (
              <div key={p.id} className="list-item" style={{ paddingLeft: 0 }}>
                <div className="row"><strong>{p.name}</strong><StatusBadge status={p.status} /></div>
                {p.url && <div className="small"><a href={p.url} target="_blank" rel="noopener noreferrer">{p.url}</a></div>}
                <div className="tiny muted">Write key (for tracking): <code>{p.writeKey}</code></div>
              </div>
            ))}
          </Panel>
          <Panel title="Generated MVP projects">
            {!o.projects.length ? <Empty>Nothing built yet — click <strong>Build MVP</strong>.</Empty> : o.projects.map((p: any) => (
              <div key={p.id} className="list-item" style={{ paddingLeft: 0 }}>
                <div className="row"><Link href={`/products?project=${p.id}`}>{p.name}</Link><StatusBadge status={p.status} /></div>
                <div className="tiny muted">Scan {p.scanResult?.passed ? 'passed' : 'failed'} · tests {p.testResult?.status} · {dateTime(p.createdAt)}</div>
              </div>
            ))}
          </Panel>
        </div>
      )}

      {tab === 'experiments' && (
        <Panel flush>
          {!o.experiments.length ? <Empty>No experiments yet.</Empty> : (
            <table className="t">
              <thead><tr><th>Experiment</th><th>Status</th><th>Decision</th><th className="r">Budget</th><th>Started</th></tr></thead>
              <tbody>{o.experiments.map((x: any) => (
                <tr key={x.id}><td><Link href={`/experiments/${x.id}`}>{x.name}</Link></td><td><StatusBadge status={x.status} /></td><td>{x.decision ? <StatusBadge status={x.decision} /> : '—'}</td><td className="r">{usd(x.budgetUsd)}</td><td className="small muted">{dateTime(x.startedAt)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Panel>
      )}
    </>
  );
}
