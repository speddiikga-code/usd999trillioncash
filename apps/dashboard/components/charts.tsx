'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Hand-rolled SVG charts following the ROOS data-viz spec:
 * 2px lines, ≥8px markers with a 2px surface ring, 4px rounded data-ends (square at the
 * baseline), hairline solid grid, legend for ≥2 series + selective direct labels, text in text
 * tokens (never the series colour), crosshair/mark tooltips, and a table view for every chart.
 */

export interface Series {
  key: string;
  name: string;
  color: string;
  values: { x: number; y: number | null }[];
  dashed?: boolean;
  /** Reference series (target / reference lines) are drawn dashed in ink, not a series hue. */
  reference?: boolean;
}

function useWidth<T extends HTMLElement>(initial = 640) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => setW(Math.max(260, Math.floor(entries[0]!.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (max === min) max = min + 1;
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function logTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(Math.max(min, 1e-9)));
  const hi = Math.ceil(Math.log10(Math.max(max, 1e-9)));
  const decades = hi - lo;
  const every = Math.max(1, Math.ceil(decades / 6));
  const out: number[] = [];
  for (let d = lo; d <= hi; d += every) out.push(Math.pow(10, d));
  return out;
}

function ChartTable({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <div className="table-wrap mt">
      <table className="t">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} className={i ? 'r' : ''}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={j ? 'r' : ''}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableToggle({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  return (
    <div className="chart-foot">
      <button className="linkbtn" onClick={() => setOpen(!open)}>
        {open ? 'Hide table' : 'View as table'}
      </button>
    </div>
  );
}

export function Legend({ items }: { items: { name: string; color: string; kind?: 'line' | 'rect' | 'dashed' }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.name} className="legend-item">
          {i.kind === 'rect' ? <span className="key-rect" style={{ background: i.color }} /> : <span className={`key-line ${i.kind === 'dashed' ? 'dashed' : ''}`} style={{ background: i.color }} />}
          {i.name}
        </span>
      ))}
    </div>
  );
}

// ───────────────────────── Line chart ─────────────────────────

