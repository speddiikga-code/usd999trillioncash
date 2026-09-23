import { round } from '@roos/shared';

/**
 * "Quadrillion Roadmap" — an honest scenario model for the extreme long-term target of
 * $9,999,000,000,000,000 cumulative revenue. It never claims the target is achievable; it shows
 * what would have to be true (required CAGR, number of businesses, customers, capital) and
 * compares that with reference magnitudes (world GDP, world population) that the user can edit.
 *
 * All inputs are assumptions unless they come from verified revenue data (clearly labelled).
 */
export interface RoadmapAssumptions {
  targetUsd: number;
  horizonYears: number;
  /** Starting ARR if there is no verified revenue yet (hypothetical, labelled as such). */
  startingArrUsd: number;
  avgArrPerBusinessUsd: number;
  arpuPerYearUsd: number;
  /** Capital burned per $1 of net new ARR. */
  burnMultiple: number;
  /** REFERENCE: world GDP (nominal USD / year). Editable. */
  worldGdpUsd: number;
  worldGdpGrowth: number;
  /** REFERENCE: world population. Editable. */
  worldPopulation: number;
  conservativeGrowth: number;
  baseGrowth: number;
  aggressiveGrowth: number;
  /** Annual multiplicative decay of the growth rate (growth slows as companies scale). */
  growthDecay: number;
}

export const DEFAULT_ROADMAP_ASSUMPTIONS: RoadmapAssumptions = {
  targetUsd: 9_999_000_000_000_000,
  horizonYears: 30,
  startingArrUsd: 12_000,
  avgArrPerBusinessUsd: 10_000_000,
  arpuPerYearUsd: 1_200,
  burnMultiple: 1.5,
  worldGdpUsd: 110e12,
  worldGdpGrowth: 0.03,
  worldPopulation: 8.2e9,
  conservativeGrowth: 0.4,
  baseGrowth: 1.0,
  aggressiveGrowth: 2.5,
  growthDecay: 0.12,
};

export const ROADMAP_ASSUMPTION_NOTES: Record<keyof RoadmapAssumptions, string> = {
  targetUsd: 'Aspirational optimisation target (cumulative revenue). Not a forecast.',
  horizonYears: 'Planning horizon. MODEL ASSUMPTION.',
  startingArrUsd: 'Used only when there is no verified revenue yet. HYPOTHETICAL.',
  avgArrPerBusinessUsd: 'Average ARR of a mature portfolio business. MODEL ASSUMPTION.',
  arpuPerYearUsd: 'Average revenue per customer per year. MODEL ASSUMPTION.',
  burnMultiple: 'Capital burned per $1 of net new ARR. MODEL ASSUMPTION.',
  worldGdpUsd: 'REFERENCE: approximate nominal world GDP (~$110T, IMF WEO estimate for 2024). Verify and edit.',
  worldGdpGrowth: 'REFERENCE: nominal world GDP growth. MODEL ASSUMPTION.',
  worldPopulation: 'REFERENCE: approximate world population (~8.2B, UN estimate). Verify and edit.',
  conservativeGrowth: 'Year-1 annual ARR growth in the conservative scenario. MODEL ASSUMPTION.',
  baseGrowth: 'Year-1 annual ARR growth in the base scenario. MODEL ASSUMPTION.',
  aggressiveGrowth: 'Year-1 annual ARR growth in the aggressive scenario. MODEL ASSUMPTION.',
  growthDecay: 'Each year growth is multiplied by (1 − decay). MODEL ASSUMPTION.',
};

export interface RoadmapObserved {
  verifiedArrUsd: number;
  verifiedCumulativeRevenueUsd: number;
  observedMonthlyGrowth: number | null;
  monthsOfData: number;
}

export interface ScenarioResult {
  name: string;
  initialGrowth: number;
  decay: number;
  trajectory: { year: number; arrUsd: number; cumulativeUsd: number; growth: number; worldGdpUsd: number }[];
  cumulativeAtHorizonUsd: number;
  pctOfTarget: number;
  yearsToTarget: number | null;
  peakArrToGdp: number;
}

