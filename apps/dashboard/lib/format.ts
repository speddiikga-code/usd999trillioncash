export function usd(n: number | null | undefined, opts: { compact?: boolean; cents?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (opts.compact && abs >= 1000) {
    const units: [number, string][] = [
      [1e18, 'E'],
      [1e15, 'Q'],
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ];
    for (const [v, u] of units) if (abs >= v) return `${n < 0 ? '-' : ''}$${trim(abs / v)}${u}`;
  }
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: opts.cents || abs < 100 ? 2 : 0, minimumFractionDigits: 0 });
}

function trim(x: number) {
  return x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1).replace(/\.0$/, '') : x.toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
}

export function num(n: number | null | undefined, opts: { compact?: boolean; digits?: number } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (opts.compact && Math.abs(n) >= 1000) {
    const units: [number, string][] = [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ];
    for (const [v, u] of units) if (Math.abs(n) >= v) return `${trim(n / v)}${u}`;
  }
  return n.toLocaleString('en-US', { maximumFractionDigits: opts.digits ?? 2 });
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

export function sci(n: number): string {
  if (n === 0) return '0';
  if (Math.abs(n) >= 1e-3 && Math.abs(n) < 1e6) return num(n, { digits: 4 });
  return n.toExponential(2);
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 14 ? `${id.slice(0, 10)}…` : id;
}

export function title(s: string): string {
  return s.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
