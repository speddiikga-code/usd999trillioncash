import type { ConsentBasis } from '@roos/shared';
import { clamp } from '@roos/shared';

/**
 * Transparent lead scoring (0–100): fit + intent, with contactability tracked separately.
 * A lead with consent basis "unknown" can be scored but is never contactable.
 */
export interface LeadScoreInput {
  title?: string | null;
  company?: string | null;
  email?: string | null;
  consentBasis: ConsentBasis;
  icpKeywords?: string[];
  events?: Partial<Record<'page_view' | 'signup' | 'activation' | 'demo_requested' | 'checkout_started' | 'referral', number>>;
  b2b?: boolean;
}

export interface LeadScore {
  score: number;
  contactable: boolean;
  breakdown: { factor: string; points: number; reason: string }[];
}

const FREE_EMAIL = /@(gmail|yahoo|hotmail|outlook|live|icloud|aol|proton|protonmail|gmx|mail)\./i;

export function scoreLead(input: LeadScoreInput): LeadScore {
  const breakdown: LeadScore['breakdown'] = [];
  const add = (factor: string, points: number, reason: string) => {
    if (points !== 0) breakdown.push({ factor, points, reason });
  };
  const title = (input.title ?? '').toLowerCase();
  if (/\b(founder|co-?founder|ceo|owner|president|principal|partner)\b/.test(title)) add('seniority', 20, 'Decision-maker title');
  else if (/\b(vp|vice president|head of|director|chief)\b/.test(title)) add('seniority', 15, 'Senior title');
  else if (/\b(manager|lead|lead)\b/.test(title)) add('seniority', 8, 'Manager title');

  const hay = `${title} ${(input.company ?? '').toLowerCase()}`;
  const icpHits = (input.icpKeywords ?? []).filter((k) => k && hay.includes(k.toLowerCase())).length;
  if (icpHits) add('icp_fit', Math.min(20, icpHits * 10), `Matches ${icpHits} ideal-customer keyword(s)`);

  if (input.email) {
    if (input.b2b && FREE_EMAIL.test(input.email)) add('email_domain', -5, 'Personal email domain for a B2B offer');
    else if (input.b2b) add('email_domain', 5, 'Company email domain');
  }

  const ev = input.events ?? {};
  if (ev.signup) add('intent_signup', 25, 'Signed up');
  if (ev.activation) add('intent_activation', 20, 'Activated in product');
  if (ev.demo_requested) add('intent_demo', 25, 'Requested a demo');
  if (ev.checkout_started) add('intent_checkout', 20, 'Started checkout');
  if (ev.page_view) add('engagement', Math.min(10, ev.page_view * 2), `${ev.page_view} page view(s)`);
  if (ev.referral) add('referral', 5, 'Came via referral');

  const contactable = input.consentBasis !== 'unknown' && !!input.email;
  if (!contactable) breakdown.push({ factor: 'contactability', points: 0, reason: input.email ? 'Consent basis unknown — will not be contacted' : 'No email address' });
  const score = clamp(breakdown.reduce((a, b) => a + b.points, 0), 0, 100);
  return { score, contactable, breakdown };
}
