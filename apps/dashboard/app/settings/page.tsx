'use client';

import { useEffect, useState } from 'react';
import { del, patch, post, put } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { ago, usd } from '@/lib/format';
import { useSession } from '@/components/providers';
import { Collapsible, Empty, ErrorBox, Loading, Panel, StatusBadge, Tabs, Pending } from '@/components/blocks';

type Tab = 'workspace' | 'ai' | 'sources' | 'policies' | 'secrets' | 'keys' | 'members' | 'demo';
const MODES = ['READ_ONLY', 'SIMULATE', 'REQUIRE_APPROVAL', 'AUTONOMOUS'];
const RANK: Record<string, number> = { READ_ONLY: 0, SIMULATE: 1, REQUIRE_APPROVAL: 2, AUTONOMOUS: 3 };

function useFlash() {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async <R,>(fn: () => Promise<R>, ok: string | ((r: R) => string)) => {
    setMsg(null);
    setErr(null);
    try {
      const r = await fn();
      setMsg(typeof ok === 'function' ? ok(r) : ok);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return { msg, err, run };
}

function WorkspaceTab() {
  const org = useApi<any>('/api/org');
  const f = useFlash();
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    if (org.data && !s) setS({ name: org.data.name, industries: (org.data.settings.industries ?? []).join(', '), aiDailyBudgetUsd: org.data.settings.aiDailyBudgetUsd ?? '', ...(org.data.settings.constraints ?? {}) });
  }, [org.data, s]);
  if (!s) return <Loading />;
  const save = () =>
    f.run(
      () =>
        patch('/api/org', {
          name: s.name,
          industries: String(s.industries).split(',').map((x: string) => x.trim()).filter(Boolean),
          aiDailyBudgetUsd: s.aiDailyBudgetUsd === '' ? undefined : Number(s.aiDailyBudgetUsd),
          constraints: { initialCapitalUsd: Number(s.initialCapitalUsd) || 0, monthlyBudgetUsd: Number(s.monthlyBudgetUsd) || 0, hoursPerWeek: Number(s.hoursPerWeek) || 0, riskTolerance: s.riskTolerance || 'medium' },
        }),
      'Saved.',
    );
  return (
    <Panel title="Workspace, constraints & industries">
      <div className="form-grid">
        <label className="field">Workspace name<input className="in" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></label>
        <label className="field">Initial capital (USD)<input className="in" type="number" value={s.initialCapitalUsd ?? ''} onChange={(e) => setS({ ...s, initialCapitalUsd: e.target.value })} /></label>
        <label className="field">Monthly budget (USD)<input className="in" type="number" value={s.monthlyBudgetUsd ?? ''} onChange={(e) => setS({ ...s, monthlyBudgetUsd: e.target.value })} /></label>
        <label className="field">Hours per week<input className="in" type="number" value={s.hoursPerWeek ?? ''} onChange={(e) => setS({ ...s, hoursPerWeek: e.target.value })} /></label>
        <label className="field">Risk tolerance<select className="in" value={s.riskTolerance ?? 'medium'} onChange={(e) => setS({ ...s, riskTolerance: e.target.value })}><option>low</option><option>medium</option><option>high</option></select></label>
        <label className="field">AI daily budget (USD)<input className="in" type="number" value={s.aiDailyBudgetUsd} onChange={(e) => setS({ ...s, aiDailyBudgetUsd: e.target.value })} placeholder="default from AI_DAILY_BUDGET_USD" /></label>
      </div>
      <label className="field mt">Industries of interest (comma separated — used for strategic fit and scheduled discovery)<input className="in" value={s.industries} onChange={(e) => setS({ ...s, industries: e.target.value })} /></label>
      <button className="btn primary mt" onClick={save}>Save</button>
      {f.msg && <span className="ok"> {f.msg}</span>}
      <ErrorBox error={f.err} />
    </Panel>
  );
}

