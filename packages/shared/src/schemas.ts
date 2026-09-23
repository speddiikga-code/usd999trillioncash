import { z } from 'zod';
import {
  ACTION_MODES,
  BUSINESS_MODELS,
  CONSENT_BASES,
  LEAD_STATUSES,
  OPPORTUNITY_STATUSES,
  ROLES,
  TRACKING_EVENTS,
} from './types';
import { ACTIONS } from './types';

/** Input validation schemas shared by the API, CLI and dashboard. */

const shortText = (max = 200) => z.string().trim().min(1).max(max);
const longText = (max = 5000) => z.string().trim().max(max);

export const registerSchema = z.object({
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  password: z.string().min(12, 'Password must be at least 12 characters').max(200),
  name: shortText(100),
  orgName: shortText(100).default('My Workspace'),
});

export const loginSchema = z.object({
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(200),
});

export const apiKeyCreateSchema = z.object({
  name: shortText(80),
  role: z.enum(ROLES).default('operator'),
});

export const memberInviteSchema = z.object({
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  name: shortText(100),
  role: z.enum(ROLES),
  password: z.string().min(12).max(200),
});

export const discoverSchema = z.object({
  query: shortText(300),
  sources: z.array(z.string().max(64)).max(20).optional(),
  limitPerSource: z.number().int().min(1).max(100).default(30),
  industries: z.array(shortText(60)).max(20).optional(),
});

export const opportunityCreateSchema = z.object({
  title: shortText(200),
  problem: longText(4000).min(1),
  customer: shortText(300),
  market: shortText(300),
  tags: z.array(shortText(40)).max(20).default([]),
  industries: z.array(shortText(60)).max(20).default([]),
  sourceUrls: z.array(z.url().max(2000)).max(50).default([]),
  estimatedPriceUsdMonthly: z.number().min(0).max(1_000_000).optional(),
  notes: longText(4000).optional(),
});

export const opportunityUpdateSchema = z.object({
  title: shortText(200).optional(),
  problem: longText(4000).optional(),
  customer: shortText(300).optional(),
  market: shortText(300).optional(),
  status: z.enum(OPPORTUNITY_STATUSES).optional(),
  tags: z.array(shortText(40)).max(20).optional(),
});

