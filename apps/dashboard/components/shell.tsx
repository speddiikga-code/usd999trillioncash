'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, get, post } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useEvents, useSession } from './providers';
import { StatusBadge } from './ui';

const NAV: { group: string; items: { href: string; label: string; badge?: 'approvals' }[] }[] = [
  { group: 'Operate', items: [{ href: '/', label: 'Command center' }, { href: '/approvals', label: 'Approvals', badge: 'approvals' }, { href: '/agents', label: 'Agents & tasks' }] },
  { group: 'Discover', items: [{ href: '/opportunities', label: 'Opportunities' }, { href: '/graph', label: 'Knowledge graph' }] },
  { group: 'Build & test', items: [{ href: '/products', label: 'Products & MVPs' }, { href: '/experiments', label: 'Experiments' }, { href: '/leads', label: 'Leads & outreach' }] },
  { group: 'Measure', items: [{ href: '/revenue', label: 'Revenue' }, { href: '/portfolio', label: 'Portfolio' }, { href: '/roadmap', label: 'Quadrillion roadmap' }, { href: '/reports', label: 'Reports' }] },
  { group: 'Govern', items: [{ href: '/audit', label: 'Audit log' }, { href: '/settings', label: 'Settings' }, { href: '/onboarding', label: 'Getting started' }] },
];

function ThemeToggle() {
  const [theme, setTheme] = useState<string | null>(null);
  useEffect(() => {
    try {
      setTheme(localStorage.getItem('roos_theme'));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
    try {
      if (theme) localStorage.setItem('roos_theme', theme);
      else localStorage.removeItem('roos_theme');
    } catch {
      /* ignore */
    }
  }, [theme]);
  const next = theme === null ? 'dark' : theme === 'dark' ? 'light' : null;
  return (
    <button className="btn ghost sm" onClick={() => setTheme(next)} title="Theme: system → dark → light">
      {theme === null ? '◐ System' : theme === 'dark' ? '● Dark' : '○ Light'}
    </button>
  );
}

interface CommandResult {
  command: string;
  message: string;
  workflowId?: string;
  tasks?: { id: string; agent: string; kind: string }[];
}

function CommandBar() {
  const [value, setValue] = useState('');
  const [result, setResult] = useState<CommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wf, setWf] = useState<{ tasks: { id: string; agent: string; kind: string; status: string; error?: string }[] } | null>(null);
  const history = useRef<string[]>([]);
  const hIdx = useRef(-1);
  const { subscribe } = useEvents();

  useEffect(() => {
    if (!result?.workflowId) return;
    const load = () => get(`/api/workflows/${result.workflowId}`).then(setWf).catch(() => undefined);
    void load();
    const off = subscribe((e) => e.type.startsWith('task.') && void load());
    return () => {
      off();
    };
  }, [result?.workflowId, subscribe]);

  const run = async () => {
    const cmd = value.trim();
    if (!cmd) return;
    setBusy(true);
    setError(null);
    setWf(null);
    history.current.unshift(cmd);
    hIdx.current = -1;
    try {
      setResult(await post<CommandResult>('/api/commands', { command: cmd.startsWith('/') ? cmd : `/research "${cmd.replace(/"/g, '')}"` }));
      setValue('');
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="cmd">
        <span className="muted mono">›</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
            if (e.key === 'Escape') {
              setResult(null);
              setError(null);
            }
            if (e.key === 'ArrowUp' && history.current.length) {
              hIdx.current = Math.min(history.current.length - 1, hIdx.current + 1);
              setValue(history.current[hIdx.current]!);
            }
          }}
          placeholder='/research "find underserved B2B AI opportunities"   ·   /status   ·   /help'
          aria-label="Command"
          spellCheck={false}
        />
        {busy ? <span className="spin" /> : <span className="cmd-hint">Enter to run</span>}
      </div>
      {(result || error) && (
        <div className="cmd-result" role="status">
          <div className="row between">
            <strong className="mono small">{result ? `/${result.command}` : 'error'}</strong>
            <button className="btn ghost sm" onClick={() => (setResult(null), setError(null))}>
              Close
            </button>
          </div>
          {error && <div className="err mt">{error}</div>}
          {result && <pre className="mt small">{result.message}</pre>}
          {wf && (
            <div className="mt stack">
              {wf.tasks.map((t) => (
                <div key={t.id} className="row small">
                  <StatusBadge status={t.status} />
                  <span className="mono">{t.agent}</span>
                  <span className="muted mono">{t.kind}</span>
                  {t.status === 'waiting_approval' && <Link href="/approvals">Review approval →</Link>}
                  {t.error && <span className="err">{t.error.slice(0, 140)}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { session, switchOrg } = useSession();
  const { connected } = useEvents();
  const pending = useApi<{ id: string }[]>(session ? '/api/approvals?status=pending' : null, { refreshOn: ['approval.'] });
  if (!session) return <>{children}</>;
  const org = session.org;
  const logout = async () => {
    await post('/api/auth/logout').catch(() => undefined);
    router.replace('/login');
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            <div className="brand-name">ROOS</div>
            <div className="brand-sub">Revenue Opportunity OS</div>
          </div>
        </div>
        {NAV.map((g) => (
          <div key={g.group} className="nav">
            <div className="nav-group">{g.group}</div>
            {g.items.map((i) => (
              <Link key={i.href} href={i.href} className={pathname === i.href || (i.href !== '/' && pathname.startsWith(i.href)) ? 'active' : ''}>
                {i.label}
                {i.badge === 'approvals' && !!pending.data?.length && <span className="count">{pending.data.length}</span>}
              </Link>
            ))}
          </div>
        ))}
        <div className="spacer" />
        <div className="small muted" style={{ padding: '8px' }}>
          <div className="ellipsis">{session.user.email}</div>
          <button className="linkbtn" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>
      <div className="main">
        {org.isDemo && (
          <div className="demo-banner" role="note">
            ⚠ DEMO DATA — this workspace contains synthetic data for demonstration. Nothing here is real revenue, customers or evidence.
          </div>
        )}
        <div className="topbar">
          <CommandBar />
          <select className="in" style={{ width: 220 }} value={org.orgId} onChange={(e) => switchOrg(e.target.value)} aria-label="Workspace">
            {session.memberships.map((m) => (
              <option key={m.orgId} value={m.orgId}>
                {m.isDemo ? '[DEMO] ' : ''}
                {m.name} · {m.role}
              </option>
            ))}
          </select>
          <span className="tiny muted nowrap" title="Live event stream">
            {connected ? '● live' : '○ offline'}
          </span>
          <ThemeToggle />
        </div>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
