import type { DataKind, EstimatedValue, SourceRef } from './provenance';

// ─────────────────────────────── Enumerations ───────────────────────────────

export const ROLES = ['owner', 'admin', 'operator', 'analyst', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const OPPORTUNITY_STATUSES = [
  'discovered',
  'analyzing',
  'analyzed',
  'validated',
  'building',
  'built',
  'launched',
  'experimenting',
  'scaling',
  'paused',
  'killed',
  'archived',
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const AGENT_NAMES = [
  'ResearchAgent',
  'MarketAgent',
  'CustomerAgent',
  'ProductAgent',
  'CodeAgent',
  'GrowthAgent',
  'SalesAgent',
  'FinanceAgent',
  'AnalyticsAgent',
  'RiskAgent',
  'SecurityAgent',
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'waiting_approval', 'cancelled', 'timed_out'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Permission modes for consequential actions (see ACTIONS). */
export const ACTION_MODES = ['READ_ONLY', 'SIMULATE', 'REQUIRE_APPROVAL', 'AUTONOMOUS'] as const;
export type ActionMode = (typeof ACTION_MODES)[number];
/** Ordering from most to least restrictive. */
export const ACTION_MODE_RANK: Record<ActionMode, number> = { READ_ONLY: 0, SIMULATE: 1, REQUIRE_APPROVAL: 2, AUTONOMOUS: 3 };

export const EXPERIMENT_DECISIONS = ['SCALE', 'ITERATE', 'PAUSE', 'KILL', 'CONTINUE'] as const;
export type ExperimentDecision = (typeof EXPERIMENT_DECISIONS)[number];

export const EXPERIMENT_STATUSES = ['draft', 'pending_approval', 'running', 'paused', 'completed', 'killed', 'cancelled'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'executed', 'failed'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const REVERSIBILITY = ['reversible', 'partially_reversible', 'irreversible'] as const;
export type Reversibility = (typeof REVERSIBILITY)[number];

export const BUSINESS_MODELS = [
  'saas_subscription',
  'b2b_saas',
  'b2c_app',
  'marketplace',
  'api_usage_based',
  'developer_tool',
  'ai_agent_service',
  'vertical_software',
  'data_product',
  'automation_service',
  'digital_product',
  'enterprise_software',
  'licensing',
  'transaction_fee',
] as const;
export type BusinessModel = (typeof BUSINESS_MODELS)[number];

export const LEAD_STATUSES = ['new', 'qualified', 'contacted', 'replied', 'demo', 'customer', 'lost', 'unsubscribed'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Legal basis under which we hold / may contact a lead. `unknown` leads are never contacted. */
export const CONSENT_BASES = ['inbound', 'opt_in', 'existing_customer', 'legitimate_interest', 'unknown'] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export const TRACKING_EVENTS = [
  'page_view',
  'cta_click',
  'signup',
  'activation',
  'demo_requested',
  'checkout_started',
  'payment',
  'referral',
  'unsubscribe',
  'complaint',
  'custom',
] as const;
export type TrackingEventName = (typeof TRACKING_EVENTS)[number];

// ─────────────────────────────── Policy actions ───────────────────────────────

export interface ActionDefinition {
  description: string;
  /** Mode applied when an organisation has not configured a policy. */
  defaultMode: ActionMode;
  /**
   * Hard ceiling: an organisation can never configure a mode less restrictive than this.
   * Financial movements are capped at REQUIRE_APPROVAL; trading is capped at SIMULATE (paper only).
   */
  maxMode: ActionMode;
  category: 'data' | 'ai' | 'build' | 'deploy' | 'financial' | 'communication' | 'legal' | 'security' | 'growth';
  risk: RiskLevel;
}

export const ACTIONS = {
  'research.fetch_public': { description: 'Fetch public data from configured, allow-listed sources', defaultMode: 'AUTONOMOUS', maxMode: 'AUTONOMOUS', category: 'data', risk: 'low' },
  'ai.model_call': { description: 'Call an AI model within budget limits', defaultMode: 'AUTONOMOUS', maxMode: 'AUTONOMOUS', category: 'ai', risk: 'low' },
  'opportunity.write': { description: 'Create or update opportunities, hypotheses and scores', defaultMode: 'AUTONOMOUS', maxMode: 'AUTONOMOUS', category: 'data', risk: 'low' },
  'code.generate': { description: 'Generate MVP source code from vetted templates', defaultMode: 'AUTONOMOUS', maxMode: 'AUTONOMOUS', category: 'build', risk: 'low' },
  'code.execute_sandbox': { description: 'Execute generated code inside the isolated sandbox', defaultMode: 'AUTONOMOUS', maxMode: 'AUTONOMOUS', category: 'build', risk: 'medium' },
  'deploy.local': { description: 'Run a generated MVP locally (preview, localhost only)', defaultMode: 'AUTONOMOUS', maxMode: 'AUTONOMOUS', category: 'deploy', risk: 'low' },
  'deploy.production': { description: 'Deploy a product to a public production environment', defaultMode: 'REQUIRE_APPROVAL', maxMode: 'REQUIRE_APPROVAL', category: 'deploy', risk: 'high' },
  'experiment.start': { description: 'Start an experiment that has no spend attached', defaultMode: 'AUTONOMOUS', maxMode: 'AUTONOMOUS', category: 'growth', risk: 'low' },
  'spend.commit': { description: 'Commit budget (ads, tools, contractors) to an experiment', defaultMode: 'REQUIRE_APPROVAL', maxMode: 'AUTONOMOUS', category: 'financial', risk: 'medium' },
  'financial.payment': { description: 'Initiate a payment or charge', defaultMode: 'REQUIRE_APPROVAL', maxMode: 'REQUIRE_APPROVAL', category: 'financial', risk: 'critical' },
  'financial.transfer': { description: 'Move money between accounts', defaultMode: 'REQUIRE_APPROVAL', maxMode: 'REQUIRE_APPROVAL', category: 'financial', risk: 'critical' },
  'financial.trade': { description: 'Buy/sell securities or crypto (paper trading only)', defaultMode: 'SIMULATE', maxMode: 'SIMULATE', category: 'financial', risk: 'critical' },
  'billing.configure': { description: 'Create products, prices or checkout links in a payment provider', defaultMode: 'REQUIRE_APPROVAL', maxMode: 'REQUIRE_APPROVAL', category: 'financial', risk: 'high' },
  'outreach.send': { description: 'Send outbound messages to leads', defaultMode: 'REQUIRE_APPROVAL', maxMode: 'AUTONOMOUS', category: 'communication', risk: 'high' },
  'communication.mass': { description: 'Mass communication (> 100 recipients or public posts)', defaultMode: 'REQUIRE_APPROVAL', maxMode: 'REQUIRE_APPROVAL', category: 'communication', risk: 'high' },
  'contract.sign': { description: 'Accept terms, sign contracts or enter agreements', defaultMode: 'REQUIRE_APPROVAL', maxMode: 'REQUIRE_APPROVAL', category: 'legal', risk: 'critical' },
  'data.sensitive': { description: 'Export or process sensitive personal data', defaultMode: 'REQUIRE_APPROVAL', maxMode: 'REQUIRE_APPROVAL', category: 'security', risk: 'high' },
  'security.policy_change': { description: 'Relax a security or action policy', defaultMode: 'REQUIRE_APPROVAL', maxMode: 'REQUIRE_APPROVAL', category: 'security', risk: 'high' },
  'external.high_risk': { description: 'Any other high-risk action against an external system', defaultMode: 'REQUIRE_APPROVAL', maxMode: 'REQUIRE_APPROVAL', category: 'security', risk: 'high' },
} as const satisfies Record<string, ActionDefinition>;

export type ActionKey = keyof typeof ACTIONS;

// ─────────────────────────────── Domain entities (API shapes) ───────────────────────────────

export interface Organization {
  id: string;
  name: string;
  slug: string;
  isDemo: boolean;
  settings: OrgSettings;
  createdAt: string;
}

export interface OrgSettings {
  onboarding?: Partial<Record<OnboardingStep, { done: boolean; at?: string }>>;
  constraints?: {
    initialCapitalUsd?: number;
    monthlyBudgetUsd?: number;
    hoursPerWeek?: number;
    riskTolerance?: 'low' | 'medium' | 'high';
  };
  industries?: string[];
  excludedIndustries?: string[];
  aiDailyBudgetUsd?: number;
  roadmapAssumptions?: Record<string, number>;
}

export const ONBOARDING_STEPS = [
  'system_status',
  'connect_ai',
  'configure_sources',
  'constraints',
  'industries',
  'first_scan',
  'hypotheses',
  'select_opportunity',
  'generate_mvp',
  'launch_experiment',
  'track_results',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface CompetitionAssessment {
  level: 'none_found' | 'low' | 'medium' | 'high' | 'unknown';
  competitors: { name: string; url?: string; note?: string }[];
  kind: DataKind;
  rationale: string;
}

export interface ScoreCriterion {
  key: string;
  label: string;
  /** Normalised 0..1, higher is better for the business (risk criteria already inverted). */
  value: number;
  low: number;
  high: number;
  weight: number;
  kind: DataKind;
  rationale: string;
}

export interface ScoreBreakdown {
  score: number;
  low: number;
  high: number;
  criteria: ScoreCriterion[];
  confidence: number;
  weightsVersion: string;
  computedAt: string;
}

export interface Opportunity {
  id: string;
  orgId: string;
  title: string;
  problem: string;
  customer: string;
  market: string;
  marketId?: string | null;
  sourceUrls: string[];
  estimatedMarketSize: EstimatedValue | null;
  estimatedPrice: EstimatedValue | null;
  acquisitionCostEstimate: EstimatedValue | null;
  grossMarginEstimate: EstimatedValue | null;
  competition: CompetitionAssessment | null;
  technicalComplexity: EstimatedValue | null;
  regulatoryRisk: EstimatedValue | null;
  timeToMvp: EstimatedValue | null;
  confidence: number;
  score: number | null;
  scoreBreakdown: ScoreBreakdown | null;
  status: OpportunityStatus;
  tags: string[];
  industries: string[];
  signals: OpportunitySignals;
  selectedHypothesisId?: string | null;
  fingerprint?: string | null;
  isDemo: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  evidence?: Evidence[];
}

/** Aggregate observed signals backing an opportunity (all OBSERVED, from evidence). */
export interface OpportunitySignals {
  documentCount: number;
  distinctSources: number;
  totalEngagement: number;
  painScore: number;
  willingnessToPayMentions: number;
  competitorMentions: number;
  newestEvidenceAt?: string;
  oldestEvidenceAt?: string;
  keywords: string[];
}

export interface Evidence {
  id: string;
  opportunityId: string;
  documentId?: string | null;
  claim: string;
  quote?: string | null;
  kind: DataKind;
  sourceName: string;
  sourceUrl?: string | null;
  observedAt: string;
  confidence: number;
  provenance: Record<string, unknown>;
}

export interface UnitEconomics {
  price: EstimatedValue;
  cac: EstimatedValue;
  grossMargin: EstimatedValue;
  monthlyChurn: EstimatedValue;
  ltv: EstimatedValue;
  ltvToCac: EstimatedValue;
  paybackMonths: EstimatedValue;
}

export interface BusinessHypothesis {
  id: string;
  opportunityId: string;
  model: BusinessModel;
  title: string;
  targetCustomer: string;
  valueProposition: string;
  mvpSpec: MvpSpecSummary;
  pricing: { tiers: { name: string; priceUsdMonthly: number; features: string[] }[]; metric: string; kind: DataKind };
  distribution: string[];
  acquisitionExperiments: { name: string; channel: string; hypothesis: string; costUsd: number }[];
  retentionStrategy: string[];
  unitEconomics: UnitEconomics;
  expectedCosts: { item: string; monthlyUsd: number; kind: DataKind }[];
  experimentPlan: { step: string; metric: string; threshold: string }[];
  technicalArchitecture: string[];
  score: number;
  status: 'proposed' | 'selected' | 'rejected' | 'testing' | 'validated' | 'invalidated';
  generatedBy: string;
  createdAt: string;
}

export interface MvpSpecSummary {
  name: string;
  tagline: string;
  coreFeatures: string[];
  entities: MvpEntity[];
}

export interface MvpEntity {
  name: string;
  fields: { name: string; type: 'string' | 'text' | 'number' | 'boolean' | 'date' | 'email' | 'url'; required?: boolean }[];
}

export interface ExperimentThresholds {
  /** Primary conversion target (e.g. 0.05 = 5% visitor→signup) */
  targetRate: number;
  /** Minimum observations of the denominator stage before any decision */
  minSample: number;
  /** Posterior probability required to SCALE */
  scaleProbability: number;
  /** Probability that rate exceeds killFraction*target below which we KILL */
  killProbability: number;
  killFraction: number;
  maxDays: number;
  maxBudgetUsd: number;
  /** Optional economics guardrails */
  maxCacUsd?: number;
  minLtvToCac?: number;
  maxComplaintRate?: number;
}

export interface FunnelStage {
  key: string;
  event: TrackingEventName;
  label: string;
}

export interface Experiment {
  id: string;
  orgId: string;
  opportunityId: string | null;
  productId: string | null;
  name: string;
  hypothesis: string;
  funnel: FunnelStage[];
  primaryNumerator: string;
  primaryDenominator: string;
  variants: string[];
  thresholds: ExperimentThresholds;
  budgetUsd: number;
  spentUsd: number;
  status: ExperimentStatus;
  decision: ExperimentDecision | null;
  decisionRationale: DecisionResult | null;
  startedAt: string | null;
  endedAt: string | null;
  isDemo: boolean;
  createdAt: string;
}

export interface DecisionResult {
  decision: ExperimentDecision;
  reasons: string[];
  stats: {
    numerator: number;
    denominator: number;
    rate: number;
    rateLow: number;
    rateHigh: number;
    probAboveTarget: number;
    probAboveKillLine: number;
    daysRunning: number;
    spentUsd: number;
    cacUsd?: number | null;
    ltvToCac?: number | null;
    complaintRate?: number;
    variants?: { variant: string; numerator: number; denominator: number; rate: number; probBest: number }[];
  };
  evaluatedAt: string;
}

export interface ApprovalRequest {
  id: string;
  orgId: string;
  actionType: ActionKey;
  title: string;
  what: string;
  why: string;
  expectedBenefit: string;
  expectedCostUsd: number;
  risk: { level: RiskLevel; description: string };
  dataSources: SourceRef[];
  reversibility: Reversibility;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string | null;
  result: Record<string, unknown> | null;
  taskId: string | null;
  createdAt: string;
}

export interface AgentTask {
  id: string;
  orgId: string;
  agent: AgentName;
  kind: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: TaskStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  timeoutMs: number;
  parentId: string | null;
  workflowId: string | null;
  error: string | null;
  costUsd: number;
  tokens: number;
  createdBy: string;
  approvalId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface SystemEvent {
  id: number;
  orgId: string | null;
  type: string;
  entityType?: string | null;
  entityId?: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type { DataKind, EstimatedValue, SourceRef };
