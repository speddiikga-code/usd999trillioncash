'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { patch, post, put } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/components/providers';
import { ErrorBox, Loading, StatusBadge, Pending } from '@/components/blocks';
import { WorkflowProgress } from '@/components/workflow';

const TITLES: Record<string, string> = {
  system_status: 'Check system status',
  connect_ai: 'Connect an AI provider (optional)',
  configure_sources: 'Configure data sources',
  constraints: 'Define capital & time constraints',
  industries: 'Choose industries of interest',
  first_scan: 'Run the first opportunity scan',
  hypotheses: 'Generate business hypotheses',
  select_opportunity: 'Select an opportunity & hypothesis',
  generate_mvp: 'Generate the MVP',
  launch_experiment: 'Launch an experiment',
  track_results: 'Track results',
};

export default function Onboarding() {
  const { session } = useSession();
  const org = useApi<any>('/api/org', { refreshOn: ['research.', 'hypothesis.', 'opportunity.', 'project.', 'experiment.', 'tracking.'] });
  const health = useApi<any>('/api/system/status');
  const sources = useApi<any>('/api/sources');
  const top = useApi<any>('/api/opportunities?limit=5&sort=score', { refreshOn: ['opportunity.'] });
  const [err, setErr] = useState<string | null>(null);
  const [wf, setWf] = useState<string | null>(null);
  const [ai, setAi] = useState({ name: 'ai.anthropic.api_key', value: '' });
  const [c, setC] = useState({ initialCapitalUsd: 1000, monthlyBudgetUsd: 200, hoursPerWeek: 10, riskTolerance: 'medium' });
  const [industries, setIndustries] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (org.data?.settings?.industries?.length && !industries) setIndustries(org.data.settings.industries.join(', '));
  }, [org.data, industries]);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await org.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const mark = (step: string) => run(() => post('/api/onboarding/step', { step, done: true }));

  if (session?.org.isDemo) return <div className="banner">You are viewing the DEMO workspace. Switch to your own workspace (top bar) to run the first-run setup.</div>;
  if (!org.data) return <Pending q={org} />;
  const steps = org.data.onboarding.steps as { step: string; done: boolean }[];
  const next = org.data.onboarding.next as string | null;
  const opp = picked ?? top.data?.items?.[0]?.id ?? null;

  const body: Record<string, ReactNode> = {
    system_status: health.data ? (
      <div className="stack small">
        <div>Status <StatusBadge status={health.data.status} /> · database {health.data.database.kind} · sandbox {health.data.sandbox.driver} ({health.data.sandbox.available ? 'available' : 'unavailable'}) · workers alive {health.data.workers.filter((w: any) => w.alive).length}</div>
        {health.data.warnings.map((w: string) => <div key={w} className="banner" style={{ marginBottom: 0 }}>{w}</div>)}
        <div><button className="btn" onClick={() => mark('system_status')}>Looks good</button></div>
      </div>
    ) : <Loading />,
    connect_ai: (
      <div className="stack small">
        <div className="secondary">Without a provider, ROOS uses transparent heuristics (clustering, keyword signals, templates) and labels outputs as such. With one, synthesis and copy improve — every model call is budgeted, logged and validated.</div>
        <div className="row">
          <select className="in" style={{ width: 200 }} value={ai.name} onChange={(e) => setAi({ ...ai, name: e.target.value })}>
            <option value="ai.anthropic.api_key">Anthropic</option><option value="ai.openai.api_key">OpenAI</option><option value="ai.google.api_key">Google Gemini</option><option value="ai.ollama.base_url">Ollama (local URL)</option>
          </select>
          <input className="in" style={{ flex: 1 }} type="password" autoComplete="off" value={ai.value} onChange={(e) => setAi({ ...ai, value: e.target.value })} placeholder="API key (stored encrypted)" />
          <button className="btn primary" disabled={!ai.value} onClick={() => run(() => put('/api/secrets', { name: ai.name, value: ai.value }))}>Connect</button>
          <button className="btn" onClick={() => mark('connect_ai')}>Skip — use heuristics</button>
        </div>
      </div>
    ),
    configure_sources: sources.data ? (
      <div className="stack small">
        <div>{sources.data.connectors.filter((x: any) => x.available && x.queryable).length} public sources available without credentials: {sources.data.connectors.filter((x: any) => x.available && x.queryable).map((x: any) => x.name).join(', ')}.</div>
        <div className="row"><Link className="btn" href="/settings">Customise sources</Link><button className="btn primary" onClick={() => mark('configure_sources')}>Use defaults</button></div>
      </div>
    ) : <Loading />,
    constraints: (
      <div className="stack small">
        <div className="form-grid">
          <label className="field">Initial capital (USD)<input className="in" type="number" value={c.initialCapitalUsd} onChange={(e) => setC({ ...c, initialCapitalUsd: Number(e.target.value) })} /></label>
          <label className="field">Monthly budget (USD)<input className="in" type="number" value={c.monthlyBudgetUsd} onChange={(e) => setC({ ...c, monthlyBudgetUsd: Number(e.target.value) })} /></label>
          <label className="field">Hours per week<input className="in" type="number" value={c.hoursPerWeek} onChange={(e) => setC({ ...c, hoursPerWeek: Number(e.target.value) })} /></label>
          <label className="field">Risk tolerance<select className="in" value={c.riskTolerance} onChange={(e) => setC({ ...c, riskTolerance: e.target.value })}><option>low</option><option>medium</option><option>high</option></select></label>
        </div>
        <div><button className="btn primary" onClick={() => run(() => patch('/api/org', { constraints: c }))}>Save constraints</button></div>
      </div>
    ),
    industries: (
      <div className="row small">
        <input className="in" style={{ flex: 1 }} value={industries} onChange={(e) => setIndustries(e.target.value)} placeholder="e.g. accounting, e-commerce, developer tools" />
        <button className="btn primary" disabled={!industries.trim()} onClick={() => run(() => patch('/api/org', { industries: industries.split(',').map((s) => s.trim()).filter(Boolean) }))}>Save</button>
      </div>
    ),
    first_scan: (
      <div className="stack small">
        <div className="row">
          <input className="in" style={{ flex: 1 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={industries ? `e.g. ${industries.split(',')[0]} manual work` : 'e.g. invoice reconciliation for small firms'} />
          <button className="btn primary" disabled={!query.trim()} onClick={() => run(async () => setWf((await post('/api/opportunities/discover', { query })).workflowId))}>Run scan</button>
        </div>
        {wf && <WorkflowProgress workflowId={wf} onDone={() => { void org.reload(); void top.reload(); }} />}
      </div>
    ),
    hypotheses: (
      <div className="stack small">
        {!top.data?.items?.length ? <span className="muted">Run a scan first.</span> : (
          <>
            <div className="row">
              <select className="in" style={{ flex: 1 }} value={opp ?? ''} onChange={(e) => setPicked(e.target.value)}>
                {top.data.items.map((o: any) => <option key={o.id} value={o.id}>{o.score?.toFixed(2)} · {o.title}</option>)}
              </select>
              <button className="btn primary" onClick={() => run(async () => setWf((await post(`/api/opportunities/${opp}/analyze`)).workflowId))}>Analyze</button>
            </div>
            {wf && <WorkflowProgress workflowId={wf} onDone={() => void org.reload()} />}
          </>
        )}
      </div>
    ),
    select_opportunity: <div className="small">Open the opportunity, review the hypotheses and click <strong>Select for build</strong>. {opp && <Link href={`/opportunities/${opp}`}>Open opportunity →</Link>}</div>,
    generate_mvp: opp ? <div className="row small"><button className="btn primary" onClick={() => run(async () => setWf((await post(`/api/opportunities/${opp}/build`)).workflowId))}>Build MVP</button>{wf && <WorkflowProgress workflowId={wf} onDone={() => void org.reload()} />}</div> : null,
    launch_experiment: opp ? <div className="row small"><button className="btn primary" onClick={() => run(async () => setWf((await post(`/api/opportunities/${opp}/experiment`, { budgetUsd: 0 })).workflowId))}>Start $0 landing-page experiment</button><span className="muted">Paid budgets require approval.</span></div> : null,
    track_results: <div className="small">Open <Link href="/experiments">Experiments</Link> — the deployed MVP reports page views and signups automatically; decisions appear as data arrives.</div>,
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Getting started</h1>
          <div className="page-sub">From an empty workspace to a measured experiment. Steps complete automatically when the underlying work really happens.</div>
        </div>
        <span className="small muted">{steps.filter((s) => s.done).length} / {steps.length} done</span>
      </div>
      <ErrorBox error={err} />
      <div className="steps">
        {steps.map((s, i) => (
          <div key={s.step} className={`step ${s.done ? 'done' : ''} ${s.step === next ? 'current' : ''}`}>
            <div className="step-n">{s.done ? '✓' : i + 1}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row between"><h2>{TITLES[s.step]}</h2>{s.done && <StatusBadge status="good" label="done" />}</div>
              {(s.step === next || !s.done) && <div className="mt">{body[s.step]}</div>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
