import type { CompetitionAssessment, DataKind, EstimatedValue, OpportunitySignals, ScoreBreakdown, ScoreCriterion } from '@roos/shared';
import { clamp, hashSeed, round, seededRandom } from '@roos/shared';
import { quantiles, sampleTriangular } from './stats';

/**
 * Transparent opportunity scoring. Each criterion is normalised to 0..1 (higher = better for the
 * business), carries a plausible range, its provenance kind and a rationale. The overall score is
 * a weighted mean; its uncertainty interval comes from Monte Carlo over the criterion ranges.
 * Weights are versioned and can be recalibrated from real experiment outcomes (see learning.ts).
 */
export const DEFAULT_WEIGHTS: Record<string, number> = {
  demand_evidence: 0.18,
  pain_intensity: 0.14,
  willingness_to_pay: 0.14,
  market_size: 0.12,
  competition: 0.08,
  technical_feasibility: 0.08,
  regulatory_safety: 0.08,
  time_to_revenue: 0.08,
  distribution_ease: 0.06,
  strategic_fit: 0.04,
};
export const DEFAULT_WEIGHTS_VERSION = 'default-v1';

export const CRITERION_LABELS: Record<string, string> = {
  demand_evidence: 'Demand evidence',
  pain_intensity: 'Pain intensity',
  willingness_to_pay: 'Willingness to pay',
  market_size: 'Market size',
  competition: 'Competitive room',
  technical_feasibility: 'Technical feasibility',
  regulatory_safety: 'Regulatory safety',
  time_to_revenue: 'Time to revenue',
  distribution_ease: 'Distribution ease',
  strategic_fit: 'Strategic fit',
};

const KIND_CONFIDENCE: Record<DataKind, number> = { OBSERVED: 0.9, ESTIMATED: 0.6, USER_INPUT: 0.7, MODEL_ASSUMPTION: 0.25, DEMO: 0 };

export interface CriteriaInput {
  signals: OpportunitySignals;
  marketSize?: EstimatedValue | null;
  priceMonthly?: EstimatedValue | null;
  technicalComplexity?: EstimatedValue | null; // 0..1 (1 = very complex)
  regulatoryRisk?: EstimatedValue | null; // 0..1 (1 = heavily regulated)
  timeToMvpWeeks?: EstimatedValue | null;
  competition?: CompetitionAssessment | null;
  distributionDifficulty?: EstimatedValue | null; // 0..1
  strategicFit?: EstimatedValue | null; // 0..1
  isB2B?: boolean;
  now?: Date;
  demo?: boolean;
}

let demoMode = false;

function crit(key: string, value: number, low: number, high: number, rawKind: DataKind, rationale: string): ScoreCriterion {
  // Inside a demo workspace every input derives from synthetic data.
  const kind: DataKind = demoMode ? 'DEMO' : rawKind;
  const v = clamp(value, 0, 1);
  return { key, label: CRITERION_LABELS[key] ?? key, value: round(v, 3), low: round(clamp(Math.min(low, v), 0, 1), 3), high: round(clamp(Math.max(high, v), 0, 1), 3), weight: DEFAULT_WEIGHTS[key] ?? 0, kind, rationale };
}

function fromEstimate(key: string, est: EstimatedValue | null | undefined, invert: boolean, fallback: { value: number; low: number; high: number; rationale: string }, demo: boolean): ScoreCriterion {
  if (!est || typeof est.value !== 'number') {
    return crit(key, fallback.value, fallback.low, fallback.high, demo ? 'DEMO' : 'MODEL_ASSUMPTION', fallback.rationale);
  }
  const t = (x: number) => (invert ? 1 - clamp(x, 0, 1) : clamp(x, 0, 1));
  const lo = est.low ?? est.value;
  const hi = est.high ?? est.value;
  return crit(key, t(est.value), Math.min(t(lo), t(hi)), Math.max(t(lo), t(hi)), est.kind, est.rationale);
}

export function buildCriteria(input: CriteriaInput): ScoreCriterion[] {
  demoMode = !!input.demo;
  try {
    return buildCriteriaInner(input);
  } finally {
    demoMode = false;
  }
}

