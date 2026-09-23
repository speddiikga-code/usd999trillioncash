import { inferSegments, screenRegulatory, type SegmentHint } from '@roos/analytics';
import {
  assumption,
  clamp,
  estimated,
  round,
  type CompetitionAssessment,
  type EstimatedValue,
  type SourceRef,
} from '@roos/shared';

/**
 * Discovery- and analysis-time estimators. Every output is explicitly labelled:
 *  - MODEL_ASSUMPTION when it is a prior (placeholder to be replaced by evidence),
 *  - ESTIMATED when it is computed from observed inputs by a documented heuristic.
 */

const PRICE_RE = /\$\s?(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:\/|per|a)\s*(mo|month|user|seat|year|yr|annum)\b/gi;

/** Extract explicit monthly price mentions ("$49/month", "$10 per seat", "$600/year"). */
export function extractPriceMentions(texts: string[]): number[] {
  const out: number[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(PRICE_RE)) {
      const v = Number(m[1]!.replace(',', '.'));
      const unit = m[2]!.toLowerCase();
      const monthly = /year|yr|annum/.test(unit) ? v / 12 : v;
      if (monthly > 0 && monthly < 20_000) out.push(monthly);
    }
  }
  return out;
}

export function priceEstimate(isB2B: boolean, mentions: number[], sources: SourceRef[]): EstimatedValue {
  if (mentions.length >= 1) {
    const s = [...mentions].sort((a, b) => a - b);
    const median = s[Math.floor(s.length / 2)]!;
    // A single mention is weak evidence: widen the range to 0.5×–2×.
    const single = mentions.length === 1;
    return estimated(round(median, 2), round(single ? median * 0.5 : s[0]!, 2), round(single ? median * 2 : s[s.length - 1]!, 2), `Median of ${mentions.length} explicit price mention(s) in observed documents${single ? ' (single mention — wide range)' : ''}.`, {
      unit: 'USD/month',
      confidence: clamp(0.2 + mentions.length * 0.08, 0.2, 0.7),
      sources,
      computedBy: 'heuristic:price-mentions',
    });
  }
  return isB2B
    ? assumption(79, 29, 299, 'Prior for B2B SaaS seat/workspace pricing — validate with a pricing experiment.', { unit: 'USD/month', computedBy: 'prior:b2b-price' })
    : assumption(9, 3, 20, 'Prior for consumer subscription pricing — validate with a pricing experiment.', { unit: 'USD/month', computedBy: 'prior:b2c-price' });
}

export function cacPrior(isB2B: boolean): EstimatedValue {
  return isB2B
    ? assumption(300, 100, 900, 'Prior CAC for self-serve B2B SaaS; replace with measured CAC from experiments.', { unit: 'USD', computedBy: 'prior:cac' })
    : assumption(30, 8, 90, 'Prior CAC for consumer apps; replace with measured CAC from experiments.', { unit: 'USD', computedBy: 'prior:cac' });
}

export function grossMarginPrior(aiHeavy: boolean): EstimatedValue {
  return aiHeavy
    ? assumption(0.7, 0.5, 0.85, 'Prior gross margin for software with material AI inference costs.', { unit: 'ratio', computedBy: 'prior:gross-margin' })
    : assumption(0.82, 0.7, 0.92, 'Prior gross margin for hosted software.', { unit: 'ratio', computedBy: 'prior:gross-margin' });
}

export function churnPrior(isB2B: boolean): EstimatedValue {
  return isB2B
    ? assumption(0.03, 0.015, 0.07, 'Prior monthly logo churn for SMB SaaS.', { unit: 'ratio/month', computedBy: 'prior:churn' })
    : assumption(0.08, 0.04, 0.15, 'Prior monthly churn for consumer subscriptions.', { unit: 'ratio/month', computedBy: 'prior:churn' });
}

const COMPLEXITY_TRIGGERS: [RegExp, number, string][] = [
  [/\b(ai|llm|gpt|machine learning|ml model|computer vision|nlp)\b/i, 0.18, 'AI/ML component'],
  [/\b(integrat\w*|sync\w*|erp|quickbooks|salesforce|api)\b/i, 0.12, 'third-party integrations'],
  [/\b(hardware|iot|sensor|device|firmware|robot)\b/i, 0.3, 'hardware'],
  [/\b(real[- ]?time|streaming|video|latency)\b/i, 0.12, 'real-time/media'],
  [/\b(patient|medical|bank|payments?|trading|insurance)\b/i, 0.15, 'regulated data handling'],
  [/\b(marketplace|two[- ]sided)\b/i, 0.15, 'two-sided marketplace dynamics'],
  [/\b(mobile app|ios|android)\b/i, 0.08, 'native mobile'],
];

export function complexityEstimate(text: string): EstimatedValue {
  let v = 0.3;
  const hits: string[] = [];
  for (const [re, w, label] of COMPLEXITY_TRIGGERS) {
    if (re.test(text)) {
      v += w;
      hits.push(label);
    }
  }
  v = clamp(v, 0.1, 0.95);
  return estimated(round(v, 2), round(clamp(v - 0.15, 0, 1), 2), round(clamp(v + 0.15, 0, 1), 2), hits.length ? `Keyword heuristic: ${hits.join(', ')}.` : 'Keyword heuristic: no complexity triggers found (simple CRUD/workflow software assumed).', {
    unit: '0-1',
    confidence: 0.35,
    computedBy: 'heuristic:complexity',
  });
}

