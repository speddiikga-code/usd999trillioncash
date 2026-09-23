'use client';

import Link from 'next/link';
import { Fragment, useState, type ReactNode } from 'react';

export function Panel({ title, actions, children, flush, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`panel ${className ?? ''}`}>
      {(title || actions) && (
        <div className="panel-head">
          {title && <div className="panel-title">{title}</div>}
          <div className="spacer" />
          {actions}
        </div>
      )}
      <div className={`panel-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function StatTile({ label, value, sub, badge }: { label: string; value: ReactNode; sub?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="tile">
      <div className="tile-label">
        {label}
        {badge}
      </div>
      <div className="tile-value">{value}</div>
      {sub !== undefined && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  OBSERVED: 'Observed',
  ESTIMATED: 'Estimate',
  MODEL_ASSUMPTION: 'Assumption',
  USER_INPUT: 'User input',
  DEMO: 'DEMO DATA',
};

/** Provenance badge — dot + text, never colour alone. */
export function KindBadge({ kind }: { kind?: string | null }) {
  if (!kind) return null;
  return (
    <span className={`badge kind-${kind}`} title={`Data type: ${KIND_LABEL[kind] ?? kind}`}>
      <span className="dot" />
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  succeeded: 'good', running: 'info', queued: 'neutral', failed: 'critical', timed_out: 'critical', cancelled: 'neutral', waiting_approval: 'warning',
  pending: 'warning', approved: 'good', executed: 'good', rejected: 'neutral', expired: 'neutral',
  draft: 'neutral', pending_approval: 'warning', paused: 'serious', completed: 'good', killed: 'critical',
  SCALE: 'good', ITERATE: 'info', PAUSE: 'serious', KILL: 'critical', CONTINUE: 'neutral',
  discovered: 'neutral', analyzing: 'info', analyzed: 'info', validated: 'good', building: 'info', built: 'good', launched: 'good', experimenting: 'info', scaling: 'good', archived: 'neutral',
  ok: 'good', degraded: 'warning', down: 'critical', idle: 'neutral', disabled: 'neutral', error: 'critical',
  live: 'good', preview: 'info', retired: 'neutral', sent: 'good', sending: 'info',
  tests_passed: 'good', tests_failed: 'critical', scan_failed: 'critical', generated: 'info', deployed: 'good', stopped: 'neutral', pending_manual: 'warning', starting: 'info',
  info: 'info', warning: 'warning', critical: 'critical', low: 'good', medium: 'warning', high: 'serious',
  inbound: 'good', opt_in: 'good', existing_customer: 'good', legitimate_interest: 'info', unknown: 'neutral',
  READ_ONLY: 'neutral', SIMULATE: 'info', REQUIRE_APPROVAL: 'warning', AUTONOMOUS: 'serious',
};

export function StatusBadge({ status, label }: { status?: string | null; label?: string }) {
  if (!status) return null;
  const tone = STATUS_TONE[status] ?? 'neutral';
  return (
    <span className={`badge st-${tone}`}>
      <span className="dot" />
      {label ?? status.replace(/_/g, ' ')}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ error }: { error?: Error | string | null }) {
  if (!error) return null;
  return <div className="banner critical">{typeof error === 'string' ? error : error.message}</div>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty">
      <span className="spin" /> {label}
    </div>
  );
}

/** Placeholder for a query without data: the error (e.g. missing permission) if it failed, else a spinner. */
export function Pending({ q }: { q: { error: Error | null } }) {
  if (q.error) {
    const forbidden = /permission|not a member|403/i.test(q.error.message);
    return <div className="empty">{forbidden ? `🔒 ${q.error.message}` : <span className="err">{q.error.message}</span>}</div>;
  }
  return <Loading />;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'active' : ''} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function IdLink({ href, id }: { href: string; id: string }) {
  return (
    <Link href={href} className="mono small">
      {id.length > 16 ? `${id.slice(0, 12)}…` : id}
    </Link>
  );
}

export function JsonView({ value, max = 4000 }: { value: unknown; max?: number }) {
  const text = JSON.stringify(value, null, 2) ?? '';
  return <pre className="code-view">{text.length > max ? `${text.slice(0, max)}\n…` : text}</pre>;
}

export function Collapsible({ label, children, defaultOpen = false }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button className="linkbtn" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <div className="mt">{children}</div>}
    </div>
  );
}

/** Minimal, safe markdown → React (headings, lists, quotes, bold, code, http(s) links). No raw HTML. */
export function Markdown({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let k = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith('`')) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
      else {
        const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
        const safe = /^https?:\/\//.test(href!) ? href : undefined;
        out.push(
          safe ? (
            <a key={k++} href={safe} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          ) : (
            <span key={k++}>{label}</span>
          ),
        );
      }
      last = m.index + tok.length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={blocks.length}>
          {list.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const line of text.split('\n')) {
    if (/^- /.test(line)) {
      list.push(line.slice(2));
      continue;
    }
    flush();
    if (/^# /.test(line)) blocks.push(<h1 key={blocks.length}>{inline(line.slice(2))}</h1>);
    else if (/^## /.test(line)) blocks.push(<h2 key={blocks.length}>{inline(line.slice(3))}</h2>);
    else if (/^> /.test(line)) blocks.push(<blockquote key={blocks.length}>{inline(line.slice(2))}</blockquote>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="md">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
