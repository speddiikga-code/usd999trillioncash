'use client';

import Link from 'next/link';
import { useState } from 'react';
import { get, post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { ago, dateTime } from '@/lib/format';
import { useSession } from '@/components/providers';
import { Collapsible, Empty, ErrorBox, Loading, Panel, StatusBadge, Tabs, Pending } from '@/components/blocks';

type Tab = 'leads' | 'campaigns' | 'import';

export default function LeadsPage() {
  const { session } = useSession();
  const [tab, setTab] = useState<Tab>('leads');
  const [q, setQ] = useState('');
  const leads = useApi<any[]>(`/api/leads${q ? `?q=${encodeURIComponent(q)}` : ''}`, { refreshOn: ['lead.'] });
  const campaigns = useApi<any[]>('/api/campaigns', { refreshOn: ['campaign.'] });
  const [openCampaign, setOpenCampaign] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [lf, setLf] = useState({ name: '', email: '', company: '', title: '', consentBasis: 'opt_in' });
  const [csv, setCsv] = useState('name,email,company,title,consent\n');
  const [cf, setCf] = useState({ name: '', subjectTemplate: 'Quick question, {{first_name}}', bodyTemplate: 'Hi {{first_name}},\n\n…\n\n{{sender}}', minLeadScore: 0 });

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setErr(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      void leads.reload();
      void campaigns.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const exportLeads = async () => {
    setErr(null);
    try {
      const res = await fetch('/api/leads/export', { headers: { 'x-org-id': session!.org.orgId }, credentials: 'same-origin' });
      if (res.status === 202) {
        const j = await res.json();
        setMsg(`Exporting personal data requires approval (${j.approvalId}). Approve it in the approval center, then export again within an hour.`);
        return;
      }
      if (!res.ok) throw new Error((await res.json()).error?.message ?? 'Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'leads.csv';
      a.click();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads & outreach</h1>
          <div className="page-sub">
            Leads come only from permitted sources: inbound signups (consented), imported lists that declare a consent basis, and manual entry. Leads with an <strong>unknown</strong> consent basis are never contacted. Every message carries an unsubscribe link and postal address; sending requires approval.
          </div>
        </div>
        <button className="btn" onClick={exportLeads}>Export CSV</button>
      </div>
      <ErrorBox error={err} />
      {msg && <div className="banner good">{msg}</div>}
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'leads', label: `Leads (${leads.data?.length ?? '…'})` }, { id: 'campaigns', label: `Campaigns (${campaigns.data?.length ?? '…'})` }, { id: 'import', label: 'Add / import' }]} />

      {tab === 'leads' && (
        <>
          <input className="in" style={{ maxWidth: 320, marginBottom: 8 }} placeholder="Search name, company, email" value={q} onChange={(e) => setQ(e.target.value)} />
          <Panel flush>
            {!leads.data ? <Pending q={leads} /> : !leads.data.length ? <Empty>No leads yet. Signups on launched products appear here automatically.</Empty> : (
              <div className="table-wrap">
                <table className="t">
                  <thead><tr><th>Lead</th><th>Company / title</th><th>Consent</th><th>Status</th><th className="r">Score</th><th>Score factors</th><th>Source</th><th>Added</th></tr></thead>
                  <tbody>{leads.data.map((l) => (
                    <tr key={l.id}>
                      <td>{l.name}<div className="tiny muted">{l.email ?? 'no email'}</div></td>
                      <td className="small">{l.company}<div className="tiny muted">{l.title}</div></td>
                      <td><StatusBadge status={l.consentBasis} label={l.consentBasis.replace('_', ' ')} /></td>
                      <td><StatusBadge status={l.status} /></td>
                      <td className="r">{l.score}</td>
                      <td className="tiny muted" style={{ maxWidth: 300 }}>{(l.scoreBreakdown?.breakdown ?? []).map((b: any) => `${b.reason}${b.points ? ` (+${b.points})` : ''}`).join(' · ')}</td>
                      <td className="small">{l.source}</td>
                      <td className="small muted">{ago(l.createdAt)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      {tab === 'campaigns' && (
        <div className="grid g2">
          <Panel title="Campaigns" flush>
            {!campaigns.data?.length ? <Empty>No campaigns. Run <code>/growth &lt;opportunity-id&gt;</code> or create one below.</Empty> : campaigns.data.map((c) => (
              <div key={c.id} className="list-item">
                <div className="row between"><button className="linkbtn" onClick={() => get(`/api/campaigns/${c.id}`).then(setOpenCampaign)}>{c.name}</button><StatusBadge status={c.status} /></div>
                <div className="tiny muted">{c.stats?.drafted ?? 0} drafted · skipped {JSON.stringify(c.stats?.skipped ?? {})} {c.stats?.send ? `· sent ${c.stats.send.sent}, not delivered ${c.stats.send.notDelivered} (${c.stats.driver})` : ''} · {dateTime(c.createdAt)}</div>
              </div>
            ))}
            <div className="panel-body">
              <Collapsible label="New campaign (drafts only — nothing is sent)">
                <div className="form-grid">
                  <label className="field">Name<input className="in" value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} /></label>
                  <label className="field">Min lead score<input className="in" type="number" value={cf.minLeadScore} onChange={(e) => setCf({ ...cf, minLeadScore: Number(e.target.value) })} /></label>
                </div>
                <label className="field mt">Subject<input className="in" value={cf.subjectTemplate} onChange={(e) => setCf({ ...cf, subjectTemplate: e.target.value })} /></label>
                <label className="field mt">Body (merge fields: {'{{first_name}} {{name}} {{company}} {{product}} {{sender}}'})<textarea className="in" rows={6} value={cf.bodyTemplate} onChange={(e) => setCf({ ...cf, bodyTemplate: e.target.value })} /></label>
                <button className="btn mt" disabled={!cf.name} onClick={() => act(() => post('/api/campaigns', cf), 'Campaign drafted.')}>Draft campaign</button>
              </Collapsible>
            </div>
          </Panel>
          <Panel title={openCampaign ? openCampaign.name : 'Campaign detail'} actions={openCampaign?.status === 'draft' ? <button className="btn primary sm" onClick={() => act(() => post(`/api/campaigns/${openCampaign.id}/send`).then(() => get(`/api/campaigns/${openCampaign.id}`).then(setOpenCampaign)), 'Send requested — approve it in the approval center.')}>Request send</button> : null}>
            {!openCampaign ? <Empty>Select a campaign to preview its messages.</Empty> : (
              <>
                <div className="row"><StatusBadge status={openCampaign.status} />{openCampaign.approvalId && <Link href="/approvals" className="small">approval {openCampaign.approvalId}</Link>}</div>
                {openCampaign.messages.slice(0, 20).map((m: any) => (
                  <div key={m.id} className="list-item" style={{ paddingLeft: 0 }}>
                    <div className="row small"><StatusBadge status={m.status === 'drafted' ? 'draft' : m.status} label={m.status} /> <strong>{m.toAddress}</strong> — {m.subject}</div>
                    {m.error && <div className="tiny muted">{m.error}</div>}
                    <Collapsible label="Body"><pre className="code-view" style={{ whiteSpace: 'pre-wrap' }}>{m.body}</pre></Collapsible>
                  </div>
                ))}
              </>
            )}
          </Panel>
        </div>
      )}

      {tab === 'import' && (
        <div className="grid g2">
          <Panel title="Add a lead">
            <div className="form-grid">
              <label className="field">Name<input className="in" value={lf.name} onChange={(e) => setLf({ ...lf, name: e.target.value })} /></label>
              <label className="field">Email<input className="in" value={lf.email} onChange={(e) => setLf({ ...lf, email: e.target.value })} /></label>
              <label className="field">Company<input className="in" value={lf.company} onChange={(e) => setLf({ ...lf, company: e.target.value })} /></label>
              <label className="field">Title<input className="in" value={lf.title} onChange={(e) => setLf({ ...lf, title: e.target.value })} /></label>
              <label className="field">Consent basis<select className="in" value={lf.consentBasis} onChange={(e) => setLf({ ...lf, consentBasis: e.target.value })}>{['inbound', 'opt_in', 'existing_customer', 'legitimate_interest', 'unknown'].map((c) => <option key={c}>{c}</option>)}</select></label>
            </div>
            <button className="btn mt" disabled={!lf.name} onClick={() => act(() => post('/api/leads', { ...lf, email: lf.email || undefined, company: lf.company || undefined, title: lf.title || undefined, source: 'manual' }), 'Lead added.')}>Add lead</button>
          </Panel>
          <Panel title="Import CSV (columns: name, email, company, title, consent)">
            <textarea className="in" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} />
            <div className="small muted mt">Rows without a valid consent value are imported as <strong>unknown</strong> and will never be contacted.</div>
            <button className="btn mt" onClick={() => act(() => post('/api/leads/import', { csv, source: 'csv_import', defaultConsentBasis: 'unknown' }), 'Import finished.')}>Import</button>
          </Panel>
        </div>
      )}
    </>
  );
}