export interface RoadmapResult {
  assumptions: RoadmapAssumptions;
  notes: Record<string, string>;
  current: {
    verifiedArrUsd: number;
    verifiedCumulativeRevenueUsd: number;
    progressFraction: number;
    startingArrUsed: number;
    startingArrIsHypothetical: boolean;
    observedAnnualGrowth: number | null;
    monthsOfData: number;
  };
  required: {
    cagr: number | null;
    finalYearArrUsd: number | null;
    finalArrToWorldGdp: number | null;
    businesses: number | null;
    customers: number | null;
    customersToWorldPopulation: number | null;
    capitalUsd: number | null;
  };
  observedGrowthProjection: { yearsToTarget: number | null; cumulativeAtHorizonUsd: number } | null;
  scenarios: ScenarioResult[];
  milestones: { label: string; arrUsd: number; reached: boolean }[];
  feasibility: string[];
}

function cumulativeAtConstantGrowth(a0: number, g: number, years: number): number {
  let arr = a0;
  let cum = 0;
  for (let t = 1; t <= years; t++) {
    arr *= 1 + g;
    cum += arr;
  }
  return cum;
}

/** Solve for the constant annual growth rate that reaches `target` cumulative revenue in `years`. */
export function requiredCagr(a0: number, target: number, years: number): number | null {
  if (a0 <= 0 || years <= 0) return null;
  let lo = -0.99;
  let hi = 1;
  while (cumulativeAtConstantGrowth(a0, hi, years) < target && hi < 1e6) hi *= 2;
  if (hi >= 1e6) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cumulativeAtConstantGrowth(a0, mid, years) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function runScenario(name: string, a0: number, g0: number, decay: number, a: RoadmapAssumptions): ScenarioResult {
  const trajectory: ScenarioResult['trajectory'] = [];
  let arr = a0;
  let cum = 0;
  let yearsToTarget: number | null = null;
  let peakRatio = 0;
  for (let t = 1; t <= 300; t++) {
    const g = g0 * Math.pow(1 - decay, t - 1);
    arr *= 1 + g;
    cum += arr;
    const gdp = a.worldGdpUsd * Math.pow(1 + a.worldGdpGrowth, t);
    if (t <= a.horizonYears) {
      trajectory.push({ year: t, arrUsd: arr, cumulativeUsd: cum, growth: g, worldGdpUsd: gdp });
      peakRatio = Math.max(peakRatio, arr / gdp);
    }
    if (yearsToTarget === null && cum >= a.targetUsd) yearsToTarget = t;
    if (t >= a.horizonYears && (yearsToTarget !== null || g < 1e-6)) break;
  }
  const atHorizon = trajectory[trajectory.length - 1]?.cumulativeUsd ?? 0;
  return {
    name,
    initialGrowth: g0,
    decay,
    trajectory,
    cumulativeAtHorizonUsd: atHorizon,
    pctOfTarget: atHorizon / a.targetUsd,
    yearsToTarget,
    peakArrToGdp: peakRatio,
  };
}

export function computeRoadmap(assumptions: Partial<RoadmapAssumptions>, observed: RoadmapObserved): RoadmapResult {
  const a: RoadmapAssumptions = { ...DEFAULT_ROADMAP_ASSUMPTIONS, ...Object.fromEntries(Object.entries(assumptions).filter(([, v]) => v !== undefined && Number.isFinite(v as number))) };
  const hypothetical = observed.verifiedArrUsd <= 0;
  const a0 = hypothetical ? a.startingArrUsd : observed.verifiedArrUsd;
  const cagr = requiredCagr(a0, a.targetUsd, a.horizonYears);
  const finalArr = cagr === null ? null : a0 * Math.pow(1 + cagr, a.horizonYears);
  const gdpN = a.worldGdpUsd * Math.pow(1 + a.worldGdpGrowth, a.horizonYears);
  const observedAnnual = observed.observedMonthlyGrowth === null ? null : Math.pow(1 + observed.observedMonthlyGrowth, 12) - 1;

  const scenarios = [
    runScenario('Conservative', a0, a.conservativeGrowth, a.growthDecay, a),
    runScenario('Base', a0, a.baseGrowth, a.growthDecay, a),
    runScenario('Aggressive', a0, a.aggressiveGrowth, a.growthDecay, a),
  ];
  if (cagr !== null) scenarios.push(runScenario('Required constant CAGR', a0, cagr, 0, a));

  let observedGrowthProjection: RoadmapResult['observedGrowthProjection'] = null;
  if (observedAnnual !== null && !hypothetical) {
    const sc = runScenario('Observed growth (constant)', a0, observedAnnual, 0, a);
    observedGrowthProjection = { yearsToTarget: sc.yearsToTarget, cumulativeAtHorizonUsd: sc.cumulativeAtHorizonUsd };
  }

  const milestones = [
    { label: '$1k MRR', arrUsd: 12_000 },
    { label: '$10k MRR', arrUsd: 120_000 },
    { label: '$100k MRR', arrUsd: 1_200_000 },
    { label: '$10M ARR', arrUsd: 10e6 },
    { label: '$100M ARR', arrUsd: 100e6 },
    { label: '$1B ARR', arrUsd: 1e9 },
    { label: '$10B ARR', arrUsd: 10e9 },
    { label: '$100B ARR', arrUsd: 100e9 },
    { label: '$1T ARR', arrUsd: 1e12 },
    { label: '$10T ARR', arrUsd: 10e12 },
  ].map((m) => ({ ...m, reached: observed.verifiedArrUsd >= m.arrUsd }));

  const feasibility: string[] = [];
  if (hypothetical) feasibility.push(`No verified revenue yet. Calculations start from a HYPOTHETICAL $${a0.toLocaleString()} ARR.`);
  if (cagr !== null && finalArr !== null) {
    feasibility.push(`Reaching the target in ${a.horizonYears} years requires ${round(cagr * 100, 1)}% annual growth, sustained every year.`);
    feasibility.push(`Final-year revenue would be ${formatRatio(finalArr / gdpN)} the (assumed) world GDP of that year.`);
    feasibility.push(`That implies ~${formatBig(finalArr / a.arpuPerYearUsd)} paying customers at $${a.arpuPerYearUsd}/yr — ${formatRatio(finalArr / a.arpuPerYearUsd / a.worldPopulation)} the world population.`);
  }
  feasibility.push(`The target equals ${formatRatio(a.targetUsd / a.worldGdpUsd)} one year of (assumed) world GDP.`);
  const reaching = scenarios.filter((s) => s.name !== 'Required constant CAGR' && s.yearsToTarget !== null);
  feasibility.push(
    reaching.length
      ? `Scenarios reaching the target: ${reaching.map((s) => `${s.name} (${s.yearsToTarget}y)`).join(', ')}.`
      : 'None of the decaying-growth scenarios reach the target — growth slows faster than compounding can close the gap.',
  );
  if (observedGrowthProjection && observedAnnual !== null) {
    feasibility.push(
      `Holding the observed ${round(observedAnnual * 100, 0)}% annual growth constant ${observedGrowthProjection.yearsToTarget ? `would reach the target in ${observedGrowthProjection.yearsToTarget} years` : 'would not reach the target'} — but early-stage growth rates always decay as revenue grows (${observed.monthsOfData} months of data), so treat this as a sanity check, not a forecast.`,
    );
  }
  feasibility.push('Use this model to track empirical progress (verified ARR, observed growth) — not as a promise.');

  return {
    assumptions: a,
    notes: ROADMAP_ASSUMPTION_NOTES,
    current: {
      verifiedArrUsd: observed.verifiedArrUsd,
      verifiedCumulativeRevenueUsd: observed.verifiedCumulativeRevenueUsd,
      progressFraction: observed.verifiedCumulativeRevenueUsd / a.targetUsd,
      startingArrUsed: a0,
      startingArrIsHypothetical: hypothetical,
      observedAnnualGrowth: observedAnnual === null ? null : round(observedAnnual, 4),
      monthsOfData: observed.monthsOfData,
    },
    required: {
      cagr: cagr === null ? null : round(cagr, 4),
      finalYearArrUsd: finalArr,
      finalArrToWorldGdp: finalArr === null ? null : finalArr / gdpN,
      businesses: finalArr === null ? null : Math.ceil(finalArr / a.avgArrPerBusinessUsd),
      customers: finalArr === null ? null : Math.ceil(finalArr / a.arpuPerYearUsd),
      customersToWorldPopulation: finalArr === null ? null : finalArr / a.arpuPerYearUsd / a.worldPopulation,
      capitalUsd: finalArr === null ? null : Math.max(0, finalArr - a0) * a.burnMultiple,
    },
    observedGrowthProjection,
    scenarios,
    milestones,
    feasibility,
  };
}

function formatRatio(r: number): string {
  if (r >= 10) return `${round(r, 0).toLocaleString()}×`;
  if (r >= 1) return `${round(r, 1)}×`;
  return `${round(r * 100, r < 0.01 ? 4 : 1)}% of`;
}

function formatBig(n: number): string {
  if (n >= 1e12) return `${round(n / 1e12, 1)} trillion`;
  if (n >= 1e9) return `${round(n / 1e9, 1)} billion`;
  if (n >= 1e6) return `${round(n / 1e6, 1)} million`;
  return Math.round(n).toLocaleString();
}