export function LineChart({
  series,
  height = 220,
  yFormat = (v) => String(v),
  xFormat = (x) => String(x),
  log = false,
  area = false,
  endLabels = true,
  yMin,
}: {
  series: Series[];
  height?: number;
  yFormat?: (v: number) => string;
  xFormat?: (x: number) => string;
  log?: boolean;
  area?: boolean;
  endLabels?: boolean;
  yMin?: number;
}) {
  const { ref, w } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const xs = useMemo(() => [...new Set(series.flatMap((s) => s.values.map((v) => v.x)))].sort((a, b) => a - b), [series]);
  const ys = series.flatMap((s) => s.values.map((v) => v.y)).filter((v): v is number => v !== null && Number.isFinite(v) && (!log || v > 0));
  const m = { top: 12, right: endLabels ? 118 : 16, bottom: 26, left: 58 };
  const iw = Math.max(40, w - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const rawMin = yMin ?? (log ? Math.min(...ys) : Math.min(0, ...ys));
  const rawMax = Math.max(...ys, log ? 10 : 1);
  const ticks = log ? logTicks(rawMin, rawMax) : niceTicks(rawMin, rawMax);
  const yLo = log ? ticks[0]! : Math.min(ticks[0]!, rawMin);
  const yHi = ticks[ticks.length - 1]!;
  const y = (v: number) => (log ? m.top + ih - ((Math.log10(Math.max(v, yLo)) - Math.log10(yLo)) / (Math.log10(yHi) - Math.log10(yLo) || 1)) * ih : m.top + ih - ((v - yLo) / (yHi - yLo || 1)) * ih);
  const xMin = xs[0] ?? 0;
  const xMax = xs[xs.length - 1] ?? 1;
  const x = (v: number) => m.left + ((v - xMin) / (xMax - xMin || 1)) * iw;
  const xTickIdx = xs.length <= 8 ? xs.map((_, i) => i) : [0, Math.round(xs.length * 0.25), Math.round(xs.length * 0.5), Math.round(xs.length * 0.75), xs.length - 1];

  const path = (s: Series) => {
    let d = '';
    let pen = false;
    for (const p of s.values) {
      if (p.y === null || !Number.isFinite(p.y) || (log && p.y <= 0)) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  // End labels: shown only when they don't collide (no nudging — the legend carries identity).
  const ends = series
    .map((s) => {
      const last = [...s.values].reverse().find((p) => p.y !== null && (!log || (p.y ?? 0) > 0));
      return last ? { s, py: y(last.y!), px: x(last.x) } : null;
    })
    .filter(Boolean) as { s: Series; py: number; px: number }[];
  const sortedEnds = [...ends].sort((a, b) => a.py - b.py);
  const collide = sortedEnds.some((e, i) => i > 0 && e.py - sortedEnds[i - 1]!.py < 13);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.target as SVGRectElement).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * iw;
    let best = 0;
    let bd = Infinity;
    xs.forEach((xv, i) => {
      const d = Math.abs(x(xv) - m.left - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  };
  const hx = hover !== null ? xs[hover] : null;

  return (
    <div className="chart" ref={ref}>
      {series.length > 1 && <Legend items={series.map((s) => ({ name: s.name, color: s.reference ? 'var(--text-secondary)' : s.color, kind: s.reference || s.dashed ? 'dashed' : 'line' }))} />}
      <svg
        viewBox={`0 0 ${w} ${height}`}
        role="img"
        aria-label={series.map((s) => s.name).join(', ')}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setHover((h) => Math.min(xs.length - 1, (h ?? -1) + 1));
          if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? xs.length) - 1));
          if (e.key === 'Escape') setHover(null);
        }}
        onBlur={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={m.left} x2={m.left + iw} y1={y(t)} y2={y(t)} />
            <text x={m.left - 8} y={y(t) + 3.5} textAnchor="end">
              {yFormat(t)}
            </text>
          </g>
        ))}
        <line className="axis-line" x1={m.left} x2={m.left + iw} y1={m.top + ih} y2={m.top + ih} />
        {xTickIdx.map((i) => (
          <text key={i} x={x(xs[i]!)} y={height - 8} textAnchor={i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle'}>
            {xFormat(xs[i]!)}
          </text>
        ))}
        {series.map((s) =>
          area && !s.reference && series.length === 1 ? (
            <path key={`${s.key}-area`} d={`${path(s)}L${x(s.values.at(-1)!.x)},${m.top + ih}L${x(s.values[0]!.x)},${m.top + ih}Z`} fill={s.color} opacity={0.1} />
          ) : null,
        )}
        {series.map((s) => (
          <path key={s.key} d={path(s)} fill="none" stroke={s.reference ? 'var(--text-secondary)' : s.color} strokeWidth={s.reference ? 1.5 : 2} strokeDasharray={s.reference || s.dashed ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {ends.map(({ s, px, py }) => (!s.reference ? <circle key={`${s.key}-end`} cx={px} cy={py} r={4} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} /> : null))}
        {endLabels &&
          (!collide || series.length === 1) &&
          ends.map(({ s, px, py }) => (
            <text key={`${s.key}-lbl`} className="lbl" x={px + 8} y={py + 4}>
              {s.name.length > 16 ? `${s.name.slice(0, 15)}…` : s.name}
            </text>
          ))}
        {hx !== null && hx !== undefined && (
          <g>
            <line className="crosshair" x1={x(hx)} x2={x(hx)} y1={m.top} y2={m.top + ih} />
            {series.map((s) => {
              const p = s.values.find((v) => v.x === hx);
              return p && p.y !== null && (!log || p.y > 0) ? <circle key={s.key} cx={x(hx)} cy={y(p.y)} r={4} fill={s.reference ? 'var(--text-secondary)' : s.color} stroke="var(--surface-1)" strokeWidth={2} /> : null;
            })}
          </g>
        )}
        <rect className="hit" x={m.left} y={m.top} width={iw} height={ih} onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hx !== null && hx !== undefined && (
        <div className="tooltip" style={{ left: Math.min(x(hx) + 12, w - 190), top: m.top }}>
          <div className="tt-title">{xFormat(hx)}</div>
          {series.map((s) => {
            const p = s.values.find((v) => v.x === hx);
            return (
              <div key={s.key} className="tt-row">
                <span className={`key-line ${s.reference || s.dashed ? 'dashed' : ''}`} style={{ background: s.reference ? 'var(--text-secondary)' : s.color }} />
                <span className="tt-val">{p && p.y !== null ? yFormat(p.y) : '—'}</span>
                <span className="tt-name">{s.name}</span>
              </div>
            );
          })}
        </div>
      )}
      <TableToggle open={table} setOpen={setTable} />
      {table && <ChartTable headers={['', ...series.map((s) => s.name)]} rows={xs.map((xv) => [xFormat(xv), ...series.map((s) => { const p = s.values.find((v) => v.x === xv); return p && p.y !== null ? yFormat(p.y) : '—'; })])} />}
    </div>
  );
}

// ───────────────────────── Fan chart (P10 / P50 / P90) ─────────────────────────

export function FanChart({ points, height = 220, yFormat = (v) => String(v), xFormat = (x) => String(x), name = 'Median' }: { points: { x: number; p10: number; p50: number; p90: number }[]; height?: number; yFormat?: (v: number) => string; xFormat?: (x: number) => string; name?: string }) {
  const { ref, w } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const m = { top: 12, right: 16, bottom: 26, left: 64 };
  const iw = w - m.left - m.right;
  const ih = height - m.top - m.bottom;
  const all = points.flatMap((p) => [p.p10, p.p90]);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(1, ...all));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const y = (v: number) => m.top + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const x = (i: number) => m.left + (i / Math.max(1, points.length - 1)) * iw;
  const band = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.p90)}`).join('') + [...points].reverse().map((p, i) => `L${x(points.length - 1 - i)},${y(p.p10)}`).join('') + 'Z';
  const mid = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.p50)}`).join('');
  const hp = hover !== null ? points[hover] : null;
  return (
    <div className="chart" ref={ref}>
      <Legend items={[{ name, color: 'var(--series-1)' }, { name: '80% range (P10–P90)', color: 'var(--accent-wash)', kind: 'rect' }]} />
      <svg viewBox={`0 0 ${w} ${height}`} role="img" aria-label={`${name} with P10–P90 range`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'axis-line' : 'grid-line'} x1={m.left} x2={m.left + iw} y1={y(t)} y2={y(t)} />
            <text x={m.left - 8} y={y(t) + 3.5} textAnchor="end">
              {yFormat(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) => (i % Math.ceil(points.length / 6) === 0 || i === points.length - 1 ? <text key={i} x={x(i)} y={height - 8} textAnchor="middle">{xFormat(p.x)}</text> : null))}
        <path d={band} fill="var(--series-1)" opacity={0.14} />
        <path d={mid} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
        {hp && (
          <>
            <line className="crosshair" x1={x(hover!)} x2={x(hover!)} y1={m.top} y2={m.top + ih} />
            <circle cx={x(hover!)} cy={y(hp.p50)} r={4} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={2} />
          </>
        )}
        <rect
          className="hit"
          x={m.left}
          y={m.top}
          width={iw}
          height={ih}
          onPointerMove={(e) => {
            const r = (e.target as SVGRectElement).getBoundingClientRect();
            setHover(Math.round(((e.clientX - r.left) / r.width) * (points.length - 1)));
          }}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hp && (
        <div className="tooltip" style={{ left: Math.min(x(hover!) + 12, w - 190), top: m.top }}>
          <div className="tt-title">{xFormat(hp.x)}</div>
          <div className="tt-row"><span className="tt-val">{yFormat(hp.p90)}</span><span className="tt-name">P90</span></div>
          <div className="tt-row"><span className="key-line" style={{ background: 'var(--series-1)' }} /><span className="tt-val">{yFormat(hp.p50)}</span><span className="tt-name">P50</span></div>
          <div className="tt-row"><span className="tt-val">{yFormat(hp.p10)}</span><span className="tt-name">P10</span></div>
        </div>
      )}
      <TableToggle open={table} setOpen={setTable} />
      {table && <ChartTable headers={['', 'P10', 'P50', 'P90']} rows={points.map((p) => [xFormat(p.x), yFormat(p.p10), yFormat(p.p50), yFormat(p.p90)])} />}
    </div>
  );
}

