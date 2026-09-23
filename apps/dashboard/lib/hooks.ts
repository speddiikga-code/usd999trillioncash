'use client';

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { get } from './api';
import { EventsContext } from '@/components/providers';

/**
 * Fetch hook: keeps the previous data while refetching (no skeleton flash), refetches when the
 * org changes, and optionally re-fetches when matching server events arrive over SSE.
 */
export function useApi<T = any>(path: string | null, opts: { refreshOn?: string[]; intervalMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!path);
  const events = useContext(EventsContext);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await get<T>(path);
      if (my === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(e as Error);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load, events.orgVersion]);

  useEffect(() => {
    if (!opts.refreshOn?.length) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = events.subscribe((e) => {
      if (opts.refreshOn!.some((p) => e.type.startsWith(p))) {
        clearTimeout(t);
        t = setTimeout(() => void load(), 400);
      }
    });
    return () => {
      off();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, events, (opts.refreshOn ?? []).join(',')]);

  useEffect(() => {
    if (!opts.intervalMs) return;
    const i = setInterval(() => void load(), opts.intervalMs);
    return () => clearInterval(i);
  }, [load, opts.intervalMs]);

  return { data, error, loading, reload: load, setData };
}

/** Run an async action with pending + error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<R | null>(null);
  const run = useCallback(
    async (...args: A) => {
      setPending(true);
      setError(null);
      try {
        const r = await fn(...args);
        setResult(r);
        return r;
      } catch (e) {
        setError((e as Error).message);
        return null;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );
  return { run, pending, error, result, setError };
}
