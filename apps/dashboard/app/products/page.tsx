'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { get, post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { dateTime } from '@/lib/format';
import { Collapsible, Empty, ErrorBox, Loading, Panel, StatusBadge, Pending } from '@/components/blocks';

function ProjectView({ id }: { id: string }) {
  const p = useApi<any>(`/api/projects/${id}`, { refreshOn: ['project.', 'deployment.'] });
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = async (path: string) => {
    try {
      setFile(await get(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    setFile(null);
  }, [id]);
  const deploy = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/projects/${id}/deploy`, {});
      await p.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const production = async () => {
    try {
      await post(`/api/projects/${id}/production`, {});
      setErr(null);
      alert('Production deployment requested — approve it in the approval center.');
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (!p.data) return <Pending q={p} />;
  const d = p.data;
  const run = d.sandboxRuns?.[0];
  return (
    <Panel title={`Project: ${d.name}`} actions={<div className="row"><button className="btn sm primary" onClick={deploy} disabled={busy}>{busy ? <span className="spin" /> : null} Deploy local preview</button><button className="btn sm" onClick={production}>Request production deploy</button></div>}>
      <ErrorBox error={err} />
      <div className="row small"><StatusBadge status={d.status} /><span className="muted">{d.generatorVersion} · {dateTime(d.createdAt)} · <code>{d.path}</code></span></div>
      <div className="grid g2 mt">
        <div>
          <h3>Security scan</h3>
          <div className="small">{d.scanResult?.passed ? <StatusBadge status="good" label="passed" /> : <StatusBadge status="critical" label="failed" />} {d.scanResult?.findings?.length ?? 0} findings · dependencies: none (allow-list enforced)</div>
          {(d.scanResult?.findings ?? []).slice(0, 10).map((f: any, i: number) => <div key={i} className="tiny muted">{f.severity}: {f.file}:{f.line} {f.message}</div>)}
          <h3 className="mt">Sandbox test run</h3>
          {run ? (
            <>
              <div className="small">{run.status === 'passed' ? <StatusBadge status="good" label="passed" /> : <StatusBadge status="critical" label={run.status} />} {run.driver} · {run.durationMs} ms · exit {run.exitCode}</div>
              <div className="tiny muted">Isolation: {(run.limits?.isolation ?? []).join(' · ')}</div>
              <Collapsible label="Test output"><pre className="code-view">{run.stdout || run.stderr}</pre></Collapsible>
            </>
          ) : <div className="small muted">{d.testResult?.reason ?? 'Not executed.'}</div>}
        </div>
        <div>
          <h3>Files</h3>
          <div className="stack small">
            {(d.manifest ?? []).map((f: any) => (
              <button key={f.path} className="linkbtn" style={{ textAlign: 'left' }} onClick={() => open(f.path)}>{f.path} <span className="muted">({f.bytes} B)</span></button>
            ))}
          </div>
        </div>
      </div>
      {file && (
        <div className="mt">
          <div className="row between"><strong className="mono small">{file.path}</strong><button className="btn sm ghost" onClick={() => setFile(null)}>Close</button></div>
          <pre className="code-view">{file.content}</pre>
        </div>
      )}
    </Panel>
  );
}

function ProductsInner() {
  const params = useSearchParams();
  const products = useApi<any[]>('/api/products', { refreshOn: ['project.', 'deployment.', 'tracking.'] });
  const projects = useApi<any[]>('/api/projects', { refreshOn: ['project.'] });
  const deployments = useApi<any[]>('/api/deployments', { refreshOn: ['deployment.'] });
  const [selected, setSelected] = useState<string | null>(params.get('project'));
  const [err, setErr] = useState<string | null>(null);
  const stop = async (id: string) => {
    try {
      await post(`/api/deployments/${id}/stop`, {});
      await deployments.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Products & MVPs</h1>
          <div className="page-sub">Runnable MVPs generated from vetted templates (zero dependencies), statically scanned, tested inside the sandbox, and deployable as local previews. Production deployment is approval-gated.</div>
        </div>
      </div>
      <ErrorBox error={err} />
      <div className="grid g2">
        <Panel title="Products" flush>
          {!products.data ? <Pending q={products} /> : !products.data.length ? <Empty>No products yet — build an MVP from an analysed opportunity.</Empty> : (
            <table className="t">
              <thead><tr><th>Product</th><th>Status</th><th className="r">Visitors 30d</th><th>URL</th></tr></thead>
              <tbody>{products.data.map((p) => (
                <tr key={p.id}><td>{p.name}<div className="tiny muted">write key <code>{p.writeKey}</code></div></td><td><StatusBadge status={p.status} /></td><td className="r">{p.visitors30d}</td><td className="small">{p.url ? <a href={p.url} target="_blank" rel="noopener noreferrer">{p.url}</a> : '—'}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Panel>
        <Panel title="Deployments" flush>
          {!deployments.data ? <Pending q={deployments} /> : !deployments.data.length ? <Empty>No deployments.</Empty> : (
            <table className="t">
              <thead><tr><th>Environment</th><th>Status</th><th>URL</th><th>Started</th><th /></tr></thead>
              <tbody>{deployments.data.map((d) => (
                <tr key={d.id}><td>{d.environment} · {d.driver}</td><td><StatusBadge status={d.status} /></td><td className="small">{d.url ? <a href={d.url} target="_blank" rel="noopener noreferrer">{d.url}</a> : d.status === 'pending_manual' ? <Collapsible label="Checklist"><pre className="code-view" style={{ whiteSpace: 'pre-wrap' }}>{d.logs}</pre></Collapsible> : '—'}</td><td className="small muted">{dateTime(d.startedAt ?? d.createdAt)}</td><td>{d.status === 'running' && <button className="btn sm" onClick={() => stop(d.id)}>Stop</button>}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Panel>
      </div>
      <Panel title="Generated projects" className="mt2" flush>
        {!projects.data ? <Pending q={projects} /> : !projects.data.length ? <Empty>No generated projects. Run <code>/build &lt;opportunity-id&gt;</code>.</Empty> : (
          <table className="t">
            <thead><tr><th>Project</th><th>Status</th><th>Scan</th><th>Tests</th><th>Opportunity</th><th>Created</th></tr></thead>
            <tbody>{projects.data.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => setSelected(p.id)}><td>{p.name}</td><td><StatusBadge status={p.status} /></td><td>{p.scanResult?.passed ? '✓ passed' : '✕ failed'}</td><td>{p.testResult?.status}</td><td className="small"><Link href={`/opportunities/${p.opportunityId}`} onClick={(e) => e.stopPropagation()}>{p.opportunityId}</Link></td><td className="small muted">{dateTime(p.createdAt)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Panel>
      {selected && <div className="mt2"><ProjectView id={selected} /></div>}
    </>
  );
}

export default function ProductsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ProductsInner />
    </Suspense>
  );
}