export function regulatoryEstimate(text: string): EstimatedValue & { flags: { area: string; risk: number; note: string }[] } {
  const r = screenRegulatory(text);
  return {
    ...estimated(round(r.risk, 2), round(clamp(r.risk - 0.15, 0, 1), 2), round(clamp(r.risk + 0.15, 0, 1), 2), r.flags.length ? `Regulatory keyword screen flagged: ${r.flags.map((f) => f.area).join(', ')}. Not legal advice.` : 'No regulated-domain keywords found. Not legal advice.', {
      unit: '0-1',
      confidence: 0.4,
      computedBy: 'heuristic:regulatory-screen',
    }),
    flags: r.flags,
  };
}

export function timeToMvpEstimate(complexity: number): EstimatedValue {
  const weeks = round(2 + complexity * 10, 1);
  return assumption(weeks, round(weeks * 0.6, 1), round(weeks * 1.8, 1), `Prior: 2 weeks + 10 weeks × complexity (${complexity}). Generated MVP scaffolds shorten the low end.`, { unit: 'weeks', computedBy: 'prior:time-to-mvp' });
}

export function marketSizeEstimate(segment: SegmentHint | undefined, price: EstimatedValue): EstimatedValue {
  const b = segment?.buyersAssumption ?? { low: 1e4, mode: 1e5, high: 1e6, note: 'Unknown segment — very wide prior.' };
  const p = Number(price.value);
  const reachable = { low: 0.005, mode: 0.02, high: 0.05 };
  const annual = (buyers: number, pr: number, share: number) => buyers * share * pr * 12;
  return assumption(
    Math.round(annual(b.mode, p, reachable.mode)),
    Math.round(annual(b.low, price.low ?? p, reachable.low)),
    Math.round(annual(b.high, price.high ?? p, reachable.high)),
    `Serviceable market = potential buyers (${b.note}) × reachable share (0.5–5%) × monthly price × 12. ` + 'Order-of-magnitude prior only — replace with sourced market data.',
    { unit: 'USD/year', computedBy: 'prior:market-size', confidence: 0.15 },
  );
}

export function strategicFitEstimate(text: string, industries: string[] | undefined): EstimatedValue | null {
  if (!industries?.length) return null;
  const hay = text.toLowerCase();
  const hits = industries.filter((i) => i.toLowerCase().split(/[\s/,&]+/).filter((w) => w.length > 2).some((w) => hay.includes(w)));
  const v = hits.length ? clamp(0.5 + 0.25 * hits.length, 0, 1) : 0.2;
  return estimated(v, clamp(v - 0.15, 0, 1), clamp(v + 0.1, 0, 1), hits.length ? `Matches industries of interest: ${hits.join(', ')}.` : `No overlap with configured industries (${industries.join(', ')}).`, { confidence: 0.6, computedBy: 'heuristic:strategic-fit' });
}

/** Communities where the pain was observed are also reachable distribution channels. */
export function distributionEstimate(connectors: string[]): EstimatedValue {
  const community = connectors.filter((c) => ['hackernews', 'stackexchange', 'github'].includes(c)).length;
  const v = community ? 0.45 : 0.6;
  return assumption(v, v - 0.2, v + 0.2, community ? 'Pain observed in reachable online communities (content/community distribution is plausible).' : 'No community channel observed yet.', { computedBy: 'prior:distribution' });
}

const ALT_RE = /\b(?:alternative to|alternatives to|switch(?:ed|ing)? (?:from|away from)|cheaper than|replace(?:ment for)?|instead of|better than|compared to|vs\.?)\s+([A-Z][\w.&-]{1,30}(?:\s[A-Z][\w.&-]{1,30})?)/g;

export function extractCompetitors(texts: string[]): { name: string; mentions: number }[] {
  const counts = new Map<string, number>();
  for (const t of texts) for (const m of t.matchAll(ALT_RE)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([n]) => !/^(The|This|That|It|I|We|You|They|A|An|Excel|Spreadsheets?)$/.test(n))
    .map(([name, mentions]) => ({ name, mentions }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 10);
}

export function competitionFromEvidence(texts: string[], searchResults: { name: string; url?: string }[] = []): CompetitionAssessment {
  const named = extractCompetitors(texts);
  const competitors = [
    ...named.map((c) => ({ name: c.name, note: `${c.mentions} mention(s) as an incumbent/alternative in observed documents` })),
    ...searchResults.map((r) => ({ name: r.name, url: r.url, note: 'Returned by web search for this problem' })),
  ];
  const n = competitors.length;
  if (!n) return { level: 'unknown', competitors: [], kind: 'MODEL_ASSUMPTION', rationale: 'No competitors identified yet — absence of evidence is not evidence of absence. Run web search or add competitor URLs.' };
  const level: CompetitionAssessment['level'] = n >= 6 ? 'high' : n >= 3 ? 'medium' : 'low';
  return { level, competitors: competitors.slice(0, 12), kind: 'OBSERVED', rationale: `${n} named incumbents/alternatives observed in evidence${searchResults.length ? ' and search results' : ''}.` };
}

export function primarySegment(text: string) {
  const s = inferSegments(text);
  return { segment: s[0]?.segment, isB2B: s[0]?.segment.b2b ?? true, all: s.slice(0, 3).map((x) => x.segment.segment) };
}