function AiTab() {
  const providers = useApi<any>('/api/ai/providers');
  const usage = useApi<any>('/api/ai/usage');
  const pricing = useApi<any[]>('/api/ai/pricing');
  const f = useFlash();
  const [name, setName] = useState('ai.anthropic.api_key');
  const [value, setValue] = useState('');
  return (
    <div className="grid g2">
      <Panel title="Providers">
        {!providers.data ? <Pending q={providers} /> : (
          <>
            <div className={`banner ${providers.data.available ? 'good' : ''}`}>{providers.data.available ? `AI enabled via ${providers.data.configured.map((p: any) => p.name).join(', ')} (order: ${providers.data.providerOrder.join(' → ')}).` : providers.data.note}</div>
            {providers.data.configured.map((p: any) => (
              <div key={p.name} className="small"><strong>{p.name}</strong>: fast {p.models.fast} · balanced {p.models.balanced} · deep {p.models.deep}</div>
            ))}
            <div className="small muted mt">Keys: {Object.entries(providers.data.keys).map(([k, v]) => `${k} ${v ?? '—'}`).join(' · ')}</div>
          </>
        )}
        <h3 className="mt">Connect a provider</h3>
        <div className="row mt">
          <select className="in" style={{ width: 220 }} value={name} onChange={(e) => setName(e.target.value)}>
            <option value="ai.anthropic.api_key">Anthropic API key</option>
            <option value="ai.openai.api_key">OpenAI API key</option>
            <option value="ai.google.api_key">Google Gemini API key</option>
            <option value="ai.ollama.base_url">Ollama base URL (local)</option>
          </select>
          <input className="in" style={{ flex: 1 }} type="password" autoComplete="off" placeholder={name.includes('ollama') ? 'http://127.0.0.1:11434' : 'paste key — stored encrypted (AES-256-GCM)'} value={value} onChange={(e) => setValue(e.target.value)} />
          <button className="btn primary" disabled={!value} onClick={() => f.run(async () => { await put('/api/secrets', { name, value }); setValue(''); await providers.reload(); }, 'Saved (encrypted).')}>Save</button>
        </div>
        {f.msg && <div className="ok">{f.msg}</div>}
        <ErrorBox error={f.err} />
        <div className="tiny muted mt">Keys can also be set via environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, OLLAMA_BASE_URL). Workspace keys override environment keys.</div>
      </Panel>
      <Panel title="Usage & cost (30 days)">
        {!usage.data ? <Pending q={usage} /> : (
          <>
            <div className="small">Today: <strong>{usd(usage.data.spentTodayUsd, { cents: true })}</strong> of {usd(usage.data.dailyBudgetUsd)} daily budget</div>
            <div className="meter mt"><span style={{ width: `${Math.min(100, (usage.data.spentTodayUsd / Math.max(0.01, usage.data.dailyBudgetUsd)) * 100)}%` }} /></div>
            {!usage.data.last30Days.length ? <Empty>No model calls yet.</Empty> : (
              <table className="t mt">
                <thead><tr><th>Model</th><th className="r">Calls</th><th className="r">Tokens in/out</th><th className="r">Cost</th><th className="r">Latency</th><th className="r">Invalid / errors</th></tr></thead>
                <tbody>{usage.data.last30Days.map((m: any) => <tr key={`${m.provider}/${m.model}`}><td className="small">{m.provider}/{m.model}</td><td className="r">{m.calls}</td><td className="r">{m.input_tokens}/{m.output_tokens}</td><td className="r">{usd(Number(m.cost_usd), { cents: true })}</td><td className="r">{m.avg_latency_ms} ms</td><td className="r">{m.invalid}/{m.errors}</td></tr>)}</tbody>
              </table>
            )}
          </>
        )}
        <div className="mt">
          <Collapsible label="Pricing table (USD per million tokens — editable)">
            {!pricing.data ? <Pending q={pricing} /> : (
              <table className="t">
                <thead><tr><th>Model</th><th>Tier</th><th className="r">Input</th><th className="r">Output</th><th>Source</th></tr></thead>
                <tbody>{pricing.data.map((p) => <tr key={`${p.provider}/${p.model}`}><td className="small">{p.provider}/{p.model}</td><td>{p.tier}</td><td className="r">{p.input_per_mtok_usd}</td><td className="r">{p.output_per_mtok_usd}</td><td className="tiny muted">{p.source_note}{p.user_override ? ' (overridden)' : ''}</td></tr>)}</tbody>
              </table>
            )}
          </Collapsible>
        </div>
      </Panel>
    </div>
  );
}

