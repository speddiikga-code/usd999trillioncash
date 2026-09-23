'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useApi } from '@/lib/hooks';
import { Empty, Loading, Panel } from '@/components/blocks';
import { Legend } from '@/components/charts';

// Only three categorical hues (validated all-pairs for node-link / scatter forms); everything else is "Other".
const COLORS: Record<string, string> = { opportunity: 'var(--series-1)', customer_segment: 'var(--series-2)', pain_point: 'var(--series-3)' };
const colorOf = (t: string) => COLORS[t] ?? 'var(--text-muted)';

function layout(nodes: { id: string }[], edges: { srcId: string; dstId: string }[], w: number, h: number) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pos = new Map(nodes.map((n) => [n.id, { x: w / 2 + (rnd() - 0.5) * w * 0.8, y: h / 2 + (rnd() - 0.5) * h * 0.8, vx: 0, vy: 0 }]));
  const k = Math.sqrt((w * h) / Math.max(1, nodes.length)) * 0.55;
  for (let it = 0; it < 260; it++) {
    const t = 1 - it / 260;
    for (const a of nodes) {
      const pa = pos.get(a.id)!;
      for (const b of nodes) {
        if (a === b) continue;
        const pb = pos.get(b.id)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = (k * k) / d / d;
        pa.vx += dx * f * 0.5;
        pa.vy += dy * f * 0.5;
      }
    }
    for (const e of edges) {
      const a = pos.get(e.srcId);
      const b = pos.get(e.dstId);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = d / k;
      a.vx -= (dx / d) * f * 2;
      a.vy -= (dy / d) * f * 2;
      b.vx += (dx / d) * f * 2;
      b.vy += (dy / d) * f * 2;
    }
    for (const p of pos.values()) {
      p.vx += (w / 2 - p.x) * 0.01;
      p.vy += (h / 2 - p.y) * 0.01;
      const sp = Math.hypot(p.vx, p.vy) || 1;
      const lim = Math.min(sp, 20 * t + 1);
      p.x = Math.min(w - 20, Math.max(20, p.x + (p.vx / sp) * lim));
      p.y = Math.min(h - 20, Math.max(20, p.y + (p.vy / sp) * lim));
      p.vx *= 0.3;
      p.vy *= 0.3;
    }
  }
  return pos;
}

export default function GraphPage() {
  const g = useApi<any>('/api/graph?limit=160', { refreshOn: ['opportunity.created', 'hypothesis.'] });
  const [hover, setHover] = useState<any>(null);
  const [table, setTable] = useState(false);
  const W = 1100;
  const H = 640;
  const pos = useMemo(() => (g.data ? layout(g.data.nodes, g.data.edges, W, H) : null), [g.data]);
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of g.data?.edges ?? []) {
      d.set(e.srcId, (d.get(e.srcId) ?? 0) + 1);
      d.set(e.dstId, (d.get(e.dstId) ?? 0) + 1);
    }
    return d;
  }, [g.data]);
  const hoverEdges = new Set((g.data?.edges ?? []).filter((e: any) => hover && (e.srcId === hover.id || e.dstId === hover.id)).flatMap((e: any) => [e.srcId, e.dstId]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Knowledge graph</h1>
          <div className="page-sub">Markets, customer segments, pain points, competitors, regulations, business models, technologies and sources — stored as a property graph in PostgreSQL behind a GraphStore interface (a graph database can be plugged in later).</div>
        </div>
      </div>
      <Panel>
        {!g.data || !pos ? <Loading /> : !g.data.nodes.length ? <Empty>The graph fills as research and analysis run.</Empty> : (
          <div className="chart">
            <Legend items={[{ name: 'Opportunity', color: COLORS.opportunity!, kind: 'rect' }, { name: 'Customer segment', color: COLORS.customer_segment!, kind: 'rect' }, { name: 'Pain point', color: COLORS.pain_point!, kind: 'rect' }, { name: 'Other (competitor, regulation, model, source, technology, market)', color: 'var(--text-muted)', kind: 'rect' }]} />
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Knowledge graph">
              {g.data.edges.map((e: any) => {
                const a = pos.get(e.srcId);
                const b = pos.get(e.dstId);
                if (!a || !b) return null;
                const lit = hover && (e.srcId === hover.id || e.dstId === hover.id);
                return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={lit ? 'var(--text-secondary)' : 'var(--grid)'} strokeWidth={lit ? 1.5 : 1} />;
              })}
              {g.data.nodes.map((n: any) => {
                const p = pos.get(n.id)!;
                const r = 4 + Math.min(8, (degree.get(n.id) ?? 0) * 0.8);
                const dim = hover && hover.id !== n.id && !hoverEdges.has(n.id);
                return (
                  <g key={n.id} opacity={dim ? 0.3 : 1} onPointerEnter={() => setHover(n)} onPointerLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover(n)} onBlur={() => setHover(null)}>
                    <circle cx={p.x} cy={p.y} r={Math.max(12, r + 4)} fill="transparent" />
                    <circle cx={p.x} cy={p.y} r={r} fill={colorOf(n.type)} stroke="var(--surface-1)" strokeWidth={2} />
                    {(n.type === 'opportunity' || (degree.get(n.id) ?? 0) >= 4 || hover?.id === n.id) && (
                      <text x={p.x + r + 4} y={p.y + 4} className="lbl">{n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label}</text>
                    )}
                  </g>
                );
              })}
            </svg>
            {hover && (
              <div className="tooltip" style={{ left: 12, top: 40 }}>
                <div className="tt-title">{hover.type.replace(/_/g, ' ')}</div>
                <div className="tt-val">{hover.label}</div>
                <div className="tt-name small">{degree.get(hover.id) ?? 0} connections</div>
              </div>
            )}
            <div className="chart-foot"><button className="linkbtn" onClick={() => setTable(!table)}>{table ? 'Hide table' : 'View as table'}</button></div>
          </div>
        )}
      </Panel>
      {table && g.data && (
        <Panel title="Nodes" className="mt2" flush>
          <table className="t">
            <thead><tr><th>Label</th><th>Type</th><th className="r">Connections</th></tr></thead>
            <tbody>{[...g.data.nodes].sort((a: any, b: any) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).map((n: any) => (
              <tr key={n.id}><td>{n.type === 'opportunity' ? <Link href={`/opportunities/${n.key}`}>{n.label}</Link> : n.label}</td><td>{n.type.replace(/_/g, ' ')}</td><td className="r">{degree.get(n.id) ?? 0}</td></tr>
            ))}</tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
