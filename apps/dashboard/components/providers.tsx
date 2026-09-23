'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { get, getOrgId, setOrgId } from '@/lib/api';

export interface Membership {
  orgId: string;
  name: string;
  slug: string;
  isDemo: boolean;
  role: string;
}

export interface Session {
  user: { id: string; email: string; name: string };
  memberships: Membership[];
  org: Membership;
}

export interface ServerEvent {
  id: number;
  type: string;
  entityType?: string | null;
  entityId?: string | null;
  payload: Record<string, any>;
  createdAt: string;
}

interface SessionCtx {
  session: Session | null;
  switchOrg: (orgId: string) => void;
  refresh: () => Promise<void>;
}

interface EventsCtx {
  recent: ServerEvent[];
  connected: boolean;
  orgVersion: number;
  subscribe: (fn: (e: ServerEvent) => void) => () => void;
}

export const SessionContext = createContext<SessionCtx>({ session: null, switchOrg: () => {}, refresh: async () => {} });
export const EventsContext = createContext<EventsCtx>({ recent: [], connected: false, orgVersion: 0, subscribe: () => () => {} });

export const useSession = () => useContext(SessionContext);
export const useEvents = () => useContext(EventsContext);

const PUBLIC_PATHS = ['/login'];

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [orgVersion, setOrgVersion] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const s = await get<{ authenticated: boolean; user?: Session['user']; memberships?: Membership[] }>('/api/auth/state');
      if (!s.authenticated || !s.user || !s.memberships?.length) {
        setSession(null);
        if (!PUBLIC_PATHS.includes(pathname)) router.replace('/login');
        return;
      }
      const stored = getOrgId();
      const org = s.memberships.find((m) => m.orgId === stored) ?? s.memberships.find((m) => !m.isDemo) ?? s.memberships[0]!;
      setOrgId(org.orgId);
      setSession({ user: s.user, memberships: s.memberships, org });
    } catch {
      setSession(null);
    } finally {
      setChecked(true);
    }
  }, [pathname, router]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchOrg = useCallback(
    (orgId: string) => {
      setOrgId(orgId);
      setSession((s) => (s ? { ...s, org: s.memberships.find((m) => m.orgId === orgId) ?? s.org } : s));
      setOrgVersion((v) => v + 1);
    },
    [],
  );

  // ── One shared SSE connection per org ──
  const listeners = useRef(new Set<(e: ServerEvent) => void>());
  const [recent, setRecent] = useState<ServerEvent[]>([]);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!session) return;
    setRecent([]);
    const es = new EventSource(`/api/events/stream?org=${encodeURIComponent(session.org.orgId)}`, { withCredentials: true });
    const onAny = (msg: MessageEvent) => {
      try {
        const e = JSON.parse(msg.data) as ServerEvent;
        setRecent((r) => [e, ...r].slice(0, 80));
        listeners.current.forEach((fn) => fn(e));
      } catch {
        /* ignore malformed */
      }
    };
    const types = ['opportunity.created', 'opportunity.updated', 'opportunity.scored', 'hypothesis.created', 'task.queued', 'task.started', 'task.succeeded', 'task.failed', 'task.waiting_approval', 'approval.requested', 'approval.decided', 'approval.executed', 'experiment.created', 'experiment.started', 'experiment.evaluated', 'experiment.decided', 'project.generated', 'sandbox.completed', 'deployment.updated', 'tracking.event', 'lead.created', 'campaign.updated', 'revenue.recorded', 'expense.recorded', 'report.generated', 'research.completed', 'alert', 'system.health'];
    types.forEach((t) => es.addEventListener(t, onAny as EventListener));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
    // Reconnect when the selected org changes (EventSource can't send headers; org goes in the query).
  }, [session?.org.orgId]);

  const subscribe = useCallback((fn: (e: ServerEvent) => void) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  const eventsValue = useMemo(() => ({ recent, connected, orgVersion, subscribe }), [recent, connected, orgVersion, subscribe]);
  const sessionValue = useMemo(() => ({ session, switchOrg, refresh }), [session, switchOrg, refresh]);

  if (!checked && !PUBLIC_PATHS.includes(pathname)) {
    return (
      <div className="center-card muted">
        <span className="spin" /> Loading…
      </div>
    );
  }
  return (
    <SessionContext.Provider value={sessionValue}>
      <EventsContext.Provider value={eventsValue}>{children}</EventsContext.Provider>
    </SessionContext.Provider>
  );
}