function buildCriteriaInner(input: CriteriaInput): ScoreCriterion[] {
  const s = input.signals;
  const demo = !!input.demo;
  const obsKind: DataKind = demo ? 'DEMO' : 'OBSERVED';
  const estKind: DataKind = demo ? 'DEMO' : 'ESTIMATED';
  const now = input.now ?? new Date();
  const out: ScoreCriterion[] = [];

  // Demand evidence — derived from counts of observed documents, sources and engagement.
  const docsTerm = clamp(Math.log10(1 + s.documentCount) / Math.log10(31), 0, 1);
  const srcTerm = clamp(s.distinctSources / 4, 0, 1);
  const engTerm = clamp(Math.log10(1 + s.totalEngagement) / 4, 0, 1);
  const ageDays = s.newestEvidenceAt ? (now.getTime() - new Date(s.newestEvidenceAt).getTime()) / 86_400_000 : 365;
  const recency = clamp(1 - ageDays / 180, 0, 1);
  const demand = 0.35 * docsTerm + 0.25 * srcTerm + 0.3 * engTerm + 0.1 * recency;
  const demandSpread = s.documentCount < 3 ? 0.25 : s.documentCount < 10 ? 0.15 : 0.08;
  out.push(
    crit('demand_evidence', demand, demand - demandSpread, demand + demandSpread, obsKind,
      `${s.documentCount} documents from ${s.distinctSources} source(s), total engagement ${s.totalEngagement}, newest ${Math.round(ageDays)} days old.`),
  );

  // Pain intensity — heuristic pattern strength across observed texts.
  const painSpread = s.documentCount < 5 ? 0.25 : 0.12;
  out.push(crit('pain_intensity', s.painScore, s.painScore - painSpread, s.painScore + painSpread, estKind,
    `Average pain-language strength ${round(s.painScore, 2)} across ${s.documentCount} observed documents (heuristic text analysis).`));

  // Willingness to pay
  const wtpRatio = s.documentCount > 0 ? s.willingnessToPayMentions / s.documentCount : 0;
  const priceBoost = input.priceMonthly && typeof input.priceMonthly.value === 'number' ? clamp(Math.log10(1 + input.priceMonthly.value) / 3, 0, 1) * 0.3 : 0.1;
  const wtp = clamp(0.2 + wtpRatio * 1.5 + (input.isB2B ? 0.15 : 0) + priceBoost, 0, 1);
  out.push(crit('willingness_to_pay', wtp, wtp - 0.25, wtp + 0.2, estKind,
    `${s.willingnessToPayMentions} explicit payment/price mentions in ${s.documentCount} documents${input.isB2B ? '; B2B segment' : ''}.`));

  // Market size ($1M → 0, $100B → 1 on a log scale)
  const ms = input.marketSize;
  if (ms && typeof ms.value === 'number' && ms.value > 0) {
    const f = (x: number) => clamp((Math.log10(Math.max(1, x)) - 6) / 5, 0, 1);
    out.push(crit('market_size', f(ms.value), f(ms.low ?? ms.value / 3), f(ms.high ?? ms.value * 3), ms.kind, ms.rationale));
  } else {
    out.push(crit('market_size', 0.4, 0.1, 0.8, demo ? 'DEMO' : 'MODEL_ASSUMPTION', 'No market sizing yet — neutral prior with wide uncertainty. Run /analyze.'));
  }

  // Competition
  const comp = input.competition;
  const compMap: Record<CompetitionAssessment['level'], [number, number, number]> = {
    none_found: [0.65, 0.35, 0.85],
    low: [0.8, 0.6, 0.9],
    medium: [0.55, 0.4, 0.7],
    high: [0.3, 0.15, 0.45],
    unknown: [0.5, 0.2, 0.8],
  };
  const [cv, cl, ch] = compMap[comp?.level ?? 'unknown'];
  out.push(crit('competition', cv, cl, ch, comp?.kind ?? (demo ? 'DEMO' : 'MODEL_ASSUMPTION'),
    comp ? `${comp.level.replace('_', ' ')}: ${comp.rationale}` : `Competition not assessed yet; ${s.competitorMentions} competitor/alternative mentions observed.`));

  out.push(fromEstimate('technical_feasibility', input.technicalComplexity, true, { value: 0.5, low: 0.25, high: 0.75, rationale: 'Complexity not assessed — neutral prior.' }, demo));
  out.push(fromEstimate('regulatory_safety', input.regulatoryRisk, true, { value: 0.6, low: 0.3, high: 0.9, rationale: 'Regulatory risk not assessed — neutral prior.' }, demo));

  // Time to revenue: 1 week → 1.0, 26 weeks → 0.0
  const ttm = input.timeToMvpWeeks;
  const tf = (w: number) => clamp(1 - (w - 1) / 25, 0, 1);
  if (ttm && typeof ttm.value === 'number') {
    out.push(crit('time_to_revenue', tf(ttm.value), tf(ttm.high ?? ttm.value * 1.5), tf(ttm.low ?? ttm.value * 0.7), ttm.kind, ttm.rationale));
  } else {
    out.push(crit('time_to_revenue', 0.5, 0.25, 0.75, demo ? 'DEMO' : 'MODEL_ASSUMPTION', 'Time to MVP not estimated — neutral prior.'));
  }

  out.push(fromEstimate('distribution_ease', input.distributionDifficulty, true, { value: 0.5, low: 0.2, high: 0.8, rationale: 'Distribution difficulty not assessed — neutral prior.' }, demo));
  out.push(fromEstimate('strategic_fit', input.strategicFit, false, { value: 0.5, low: 0.3, high: 0.7, rationale: 'No industries of interest configured — neutral prior.' }, demo));
  return out;
}

export function scoreOpportunity(criteria: ScoreCriterion[], opts: { weights?: Record<string, number>; weightsVersion?: string; seed?: string; samples?: number } = {}): ScoreBreakdown {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const withW = criteria.map((c) => ({ ...c, weight: weights[c.key] ?? c.weight ?? 0 }));
  const totalW = withW.reduce((a, c) => a + c.weight, 0) || 1;
  const score = withW.reduce((a, c) => a + c.weight * c.value, 0) / totalW;

  const rng = seededRandom(hashSeed(opts.seed ?? JSON.stringify(withW.map((c) => [c.key, c.value]))));
  const n = opts.samples ?? 2000;
  const samples: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (const c of withW) acc += c.weight * sampleTriangular(c.low, c.value, c.high, rng);
    samples[i] = acc / totalW;
  }
  const [p10, p90] = quantiles(samples, [0.1, 0.9]);
  const kindConf = withW.reduce((a, c) => a + c.weight * KIND_CONFIDENCE[c.kind], 0) / totalW;
  const widthPenalty = clamp(1 - (p90! - p10!) * 2, 0, 1);
  const confidence = clamp(kindConf * (0.5 + 0.5 * widthPenalty), 0, 1);

  return {
    score: round(score, 4),
    low: round(p10!, 4),
    high: round(p90!, 4),
    criteria: withW.map((c) => ({ ...c, weight: round(c.weight / totalW, 4) })),
    confidence: round(confidence, 3),
    weightsVersion: opts.weightsVersion ?? DEFAULT_WEIGHTS_VERSION,
    computedAt: new Date().toISOString(),
  };
}