// ───────────────────────── Horizontal bars ─────────────────────────

/** Path for a horizontal bar: square at the baseline, 4px rounded data-end. */
function hbar(x0: number, x1: number, yTop: number, h: number, r = 4) {
  const len = x1 - x0;
  const rr = Math.min(r, len / 2, h / 2);
  if (len <= 0.5) return '';
  return `M${x0},${yTop}H${x1 - rr}A${rr},${rr} 0 0 1 ${x1},${yTop + rr}V${yTop + h - rr}A${rr},${rr} 0 0 1 ${x1 - rr},${yTop + h}H${x0}Z`;
}

export function BarList({ items, format = (v) => String(v), color = 'var(--series-1)', colors, max, labelWidth = 180 }: { items: { label: string; value: number; sub?: string; low?: number; high?: number }[]; format?: (v: number) => string; color?: string; colors?: string[]; max?: number; labelWidth?: number }) {
  const { ref, w } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const rowH = 30;
  const barH = 14;
  const lw = Math.min(labelWidth, w * 0.42);
  const valueW = 76;
  const iw = Math.max(40, w - lw - valueW - 8);
  const top = Math.max(max ?? 0, ...items.map((i) => Math.max(i.value, i.high ?? 0)), 1e-9);
  const sx = (v: number) => lw + (Math.max(0, v) / top) * iw;
  const height = items.length * rowH + 4;
  return (
    <div className="chart" ref={ref}>
      <svg viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Bar chart">
        {items.map((it, i) => {
          const yTop = i * rowH + (rowH - barH) / 2;
          const c = colors?.[i] ?? color;
          return (
            <g key={i}>
              <text x={0} y={yTop + barH - 3} className="lbl">
                {it.label.length > 28 ? `${it.label.slice(0, 27)}…` : it.label}
              </text>
              <line className="axis-line" x1={lw} x2={lw} y1={i * rowH + 4} y2={(i + 1) * rowH - 4} />
              <path d={hbar(lw, sx(it.value), yTop, barH)} fill={c} className={hover === i ? 'mark-hover' : ''} />
              {it.low !== undefined && it.high !== undefined && (
                <g stroke="var(--text-secondary)" strokeWidth={1.5}>
                  <line x1={sx(it.low)} x2={sx(it.high)} y1={yTop + barH / 2} y2={yTop + barH / 2} />
                  <line x1={sx(it.low)} x2={sx(it.low)} y1={yTop + 3} y2={yTop + barH - 3} />
                  <line x1={sx(it.high)} x2={sx(it.high)} y1={yTop + 3} y2={yTop + barH - 3} />
                </g>
              )}
              <text x={Math.max(sx(it.value), sx(it.high ?? 0)) + 6} y={yTop + barH - 3} className="lbl">
                {format(it.value)}
              </text>
              <rect className="bar-hit" x={0} y={i * rowH} width={w} height={rowH} onPointerMove={() => setHover(i)} onPointerLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
            </g>
          );
        })}
      </svg>
      {hover !== null && items[hover] && (
        <div className="tooltip" style={{ left: Math.min(sx(items[hover]!.value) + 10, w - 200), top: hover * rowH + rowH }}>
          <div className="tt-title">{items[hover]!.label}</div>
          <div className="tt-row">
            <span className="tt-val">{format(items[hover]!.value)}</span>
            {items[hover]!.low !== undefined && <span className="tt-name">range {format(items[hover]!.low!)}–{format(items[hover]!.high!)}</span>}
          </div>
          {items[hover]!.sub && <div className="tt-name small">{items[hover]!.sub}</div>}
        </div>
      )}
      <TableToggle open={table} setOpen={setTable} />
      {table && <ChartTable headers={['', 'Value', 'Range']} rows={items.map((i) => [i.label, format(i.value), i.low !== undefined ? `${format(i.low)}–${format(i.high!)}` : '—'])} />}
    </div>
  );
}

