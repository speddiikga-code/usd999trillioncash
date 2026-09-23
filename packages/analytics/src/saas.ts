import { round, sum } from '@roos/shared';

/**
 * SaaS / revenue metrics computed from the revenue ledger. Every output states whether it is
 * derived from verified (payment-provider) data only, or includes unverified manual entries.
 */
export interface RevenueEventLite {
  type: 'charge' | 'refund' | 'subscription_started' | 'subscription_changed' | 'subscription_canceled';
  amountUsd: number;
  mrrDeltaUsd: number;
  occurredAt: string | Date;
  customerId?: string | null;
  verified: boolean;
}

export interface ExpenseLite {
  category: string;
  amountUsd: number;
  occurredAt: string | Date;
}

export interface CustomerLite {
  id: string;
  status: 'trial' | 'active' | 'churned';
  startedAt: string | Date;
  churnedAt?: string | Date | null;
  mrrUsd: number;
}

export interface MonthPoint {
  month: string;
  mrr: number;
  newMrr: number;
  churnedMrr: number;
  expansionMrr: number;
  revenue: number;
  expenses: number;
  newCustomers: number;
  churnedCustomers: number;
}

export interface RevenueMetrics {
  mrr: number;
  arr: number;
  revenueTotal: number;
  revenueLast30: number;
  refundsTotal: number;
  netRevenue: number;
  grossProfit: number;
  grossMargin: number | null;
  expensesLast30: number;
  burnLast30: number;
  activeCustomers: number;
  newCustomersLast30: number;
  churnedCustomersLast30: number;
  customerChurnRate: number | null;
  revenueChurnRate: number | null;
  arpu: number | null;
  cac: number | null;
  ltv: number | null;
  ltvAssumedLifetime: boolean;
  ltvToCac: number | null;
  paybackMonths: number | null;
  momGrowth: number | null;
  series: MonthPoint[];
  verifiedOnly: boolean;
  notes: string[];
}

/** Expense categories that are cost of revenue (COGS) vs. acquisition spend. */
export const COGS_CATEGORIES = new Set(['infrastructure', 'ai', 'payment_fees']);
export const ACQUISITION_CATEGORIES = new Set(['ads', 'contractors', 'tools']);