function SourcesTab() {
  const src = useApi<any>('/api/sources');
  const f = useFlash();
  const [cfg, setCfg] = useState({ connector: 'rss', name: 'my-feeds', urls: '' });
  const [ds, setDs] = useState({ name: 'my-dataset', csv: 'title,text,url,date,points\n' });
  if (!src.data) return <Pending q={src} />;
  const rows = src.data.sources as any[];
  return (
    <div className="stack">
      <Panel title="Connectors" flush>
        <table className="t">
          <thead><tr><th>Connector</th><th>Signals</th><th>Availability</th><th>Terms</th></tr></thead>
          <tbody>{src.data.connectors.map((c: any) => (
            <tr key={c.id}><td><strong>{c.name}</strong><div className="tiny muted">{c.description}</div></td><td className="tiny">{c.signalTypes.join(', ')}</td><td>{c.available ? <StatusBadge status="good" label="available" /> : <StatusBadge status="warning" label={`needs ${c.missing.join(', ')}`} />}</td><td className="tiny muted" style={{ maxWidth: 320 }}>{c.terms}</td></tr>
          ))}</tbody>
        </table>
      </Panel>
      <Panel title="Configured sources" flush>
        {!rows.length ? <Empty>No sources yet.</Empty> : (
          <table className="t">
            <thead><tr><th>Source</th><th>Enabled</th><th>Last run</th><th className="r">Docs fetched</th><th className="r">Quality (learned)</th><th /></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id}><td>{s.connector} / {s.name}{s.has_dataset ? <span className="badge">dataset</span> : null}</td><td>{s.enabled ? 'yes' : 'no'}</td><td className="small">{s.last_run_at ? ago(s.last_run_at) : 'never'} {s.last_status && <StatusBadge status={s.last_status === 'ok' ? 'good' : 'critical'} label={s.last_status} />}<div className="tiny muted">{s.last_error ?? ''}</div></td><td className="r">{s.documents_fetched}</td><td className="r">{s.quality_score === null ? '—' : s.quality_score.toFixed(2)}</td>
                <td><button className="btn sm" onClick={() => f.run(async () => { await patch(`/api/sources/${s.id}`, { enabled: !s.enabled }); await src.reload(); }, 'Updated.')}>{s.enabled ? 'Disable' : 'Enable'}</button></td></tr>
            ))}</tbody>
          </table>
        )}
      </Panel>
      <div className="grid g2">
        <Panel title="Add feeds or web pages">
          <div className="form-grid">
            <label className="field">Connector<select className="in" value={cfg.connector} onChange={(e) => setCfg({ ...cfg, connector: e.target.value })}><option value="rss">RSS / Atom feeds</option><option value="web_page">Web pages (robots.txt-aware)</option></select></label>
            <label className="field">Name<input className="in" value={cfg.name} onChange={(e) => setCfg({ ...cfg, name: e.target.value })} /></label>
          </div>
          <label className="field mt">URLs (one per line; public http(s) only — private networks are blocked)<textarea className="in" rows={4} value={cfg.urls} onChange={(e) => setCfg({ ...cfg, urls: e.target.value })} /></label>
          <button className="btn mt" onClick={() => f.run(async () => { await post('/api/sources', { connector: cfg.connector, name: cfg.name, enabled: true, config: { urls: cfg.urls.split(/\s+/).filter(Boolean) } }); await src.reload(); }, 'Source saved.')}>Save source</button>
        </Panel>
        <Panel title="Upload a dataset (USER INPUT)">
          <label className="field">Name<input className="in" value={ds.name} onChange={(e) => setDs({ ...ds, name: e.target.value })} /></label>
          <label className="field mt">CSV (title, text, url, date, points)<textarea className="in" rows={5} value={ds.csv} onChange={(e) => setDs({ ...ds, csv: e.target.value })} /></label>
          <button className="btn mt" onClick={() => f.run(async () => { await post('/api/sources/dataset', ds); await src.reload(); }, 'Dataset uploaded.')}>Upload</button>
        </Panel>
      </div>
      {f.msg && <div className="ok">{f.msg}</div>}
      <ErrorBox error={f.err} />
    </div>
  );
}

