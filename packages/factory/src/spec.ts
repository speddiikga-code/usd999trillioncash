import { slugify, type BusinessHypothesis, type MvpEntity, type Opportunity } from '@roos/shared';

export const GENERATOR_VERSION = 'roos-mvp-factory/1.0.0';

export interface EntitySpec extends MvpEntity {
  plural: string;
}

/** Full product specification from which an MVP is generated. */
export interface MvpSpec {
  name: string;
  slug: string;
  tagline: string;
  problem: string;
  targetCustomer: string;
  valueProposition: string;
  coreFeatures: string[];
  entities: EntitySpec[];
  pricingTiers: { name: string; priceUsdMonthly: number; features: string[] }[];
  pricingKind: string;
  onboardingSteps: string[];
  analyticsEvents: { event: string; when: string }[];
  successMetrics: { metric: string; target: string }[];
  variants: string[];
  headlines: Record<string, string>;
  provenance: { opportunityId?: string; hypothesisId?: string; businessModel?: string; generatedAt: string; assumptions: string[] };
}

export function pluralize(name: string): string {
  const n = name.toLowerCase();
  if (/[^aeiou]y$/.test(n)) return n.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(n)) return n + 'es';
  return n + 's';
}

const RESERVED = new Set(['signups', 'events', 'checkout', 'spec', 'health', 'static']);

/** Normalise entities: safe identifiers, unique plural route names, bounded field lists. */
export function normalizeEntities(entities: MvpEntity[]): EntitySpec[] {
  const out: EntitySpec[] = [];
  for (const e of entities.slice(0, 4)) {
    const name = e.name.replace(/[^A-Za-z0-9]/g, '').replace(/^[^A-Za-z]+/, '') || 'Item';
    let plural = pluralize(name);
    if (RESERVED.has(plural) || out.some((o) => o.plural === plural)) plural = `${plural}-${out.length + 1}`;
    const seen = new Set<string>();
    const fields = e.fields
      .map((f) => ({ ...f, name: f.name.replace(/[^A-Za-z0-9]/g, '').replace(/^[^A-Za-z]+/, '') }))
      .filter((f) => f.name && !['id', 'createdAt', 'updatedAt'].includes(f.name) && !seen.has(f.name) && seen.add(f.name))
      .slice(0, 12);
    if (!fields.some((f) => f.required)) fields[0] = { ...fields[0]!, required: true };
    out.push({ name: name.charAt(0).toUpperCase() + name.slice(1), plural, fields });
  }
  return out.length ? out : [{ name: 'Item', plural: 'items', fields: [{ name: 'title', type: 'string', required: true }] }];
}

export function buildSpec(opp: Pick<Opportunity, 'id' | 'title' | 'problem' | 'customer'>, h: BusinessHypothesis, opts: { variants?: string[]; headlines?: Record<string, string> } = {}): MvpSpec {
  const name = (h.mvpSpec?.name || opp.title).slice(0, 60);
  const variants = opts.variants?.length ? opts.variants : ['control'];
  const headlines = { control: h.mvpSpec?.tagline || h.valueProposition.slice(0, 90), ...(opts.headlines ?? {}) };
  return {
    name,
    slug: slugify(name, 40),
    tagline: h.mvpSpec?.tagline || h.valueProposition.slice(0, 90),
    problem: opp.problem.slice(0, 1200),
    targetCustomer: h.targetCustomer || opp.customer,
    valueProposition: h.valueProposition,
    coreFeatures: (h.mvpSpec?.coreFeatures ?? []).slice(0, 6),
    entities: normalizeEntities(h.mvpSpec?.entities ?? []),
    pricingTiers: (h.pricing?.tiers ?? []).slice(0, 4),
    pricingKind: h.pricing?.kind ?? 'MODEL_ASSUMPTION',
    onboardingSteps: ['Join the early-access list', 'Create your first record', 'Invite a teammate', 'Review the weekly summary'],
    analyticsEvents: [
      { event: 'page_view', when: 'Landing page loaded (with experiment variant)' },
      { event: 'cta_click', when: 'Pricing / CTA button clicked' },
      { event: 'signup', when: 'Early-access form submitted with a valid email' },
      { event: 'activation', when: 'First record created in the app' },
      { event: 'checkout_started', when: 'Checkout requested' },
    ],
    successMetrics: (h.experimentPlan ?? []).map((s) => ({ metric: s.metric, target: s.threshold })),
    variants,
    headlines,
    provenance: {
      opportunityId: opp.id,
      hypothesisId: h.id,
      businessModel: h.model,
      generatedAt: new Date().toISOString(),
      assumptions: [
        `Pricing tiers are ${h.pricing?.kind ?? 'MODEL_ASSUMPTION'} — validate with the pricing experiment before charging.`,
        'Copy is generated from the opportunity analysis; review it before publishing.',
        'No customer data exists until real visitors sign up.',
      ],
    },
  };
}
