import type { EstimatedValue, UnitEconomics } from '@roos/shared';
import { round, weakestKind } from '@roos/shared';

/**
 * Unit economics with interval propagation. Ranges are combined pessimistically/optimistically
 * (price.low × margin.low / churn.high etc.), so the resulting interval is a conservative envelope.
 */
export function computeUnitEconomics(input: { price: EstimatedValue; cac: EstimatedValue; grossMargin: EstimatedValue; monthlyChurn: EstimatedValue }): UnitEconomics {
  const p = triple(input.price);
  const c = triple(input.cac);
  const g = triple(input.grossMargin);
  const ch = triple(input.monthlyChurn);
  const kind = weakestKind([input.price.kind, input.cac.kind, input.grossMargin.kind, input.monthlyChurn.kind]);
  const conf = Math.min(input.price.confidence, input.cac.confidence, input.grossMargin.confidence, input.monthlyChurn.confidence);

  const ltv = (pp: number, gg: number, cc: number) => (pp * gg) / Math.max(cc, 0.005);
  const ltvMid = ltv(p.mid, g.mid, ch.mid);
  const ltvLow = ltv(p.low, g.low, ch.high);
  const ltvHigh = ltv(p.high, g.high, ch.low);
  const ratioMid = ltvMid / Math.max(c.mid, 1);
  const ratioLow = ltvLow / Math.max(c.high, 1);
  const ratioHigh = ltvHigh / Math.max(c.low, 1);
  const payback = (cc: number, pp: number, gg: number) => cc / Math.max(pp * gg, 0.01);

  const derived = (value: number, low: number, high: number, unit: string, rationale: string): EstimatedValue => ({
    value: round(value, 2),
    low: round(Math.min(low, high), 2),
    high: round(Math.max(low, high), 2),
    unit,
    kind: kind === 'OBSERVED' ? 'ESTIMATED' : kind,
    confidence: round(conf * 0.9, 2),
    rationale,
    computedBy: 'analytics:unit-economics',
  });

  return {
    price: input.price,
    cac: input.cac,
    grossMargin: input.grossMargin,
    monthlyChurn: input.monthlyChurn,
    ltv: derived(ltvMid, ltvLow, ltvHigh, 'USD', 'LTV = monthly price × gross margin ÷ monthly churn.'),
    ltvToCac: derived(ratioMid, ratioLow, ratioHigh, 'ratio', 'LTV ÷ CAC. ≥ 3 is a common health heuristic.'),
    paybackMonths: derived(payback(c.mid, p.mid, g.mid), payback(c.low, p.high, g.high), payback(c.high, p.low, g.low), 'months', 'CAC ÷ (monthly price × gross margin).'),
  };
}

function triple(v: EstimatedValue): { low: number; mid: number; high: number } {
  const mid = Number(v.value);
  return { low: v.low ?? mid, mid, high: v.high ?? mid };
}