// ───────────────────────── Funnel (ordinal ramp) ─────────────────────────

export function Funnel({ stages }: { stages: { label: string; count: number }[] }) {
  const ramp = ['var(--ord-1)', 'var(--ord-2)', 'var(--ord-3)', 'var(--ord-4)'];
  return (
    <>
      <BarList
        items={stages.map((s, i) => ({ label: s.label, value: s.count, sub: i > 0 && stages[i - 1]!.count > 0 ? `${((s.count / stages[i - 1]!.count) * 100).toFixed(1)}% of previous stage` : undefined }))}
        colors={stages.map((_, i) => ramp[Math.min(i, ramp.length - 1)]!)}
        format={(v) => v.toLocaleString('en-US')}
        labelWidth={130}
      />
      <div className="row small secondary">
        {stages.slice(1).map((s, i) => (
          <span key={s.label}>
            {stages[i]!.label} → {s.label}: <strong className="num">{stages[i]!.count ? `${((s.count / stages[i]!.count) * 100).toFixed(1)}%` : '—'}</strong>
          </span>
        ))}
      </div>
    </>
  );
}

// ───────────────────────── Interval / score range ─────────────────────────

export function wilson(s: number, n: number, z = 1.645) {
  if (n <= 0) return { low: 0, high: 1 };
  const p = s / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, c - h), high: Math.min(1, c + h) };
}