export const opportunityListQuery = z.object({
  status: z.enum(OPPORTUNITY_STATUSES).optional(),
  q: z.string().max(200).optional(),
  minScore: z.coerce.number().min(0).max(1).optional(),
  sort: z.enum(['score', 'created', 'updated']).default('score'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const buildSchema = z.object({
  hypothesisId: z.string().max(64).optional(),
});

export const thresholdsSchema = z.object({
  targetRate: z.number().gt(0).lt(1).optional(),
  minSample: z.number().int().min(10).max(1_000_000).optional(),
  scaleProbability: z.number().min(0.5).max(0.999).optional(),
  killProbability: z.number().min(0.001).max(0.5).optional(),
  killFraction: z.number().min(0.05).max(0.95).optional(),
  maxDays: z.number().int().min(1).max(365).optional(),
  maxBudgetUsd: z.number().min(0).max(10_000_000).optional(),
  maxCacUsd: z.number().min(0).optional(),
  minLtvToCac: z.number().min(0).optional(),
  maxComplaintRate: z.number().min(0).max(1).optional(),
});

export const experimentCreateSchema = z.object({
  opportunityId: z.string().max(64).optional(),
  productId: z.string().max(64).optional(),
  name: shortText(200).optional(),
  hypothesis: longText(2000).optional(),
  budgetUsd: z.number().min(0).max(10_000_000).default(0),
  variants: z.array(z.string().regex(/^[a-z0-9_-]{1,32}$/i)).min(1).max(6).default(['control']),
  thresholds: thresholdsSchema.default({}),
  funnel: z.enum(['landing_signup', 'signup_paid', 'landing_paid']).default('landing_signup'),
});

export const approvalDecisionSchema = z.object({
  note: longText(2000).optional(),
});

export const trackEventSchema = z.object({
  event: z.enum(TRACKING_EVENTS),
  anonymousId: z.string().min(1).max(128),
  experimentId: z.string().max(64).optional(),
  variant: z.string().max(32).optional(),
  email: z.email().max(254).optional(),
  name: z.string().max(200).optional(),
  ref: z.string().max(64).optional(),
  path: z.string().max(500).optional(),
  valueUsd: z.number().min(0).max(1_000_000).optional(),
  properties: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional(),
  occurredAt: z.iso.datetime().optional(),
});

export const leadCreateSchema = z.object({
  name: shortText(200),
  email: z.email().max(254).optional(),
  company: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  website: z.url().max(2000).optional(),
  consentBasis: z.enum(CONSENT_BASES),
  source: shortText(100).default('manual'),
  opportunityId: z.string().max(64).optional(),
  productId: z.string().max(64).optional(),
  notes: longText(2000).optional(),
});

export const leadUpdateSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  notes: longText(2000).optional(),
  consentBasis: z.enum(CONSENT_BASES).optional(),
});

export const leadImportSchema = z.object({
  csv: z.string().max(2_000_000),
  source: shortText(100).default('csv_import'),
  defaultConsentBasis: z.enum(CONSENT_BASES).default('unknown'),
  opportunityId: z.string().max(64).optional(),
});

export const campaignCreateSchema = z.object({
  name: shortText(200),
  productId: z.string().max(64).optional(),
  opportunityId: z.string().max(64).optional(),
  experimentId: z.string().max(64).optional(),
  leadIds: z.array(z.string().max(64)).max(5000).optional(),
  minLeadScore: z.number().min(0).max(100).optional(),
  subjectTemplate: shortText(200),
  bodyTemplate: longText(10_000).min(1),
});

export const revenueManualSchema = z.object({
  type: z.enum(['charge', 'refund', 'subscription_started', 'subscription_canceled', 'subscription_changed']),
  amountUsd: z.number().min(0).max(100_000_000),
  mrrUsd: z.number().min(0).max(100_000_000).optional(),
  occurredAt: z.iso.datetime().optional(),
  productId: z.string().max(64).optional(),
  customerId: z.string().max(64).optional(),
  customerEmail: z.email().optional(),
  note: longText(1000).optional(),
});

export const expenseCreateSchema = z.object({
  category: z.enum(['ads', 'infrastructure', 'ai', 'tools', 'contractors', 'payment_fees', 'other']),
  amountUsd: z.number().min(0).max(100_000_000),
  occurredAt: z.iso.datetime().optional(),
  productId: z.string().max(64).optional(),
  experimentId: z.string().max(64).optional(),
  description: longText(500).optional(),
});

export const policyUpdateSchema = z.object({
  action: z.enum(Object.keys(ACTIONS) as [keyof typeof ACTIONS, ...(keyof typeof ACTIONS)[]]),
  mode: z.enum(ACTION_MODES),
  limits: z
    .object({
      maxAmountUsd: z.number().min(0).optional(),
      maxPerDay: z.number().int().min(0).optional(),
    })
    .optional(),
});

export const secretSetSchema = z.object({
  name: z.enum([
    'ai.openai.api_key',
    'ai.anthropic.api_key',
    'ai.google.api_key',
    'ai.ollama.base_url',
    'connector.github.token',
    'connector.brave.api_key',
    'connector.stackexchange.key',
    'billing.stripe.secret_key',
    'billing.stripe.webhook_secret',
    'email.resend.api_key',
  ]),
  value: z.string().min(1).max(4000),
});

export const commandSchema = z.object({
  command: z.string().trim().min(1).max(1000),
});

export const sourceConfigSchema = z.object({
  connector: z.string().regex(/^[a-z0-9_]{2,40}$/),
  name: shortText(100),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const orgSettingsSchema = z.object({
  name: shortText(100).optional(),
  constraints: z
    .object({
      initialCapitalUsd: z.number().min(0).max(1e12).optional(),
      monthlyBudgetUsd: z.number().min(0).max(1e12).optional(),
      hoursPerWeek: z.number().min(0).max(168).optional(),
      riskTolerance: z.enum(['low', 'medium', 'high']).optional(),
    })
    .optional(),
  industries: z.array(shortText(60)).max(30).optional(),
  excludedIndustries: z.array(shortText(60)).max(30).optional(),
  aiDailyBudgetUsd: z.number().min(0).max(10_000).optional(),
});

export const onboardingStepSchema = z.object({
  step: z.string().max(40),
  done: z.boolean().default(true),
});

export const roadmapAssumptionsSchema = z.object({
  targetUsd: z.number().positive().max(1e20).optional(),
  horizonYears: z.number().int().min(1).max(200).optional(),
  startingArrUsd: z.number().min(0).max(1e16).optional(),
  avgArrPerBusinessUsd: z.number().positive().max(1e15).optional(),
  arpuPerYearUsd: z.number().positive().max(1e9).optional(),
  burnMultiple: z.number().min(0).max(100).optional(),
  worldGdpUsd: z.number().positive().optional(),
  worldGdpGrowth: z.number().min(-0.5).max(1).optional(),
  worldPopulation: z.number().positive().optional(),
  conservativeGrowth: z.number().min(-0.9).max(100).optional(),
  baseGrowth: z.number().min(-0.9).max(100).optional(),
  aggressiveGrowth: z.number().min(-0.9).max(100).optional(),
  growthDecay: z.number().min(0).max(1).optional(),
});

export const portfolioAllocateSchema = z.object({
  budgetUsd: z.number().min(0).max(1e12),
  minPerOpportunityUsd: z.number().min(0).default(0),
  maxShare: z.number().min(0.05).max(1).default(0.5),
  explorationFloor: z.number().min(0).max(0.5).default(0.05),
});

export const hypothesisSelectSchema = z.object({
  hypothesisId: z.string().max(64),
});

export const businessModelSchema = z.enum(BUSINESS_MODELS);

export type RegisterInput = z.infer<typeof registerSchema>;
export type DiscoverInput = z.infer<typeof discoverSchema>;
export type OpportunityCreateInput = z.infer<typeof opportunityCreateSchema>;
export type ExperimentCreateInput = z.infer<typeof experimentCreateSchema>;
export type TrackEventInput = z.infer<typeof trackEventSchema>;
export type LeadCreateInput = z.infer<typeof leadCreateSchema>;
export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>;
export type RoadmapAssumptionsInput = z.infer<typeof roadmapAssumptionsSchema>;
export type PolicyUpdateInput = z.infer<typeof policyUpdateSchema>;
