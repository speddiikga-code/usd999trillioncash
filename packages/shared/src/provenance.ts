/**
 * Data provenance primitives.
 *
 * Every number or claim the system shows must say WHERE it came from. The system never
 * presents a model assumption or an estimate as if it were observed data.
 *
 *  OBSERVED          – directly measured or fetched from a cited external source
 *  ESTIMATED         – derived by a documented calculation or model from observed inputs
 *  MODEL_ASSUMPTION  – a prior / placeholder chosen by the system; must be replaced by evidence
 *  USER_INPUT        – entered by a human operator (unverified by the system)
 *  DEMO              – synthetic demo data; never mixed with production metrics
 */
export const DATA_KINDS = ['OBSERVED', 'ESTIMATED', 'MODEL_ASSUMPTION', 'USER_INPUT', 'DEMO'] as const;
export type DataKind = (typeof DATA_KINDS)[number];

export interface SourceRef {
  /** Human-readable source name, e.g. "Hacker News (Algolia API)" */
  name: string;
  url?: string;
  /** ISO timestamp the data was retrieved */
  retrievedAt?: string;
  /** Connector id that produced it, if any */
  connector?: string;
}

/**
 * A value with an explicit uncertainty range and provenance. `low`/`high` bound a plausible
 * range (roughly an 80% interval unless `rationale` says otherwise).
 */
export interface EstimatedValue<T = number> {
  value: T;
  low?: number;
  high?: number;
  unit?: string;
  kind: DataKind;
  /** 0..1 — how much the system trusts this value */
  confidence: number;
  rationale: string;
  sources?: SourceRef[];
  /** Which component produced it: "heuristic:market-sizing", "model:anthropic/claude-sonnet-5", "user" ... */
  computedBy?: string;
  updatedAt?: string;
}

export function observed<T>(value: T, rationale: string, sources: SourceRef[], confidence = 0.9, extra: Partial<EstimatedValue<T>> = {}): EstimatedValue<T> {
  return { value, kind: 'OBSERVED', confidence, rationale, sources, updatedAt: new Date().toISOString(), ...extra };
}

export function estimated<T>(value: T, low: number | undefined, high: number | undefined, rationale: string, extra: Partial<EstimatedValue<T>> = {}): EstimatedValue<T> {
  return { value, low, high, kind: 'ESTIMATED', confidence: extra.confidence ?? 0.4, rationale, updatedAt: new Date().toISOString(), ...extra };
}

export function assumption<T>(value: T, low: number | undefined, high: number | undefined, rationale: string, extra: Partial<EstimatedValue<T>> = {}): EstimatedValue<T> {
  return { value, low, high, kind: 'MODEL_ASSUMPTION', confidence: extra.confidence ?? 0.2, rationale, updatedAt: new Date().toISOString(), ...extra };
}

export function userInput<T>(value: T, rationale = 'Entered by operator', extra: Partial<EstimatedValue<T>> = {}): EstimatedValue<T> {
  return { value, kind: 'USER_INPUT', confidence: extra.confidence ?? 0.6, rationale, computedBy: 'user', updatedAt: new Date().toISOString(), ...extra };
}

export function demoValue<T>(value: T, low?: number, high?: number, rationale = 'Synthetic demo data'): EstimatedValue<T> {
  return { value, low, high, kind: 'DEMO', confidence: 0, rationale, computedBy: 'demo-seed', updatedAt: new Date().toISOString() };
}

/**
 * Anything computed inside a demo workspace is derived from synthetic data, so every provenance
 * `kind` in it is DEMO — regardless of which estimator produced it.
 */
export function demoizeDeep<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => demoizeDeep(x)) as T;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = k === 'kind' && typeof x === 'string' && (DATA_KINDS as readonly string[]).includes(x) ? 'DEMO' : demoizeDeep(x);
    }
    return out as T;
  }
  return v;
}

/** Human label used in UIs and reports. */
export function dataKindLabel(kind: DataKind): string {
  switch (kind) {
    case 'OBSERVED':
      return 'Observed data';
    case 'ESTIMATED':
      return 'Estimate';
    case 'MODEL_ASSUMPTION':
      return 'Model assumption';
    case 'USER_INPUT':
      return 'User input';
    case 'DEMO':
      return 'DEMO DATA';
  }
}

/**
 * When combining values, the result is only as trustworthy as its weakest input.
 * DEMO poisons everything (never mix), then MODEL_ASSUMPTION, then USER_INPUT/ESTIMATED.
 */
export function weakestKind(kinds: DataKind[]): DataKind {
  if (kinds.includes('DEMO')) return 'DEMO';
  if (kinds.includes('MODEL_ASSUMPTION')) return 'MODEL_ASSUMPTION';
  if (kinds.includes('ESTIMATED')) return 'ESTIMATED';
  if (kinds.includes('USER_INPUT')) return 'USER_INPUT';
  return 'OBSERVED';
}