/** Inline score with its uncertainty interval (0–1 scale). */
export function ScoreRange({ score, low, high, width = 120 }: { score: number | null | undefined; low?: number; high?: number; width?: number }) {
  if (score === null || score === undefined) return <span className="muted">—</span>;
  const x = (v: number) => 4 + Math.max(0, Math.min(1, v)) * (width - 8);
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }} title={`Score ${score.toFixed(2)}${low !== undefined ? ` (80% range ${low.toFixed(2)}–${high!.toFixed(2)})` : ''}`}>
      <svg width={width} height={14} role="img" aria-label={`score ${score.toFixed(2)}`}>
        <line x1={4} x2={width - 4} y1={7} y2={7} stroke="var(--grid)" strokeWidth={4} strokeLinecap="round" />
        {low !== undefined && high !== undefined && <line x1={x(low)} x2={x(high)} y1={7} y2={7} stroke="var(--series-1)" strokeOpacity={0.35} strokeWidth={4} strokeLinecap="round" />}
        <circle cx={x(score)} cy={7} r={4} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={2} />
      </svg>
      <span className="num small">{score.toFixed(2)}</span>
    </span>
  );
}

/** Variant rates with 90% credible/confidence intervals + probability of being best. */
export function VariantIntervals({ variants }: { variants: { variant: string; numerator: number; denominator: number; probBest?: number }[] }) {
  const palette = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
  const items = variants.map((v) => {
    const ci = wilson(v.numerator, v.denominator);
    return { label: `Variant ${v.variant}`, value: v.denominator ? v.numerator / v.denominator : 0, low: ci.low, high: ci.high, sub: `${v.numerator}/${v.denominator}${v.probBest !== undefined ? ` · P(best) ${(v.probBest * 100).toFixed(1)}%` : ''}` };
  });
  return (
    <>
      <Legend items={variants.map((v, i) => ({ name: `Variant ${v.variant}`, color: palette[i % palette.length]!, kind: 'rect' }))} />
      <BarList items={items} colors={variants.map((_, i) => palette[i % palette.length]!)} format={(v) => `${(v * 100).toFixed(1)}%`} labelWidth={110} />
      <div className="tiny muted">Whiskers: 90% Wilson interval.</div>
    </>
  );
}

export function Sparkline({ values, width = 120, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * (width - 6) + 3).toFixed(1)},${(height - 3 - ((v - min) / (max - min || 1)) * (height - 6)).toFixed(1)}`).join('');
  const lastY = height - 3 - ((values.at(-1)! - min) / (max - min || 1)) * (height - 6);
  return (
    <svg width={width} height={height} aria-hidden>
      <path d={d} fill="none" stroke="var(--text-muted)" strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={width - 3} cy={lastY} r={2.5} fill="var(--series-1)" />
    </svg>
  );
}

export function ChartTitle({ title, subtitle, right }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="row between" style={{ marginBottom: 4 }}>
      <div>
        <h3>{title}</h3>
        {subtitle && <div className="small muted">{subtitle}</div>}
      </div>
      {right}
    </div>
  );
}