const DAY = 86_400_000;
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export function computeRevenueMetrics(input: {
  events: RevenueEventLite[];
  expenses: ExpenseLite[];
  customers: CustomerLite[];
  now?: Date;
  months?: number;
  verifiedOnly?: boolean;
  /** Lifetime (months) assumed when churn is zero/unknown — shown as an assumption. */
  assumedLifetimeMonths?: number;
}): RevenueMetrics {
  const now = input.now ?? new Date();
  const notes: string[] = [];
  const verifiedOnly = input.verifiedOnly ?? false;
  const events = input.events.filter((e) => !verifiedOnly || e.verified).map((e) => ({ ...e, t: new Date(e.occurredAt).getTime() }));
  const expenses = input.expenses.map((e) => ({ ...e, t: new Date(e.occurredAt).getTime() }));
  const nowT = now.getTime();

  // Monthly series
  const monthsBack = input.months ?? 12;
  const series: MonthPoint[] = [];
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthsBack - 1), 1));
  for (let i = 0; i < monthsBack; i++) {
    const mStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)).getTime();
    const mEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 1)).getTime();
    const inMonth = events.filter((e) => e.t >= mStart && e.t < mEnd);
    const mrr = sum(events.filter((e) => e.t < mEnd).map((e) => e.mrrDeltaUsd));
    series.push({
      month: monthKey(new Date(mStart)),
      mrr: round(Math.max(0, mrr), 2),
      newMrr: round(sum(inMonth.filter((e) => e.type === 'subscription_started').map((e) => e.mrrDeltaUsd)), 2),
      churnedMrr: round(-sum(inMonth.filter((e) => e.type === 'subscription_canceled').map((e) => e.mrrDeltaUsd)), 2),
      expansionMrr: round(sum(inMonth.filter((e) => e.type === 'subscription_changed').map((e) => e.mrrDeltaUsd)), 2),
      revenue: round(sum(inMonth.filter((e) => e.type === 'charge').map((e) => e.amountUsd)) - sum(inMonth.filter((e) => e.type === 'refund').map((e) => e.amountUsd)), 2),
      expenses: round(sum(expenses.filter((e) => e.t >= mStart && e.t < mEnd).map((e) => e.amountUsd)), 2),
      newCustomers: input.customers.filter((c) => {
        const t = new Date(c.startedAt).getTime();
        return t >= mStart && t < mEnd;
      }).length,
      churnedCustomers: input.customers.filter((c) => {
        if (!c.churnedAt) return false;
        const t = new Date(c.churnedAt).getTime();
        return t >= mStart && t < mEnd;
      }).length,
    });
  }

  const mrr = Math.max(0, sum(events.filter((e) => e.t <= nowT).map((e) => e.mrrDeltaUsd)));
  const charges = events.filter((e) => e.type === 'charge');
  const refunds = events.filter((e) => e.type === 'refund');
  const revenueTotal = sum(charges.map((e) => e.amountUsd)) - sum(refunds.map((e) => e.amountUsd));
  const last30 = nowT - 30 * DAY;
  const revenueLast30 = sum(charges.filter((e) => e.t >= last30).map((e) => e.amountUsd)) - sum(refunds.filter((e) => e.t >= last30).map((e) => e.amountUsd));
  const refundsTotal = sum(refunds.map((e) => e.amountUsd));
  const cogs = sum(expenses.filter((e) => COGS_CATEGORIES.has(e.category)).map((e) => e.amountUsd));
  const fees = sum(expenses.filter((e) => e.category === 'payment_fees').map((e) => e.amountUsd));
  const netRevenue = revenueTotal - fees;
  const grossProfit = revenueTotal - cogs;
  const grossMargin = revenueTotal > 0 ? grossProfit / revenueTotal : null;
  const expensesLast30 = sum(expenses.filter((e) => e.t >= last30).map((e) => e.amountUsd));
  const burnLast30 = Math.max(0, expensesLast30 - revenueLast30);

  const active = input.customers.filter((c) => c.status === 'active');
  const newLast30 = input.customers.filter((c) => new Date(c.startedAt).getTime() >= last30).length;
  const churnedLast30 = input.customers.filter((c) => c.churnedAt && new Date(c.churnedAt).getTime() >= last30).length;
  const activeAtStart = input.customers.filter((c) => {
    const s = new Date(c.startedAt).getTime();
    const ch = c.churnedAt ? new Date(c.churnedAt).getTime() : Infinity;
    return s < last30 && ch >= last30;
  }).length;
  const customerChurnRate = activeAtStart > 0 ? churnedLast30 / activeAtStart : null;

  const prevMonth = series[series.length - 2];
  const curMonth = series[series.length - 1];
  const revenueChurnRate = prevMonth && prevMonth.mrr > 0 && curMonth ? curMonth.churnedMrr / prevMonth.mrr : null;

  const arpu = active.length > 0 ? mrr / active.length : null;

  const last90 = nowT - 90 * DAY;
  const acqSpend90 = sum(expenses.filter((e) => e.t >= last90 && ACQUISITION_CATEGORIES.has(e.category)).map((e) => e.amountUsd));
  const new90 = input.customers.filter((c) => new Date(c.startedAt).getTime() >= last90).length;
  const cac = new90 > 0 ? acqSpend90 / new90 : null;
  if (cac === null && acqSpend90 > 0) notes.push(`$${round(acqSpend90)} acquisition spend in 90 days produced no customers — CAC is unbounded.`);

  const gm = grossMargin ?? null;
  let ltv: number | null = null;
  let ltvAssumedLifetime = false;
  if (arpu !== null && gm !== null) {
    if (customerChurnRate && customerChurnRate > 0) {
      ltv = (arpu * gm) / customerChurnRate;
    } else {
      const life = input.assumedLifetimeMonths ?? 24;
      ltv = arpu * gm * life;
      ltvAssumedLifetime = true;
      notes.push(`No observed churn yet — LTV assumes a ${life}-month customer lifetime (MODEL ASSUMPTION).`);
    }
  }
  const ltvToCac = ltv !== null && cac !== null && cac > 0 ? ltv / cac : null;
  const paybackMonths = cac !== null && arpu !== null && gm !== null && arpu * gm > 0 ? cac / (arpu * gm) : null;

  const withMrr = series.filter((s) => s.mrr > 0);
  let momGrowth: number | null = null;
  if (withMrr.length >= 3) {
    const recent = series.slice(-4).filter((s) => s.mrr > 0);
    if (recent.length >= 2) {
      const first = recent[0]!.mrr;
      const last = recent[recent.length - 1]!.mrr;
      momGrowth = Math.pow(last / first, 1 / (recent.length - 1)) - 1;
    }
  } else {
    notes.push('Fewer than 3 months of MRR history — growth rate not computed.');
  }
  if (!events.length) notes.push(verifiedOnly ? 'No verified revenue events recorded.' : 'No revenue events recorded.');

  return {
    mrr: round(mrr, 2),
    arr: round(mrr * 12, 2),
    revenueTotal: round(revenueTotal, 2),
    revenueLast30: round(revenueLast30, 2),
    refundsTotal: round(refundsTotal, 2),
    netRevenue: round(netRevenue, 2),
    grossProfit: round(grossProfit, 2),
    grossMargin: grossMargin === null ? null : round(grossMargin, 4),
    expensesLast30: round(expensesLast30, 2),
    burnLast30: round(burnLast30, 2),
    activeCustomers: active.length,
    newCustomersLast30: newLast30,
    churnedCustomersLast30: churnedLast30,
    customerChurnRate: customerChurnRate === null ? null : round(customerChurnRate, 4),
    revenueChurnRate: revenueChurnRate === null ? null : round(revenueChurnRate, 4),
    arpu: arpu === null ? null : round(arpu, 2),
    cac: cac === null ? null : round(cac, 2),
    ltv: ltv === null ? null : round(ltv, 2),
    ltvAssumedLifetime,
    ltvToCac: ltvToCac === null ? null : round(ltvToCac, 2),
    paybackMonths: paybackMonths === null ? null : round(paybackMonths, 1),
    momGrowth: momGrowth === null ? null : round(momGrowth, 4),
    series,
    verifiedOnly,
    notes,
  };
}

/** Weighted pipeline value: Σ expected deal value × stage probability. Stage probabilities are assumptions. */
export const DEFAULT_STAGE_PROBABILITY: Record<string, number> = {
  new: 0.02,
  qualified: 0.08,
  contacted: 0.1,
  replied: 0.2,
  demo: 0.35,
  customer: 1,
  lost: 0,
  unsubscribed: 0,
};

export function pipelineValue(leads: { status: string; expectedValueUsd: number }[], stageProbability = DEFAULT_STAGE_PROBABILITY) {
  const byStage: Record<string, { count: number; value: number; weighted: number }> = {};
  for (const l of leads) {
    const p = stageProbability[l.status] ?? 0;
    const s = (byStage[l.status] ??= { count: 0, value: 0, weighted: 0 });
    s.count++;
    s.value += l.expectedValueUsd;
    s.weighted += l.expectedValueUsd * p;
  }
  return {
    total: round(sum(Object.values(byStage).map((s) => s.value)), 2),
    weighted: round(sum(Object.values(byStage).map((s) => s.weighted)), 2),
    byStage,
    assumption: 'Stage conversion probabilities are MODEL ASSUMPTIONS until enough closed deals exist to measure them.',
  };
}
