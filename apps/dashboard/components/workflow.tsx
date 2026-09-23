'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { get } from '@/lib/api';
import { useEvents } from './providers';
import { StatusBadge } from './ui';

/** Live progress of an agent workflow (updates on task.* events). */
export function WorkflowProgress({ workflowId, onDone }: { workflowId: string; onDone?: () => void }) {
  const [wf, setWf] = useState<{ done: boolean; tasks: any[] } | null>(null);
  const { subscribe } = useEvents();
  useEffect(() => {
    let finished = false;
    const load = () =>
      get(`/api/workflows/${workflowId}`)
        .then((w) => {
          setWf(w);
          const settled = w.tasks.length && w.tasks.every((t: any) => ['succeeded', 'failed', 'cancelled', 'timed_out', 'waiting_approval'].includes(t.status));
          if (settled && !finished) {
            finished = true;
            onDone?.();
          }
        })
        .catch(() => undefined);
    void load();
    const off = subscribe((e) => e.type.startsWith('task.') && void load());
    const poll = setInterval(load, 4000);
    return () => {
      off();
      clearInterval(poll);
    };
  }, [workflowId, subscribe, onDone]);
  if (!wf) return <span className="spin" />;
  return (
    <div className="stack small">
      {wf.tasks.map((t) => (
        <div key={t.id} className="row">
          <StatusBadge status={t.status} />
          <span className="mono">{t.agent}</span>
          <span className="muted mono">{t.kind}</span>
          {t.status === 'waiting_approval' && <Link href="/approvals">Approval needed →</Link>}
          {t.error && t.status !== 'succeeded' && <span className="err">{String(t.error).slice(0, 160)}</span>}
        </div>
      ))}
    </div>
  );
}