function PoliciesTab() {
  const pol = useApi<any[]>('/api/policies', { refreshOn: ['approval.'] });
  const f = useFlash();
  const setMode = (p: any, mode: string) =>
    f.run(
      async () => {
        const r = await put<{ applied: boolean; approvalId?: string }>('/api/policies', { action: p.action, mode });
        await pol.reload();
        return r;
      },
      (r) => (r.applied ? `${p.action} → ${mode} (applied immediately).` : `Relaxing ${p.action} needs approval — request ${r.approvalId} is waiting in the approval center.`),
    );
  return (
    <Panel title="Action policies" flush>
      <div className="panel-body">
        <div className="small secondary">READ_ONLY · SIMULATE (paper ledger) · REQUIRE_APPROVAL · AUTONOMOUS. Tightening applies immediately; relaxing creates an approval request. Hard ceilings cannot be exceeded: money movement is capped at REQUIRE_APPROVAL, trading at SIMULATE.</div>
        {f.msg && <div className="ok mt">{f.msg}</div>}
        <ErrorBox error={f.err} />
      </div>
      {!pol.data ? <Pending q={pol} /> : (
        <table className="t">
          <thead><tr><th>Action</th><th>Category / risk</th><th>Mode</th><th>Ceiling</th><th>Limits</th></tr></thead>
          <tbody>{pol.data.map((p) => (
            <tr key={p.action}>
              <td><span className="mono small">{p.action}</span><div className="tiny muted">{p.description}</div></td>
              <td className="small">{p.category} · <StatusBadge status={p.risk === 'critical' ? 'critical' : p.risk === 'high' ? 'serious' : p.risk === 'medium' ? 'warning' : 'good'} label={p.risk} /></td>
              <td>
                <select className="in" style={{ width: 190 }} value={p.mode} onChange={(e) => setMode(p, e.target.value)}>
                  {MODES.filter((m) => RANK[m]! <= RANK[p.maxMode]!).map((m) => <option key={m}>{m}</option>)}
                </select>
                {p.source === 'default' && <div className="tiny muted">default</div>}
              </td>
              <td className="small">{p.maxMode}</td>
              <td className="tiny">{Object.keys(p.limits ?? {}).length ? JSON.stringify(p.limits) : '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Panel>
  );
}

function SecretsTab() {
  const list = useApi<any[]>('/api/secrets');
  const f = useFlash();
  const [name, setName] = useState('billing.stripe.secret_key');
  const [value, setValue] = useState('');
  return (
    <Panel title="Encrypted secrets">
      <div className="small secondary">Values are encrypted with AES-256-GCM (bound to this workspace) and never returned — only a masked hint. Use a Stripe <strong>restricted, read-only</strong> key; ROOS only reads payments, and creating payment links is approval-gated.</div>
      <div className="row mt">
        <select className="in" style={{ width: 260 }} value={name} onChange={(e) => setName(e.target.value)}>
          {['billing.stripe.secret_key', 'billing.stripe.webhook_secret', 'connector.github.token', 'connector.brave.api_key', 'connector.stackexchange.key', 'email.resend.api_key', 'ai.anthropic.api_key', 'ai.openai.api_key', 'ai.google.api_key', 'ai.ollama.base_url'].map((n) => <option key={n}>{n}</option>)}
        </select>
        <input className="in" style={{ flex: 1 }} type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" />
        <button className="btn primary" disabled={!value} onClick={() => f.run(async () => { await put('/api/secrets', { name, value }); setValue(''); await list.reload(); }, 'Saved.')}>Save</button>
      </div>
      {f.msg && <div className="ok">{f.msg}</div>}
      <ErrorBox error={f.err} />
      {!list.data ? <Pending q={list} /> : !list.data.length ? <Empty>No secrets stored.</Empty> : (
        <table className="t mt">
          <thead><tr><th>Name</th><th>Hint</th><th>Key id</th><th>Updated</th><th /></tr></thead>
          <tbody>{list.data.map((s) => <tr key={s.name}><td className="mono small">{s.name}</td><td>{s.hint}</td><td className="mono tiny">{s.key_id}</td><td className="small muted">{ago(s.updated_at)}</td><td><button className="btn sm danger" onClick={() => f.run(async () => { await del(`/api/secrets/${s.name}`); await list.reload(); }, 'Deleted.')}>Delete</button></td></tr>)}</tbody>
        </table>
      )}
    </Panel>
  );
}

function KeysTab() {
  const keys = useApi<any[]>('/api/api-keys');
  const f = useFlash();
  const [name, setName] = useState('cli');
  const [role, setRole] = useState('operator');
  const [created, setCreated] = useState<string | null>(null);
  return (
    <Panel title="API keys (for the CLI and automation)">
      <div className="row">
        <input className="in" style={{ width: 200 }} value={name} onChange={(e) => setName(e.target.value)} />
        <select className="in" style={{ width: 160 }} value={role} onChange={(e) => setRole(e.target.value)}>{['viewer', 'analyst', 'operator', 'admin', 'owner'].map((r) => <option key={r}>{r}</option>)}</select>
        <button className="btn primary" onClick={() => f.run(async () => { const k = await post('/api/api-keys', { name, role }); setCreated(k.key); await keys.reload(); }, 'Key created.')}>Create key</button>
      </div>
      {created && <div className="banner good mt">Copy this key now — it is shown only once: <code>{created}</code><div className="tiny muted">Use it with <code>ROOS_API_KEY=… npm run roos -- /status</code></div></div>}
      <ErrorBox error={f.err} />
      {!keys.data ? <Pending q={keys} /> : (
        <table className="t mt">
          <thead><tr><th>Name</th><th>Prefix</th><th>Role</th><th>Last used</th><th>Status</th><th /></tr></thead>
          <tbody>{keys.data.map((k) => <tr key={k.id}><td>{k.name}</td><td className="mono small">{k.prefix}…</td><td>{k.role}</td><td className="small muted">{k.last_used_at ? ago(k.last_used_at) : 'never'}</td><td>{k.revoked_at ? <StatusBadge status="neutral" label="revoked" /> : <StatusBadge status="good" label="active" />}</td><td>{!k.revoked_at && <button className="btn sm danger" onClick={() => f.run(async () => { await del(`/api/api-keys/${k.id}`); await keys.reload(); }, 'Revoked.')}>Revoke</button>}</td></tr>)}</tbody>
        </table>
      )}
    </Panel>
  );
}

function MembersTab() {
  const members = useApi<any[]>('/api/members');
  const f = useFlash();
  const [m, setM] = useState({ email: '', name: '', role: 'viewer', password: '' });
  return (
    <Panel title="Members & roles">
      {!members.data ? <Pending q={members} /> : (
        <table className="t">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last login</th></tr></thead>
          <tbody>{members.data.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td className="small muted">{u.last_login_at ? ago(u.last_login_at) : 'never'}</td></tr>)}</tbody>
        </table>
      )}
      <h3 className="mt">Add member</h3>
      <div className="form-grid mt">
        <label className="field">Email<input className="in" value={m.email} onChange={(e) => setM({ ...m, email: e.target.value })} /></label>
        <label className="field">Name<input className="in" value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} /></label>
        <label className="field">Role<select className="in" value={m.role} onChange={(e) => setM({ ...m, role: e.target.value })}>{['viewer', 'analyst', 'operator', 'admin'].map((r) => <option key={r}>{r}</option>)}</select></label>
        <label className="field">Initial password (12+)<input className="in" type="password" value={m.password} onChange={(e) => setM({ ...m, password: e.target.value })} /></label>
      </div>
      <button className="btn mt" onClick={() => f.run(async () => { await post('/api/members', m); await members.reload(); }, 'Member added.')}>Add</button>
      {f.msg && <span className="ok"> {f.msg}</span>}
      <ErrorBox error={f.err} />
      <div className="tiny muted mt">Roles: owner (everything) · admin (all but members) · operator (run agents, build, deploy, experiments, outreach drafts; cannot approve) · analyst (research) · viewer (read-only).</div>
    </Panel>
  );
}

function DemoTab() {
  const { refresh } = useSession();
  const f = useFlash();
  return (
    <Panel title="Demo workspace">
      <p className="secondary">The demo workspace is filled with synthetic data, clearly labelled DEMO DATA everywhere. It is a separate tenant: the database stamps every row with <code>is_demo</code>, demo revenue can never be marked verified, and nothing from it touches your real workspace.</p>
      <button className="btn" onClick={() => f.run(async () => { await post('/api/demo/seed', { reset: true }); await refresh(); }, 'Demo workspace reset with fresh synthetic data.')}>Reset demo workspace</button>
      {f.msg && <div className="ok mt">{f.msg}</div>}
      <ErrorBox error={f.err} />
    </Panel>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('workspace');
  return (
    <>
      <div className="page-head"><div><h1>Settings</h1><div className="page-sub">Workspace constraints, AI providers, data sources, action policies, secrets, API keys and members.</div></div></div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'workspace', label: 'Workspace' },
          { id: 'ai', label: 'AI providers' },
          { id: 'sources', label: 'Data sources' },
          { id: 'policies', label: 'Policies' },
          { id: 'secrets', label: 'Secrets' },
          { id: 'keys', label: 'API keys' },
          { id: 'members', label: 'Members' },
          { id: 'demo', label: 'Demo data' },
        ]}
      />
      {tab === 'workspace' && <WorkspaceTab />}
      {tab === 'ai' && <AiTab />}
      {tab === 'sources' && <SourcesTab />}
      {tab === 'policies' && <PoliciesTab />}
      {tab === 'secrets' && <SecretsTab />}
      {tab === 'keys' && <KeysTab />}
      {tab === 'members' && <MembersTab />}
      {tab === 'demo' && <DemoTab />}
    </>
  );
}
