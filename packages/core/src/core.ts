import { StripeClient } from '@roos/billing';
import type { ConnectorContext } from '@roos/connectors';
import { migrate, type Db } from '@roos/database';
import { ACTION_MODE_RANK, ACTIONS, ValidationError, type ActionKey, type ActionMode, type AppConfig, type Logger } from '@roos/shared';
import { AiService } from './ai';
import { AlertService } from './alerts';
import { AnalysisService } from './analysis';
import { ApprovalService } from './approvals';
import { AuditService, type Actor } from './audit';
import { AuthService } from './auth';
import { CampaignService, OutboxSender, ResendSender, type EmailSender } from './campaigns';
import { DiscoveryService } from './discovery';
import { EventBus, type PublishLike } from './events';
import { ExperimentService } from './experiments';
import { PostgresGraphStore } from './graph';
import { LeadService } from './leads';
import { PaperLedger } from './ledger';
import { OpportunityService } from './opportunities';
import { OrgService } from './orgs';
import { PolicyEngine, type PolicyLimits } from './policy';
import { PortfolioService } from './portfolio';
import { ProductService } from './products';
import { ReportService } from './reports';
import { RevenueService } from './revenue';
import { SecretsService } from './secrets';
import { StrategyService } from './strategy';
import { SystemService } from './system';
import { TrackingService } from './tracking';

export interface CoreOptions {
  db: Db;
  cfg: AppConfig;
  logger: Logger;
  redis?: PublishLike & { ping(): Promise<string> };
  /** Override the HTTP fetcher used by connectors (tests use recorded fixtures). */
  connectorFetch?: ConnectorContext['fetch'];
  emailSender?: EmailSender;
}

/** Service container shared by the API, the worker and the CLI. */
export class Core {
  readonly db: Db;
  readonly cfg: AppConfig;
  readonly logger: Logger;
  readonly events: EventBus;
  readonly audit: AuditService;
  readonly orgs: OrgService;
  readonly auth: AuthService;
  readonly secrets: SecretsService;
  readonly policy: PolicyEngine;
  readonly approvals: ApprovalService;
  readonly ledger: PaperLedger;
  readonly alerts: AlertService;
  readonly graph: PostgresGraphStore;
  readonly ai: AiService;
  readonly strategy: StrategyService;
  readonly opportunities: OpportunityService;
  readonly discovery: DiscoveryService;
  readonly analysis: AnalysisService;
  readonly products: ProductService;
  readonly leads: LeadService;
  readonly tracking: TrackingService;
  readonly campaigns: CampaignService;
  readonly experiments: ExperimentService;
  readonly revenue: RevenueService;
  readonly portfolio: PortfolioService;
  readonly reports: ReportService;
  readonly system: SystemService;

  constructor(o: CoreOptions) {
    this.db = o.db;
    this.cfg = o.cfg;
    this.logger = o.logger;
    this.events = new EventBus(o.db, o.logger, o.redis);
    this.audit = new AuditService(o.db);
    this.orgs = new OrgService(o.db);
    this.auth = new AuthService(o.db, o.cfg, this.orgs, this.audit);
    this.secrets = new SecretsService(o.db, o.cfg, this.audit);
    this.policy = new PolicyEngine(o.db, this.audit);
    this.approvals = new ApprovalService(o.db, this.audit, this.events, o.logger);
    this.ledger = new PaperLedger(o.db);
    this.alerts = new AlertService(o.db, this.events);
    this.graph = new PostgresGraphStore(o.db);
    this.ai = new AiService(o.db, o.cfg, this.secrets, this.orgs, o.logger);
    this.strategy = new StrategyService(o.db, this.audit);
    this.opportunities = new OpportunityService(o.db, this.audit, this.events, this.strategy);
    this.discovery = new DiscoveryService(o.db, o.cfg, o.logger, this.events, this.orgs, this.secrets, this.opportunities, o.connectorFetch);
    this.analysis = new AnalysisService(o.db, o.logger, this.events, this.opportunities, this.discovery);
    this.products = new ProductService(o.db, o.cfg, o.logger, this.audit, this.events, this.policy, this.opportunities);
    this.leads = new LeadService(o.db, this.audit, this.events);
    this.tracking = new TrackingService(o.db, o.cfg, this.events, this.leads);
    // Delivery only when EMAIL_DRIVER=resend; the workspace's stored key wins over RESEND_API_KEY.
    const senderFor = async (orgId: string): Promise<EmailSender> => {
      if (o.emailSender) return o.emailSender;
      if (o.cfg.email.driver !== 'resend') return new OutboxSender();
      const key = (await this.secrets.get(orgId, 'email.resend.api_key')) ?? o.cfg.email.resendKey;
      return key ? new ResendSender(key) : new OutboxSender();
    };
    this.campaigns = new CampaignService(o.db, o.cfg, o.logger, this.audit, this.events, this.policy, this.approvals, this.leads, senderFor);
    this.experiments = new ExperimentService(o.db, this.audit, this.events, this.policy, this.approvals, this.ledger, this.alerts, this.opportunities, this.products, this.strategy);
    this.revenue = new RevenueService(o.db, o.cfg, o.logger, this.audit, this.events, this.orgs, this.secrets);
    this.portfolio = new PortfolioService(o.db, this.orgs, this.revenue, this.leads);
    this.reports = new ReportService(o.db, this.orgs, this.revenue, this.events);
    this.system = new SystemService(o.db, o.cfg, o.redis);
    this.registerExecutors();
  }

  /** Apply migrations and seed reference data. Safe to call from every process. */
  async init() {
    await migrate(this.db, { logger: this.logger, strict: this.cfg.isProd });
    await this.ai.seedPricing();
  }

  /**
   * Policy change entry point. Tightening applies immediately; relaxing a policy is itself the
   * approval-gated `security.policy_change` action.
   */
  async requestPolicyChange(orgId: string, action: ActionKey, mode: ActionMode, limits: PolicyLimits, actor: Actor) {
    if (!ACTIONS[action]) throw new ValidationError(`Unknown action ${action}`);
    if (ACTION_MODE_RANK[mode] > ACTION_MODE_RANK[ACTIONS[action].maxMode]) throw new ValidationError(`${action} cannot exceed ${ACTIONS[action].maxMode}`);
    if (!(await this.policy.isRelaxation(orgId, action, mode, limits))) {
      await this.policy.apply(orgId, action, mode, limits, actor);
      return { applied: true as const };
    }
    const current = await this.policy.get(orgId, action);
    const approval = await this.approvals.request(orgId, {
      actionType: 'security.policy_change',
      title: `Relax policy: ${action} → ${mode}`,
      what: `Change "${action}" from ${current.mode} to ${mode}${Object.keys(limits).length ? ` with limits ${JSON.stringify(limits)}` : ''}.`,
      why: 'Requested by an operator to allow more automation.',
      expectedBenefit: 'Less manual approval work for this action type.',
      expectedCostUsd: 0,
      risk: { level: ACTIONS[action].risk, description: `Agents will be able to perform "${ACTIONS[action].description}" with less human oversight.` },
      dataSources: [],
      reversibility: 'reversible',
      payload: { action, mode, limits },
      requestedBy: actor.id,
    });
    return { applied: false as const, approvalId: approval.id };
  }

  private registerExecutors() {
    const paperOnly = (label: string) => async (a: { orgId: string; id: string; expectedCostUsd: number; title: string }) => {
      await this.ledger.record(a.orgId, { account: label, entryType: 'approved_intent', amountUsd: -a.expectedCostUsd, memo: a.title, approvalId: a.id });
      return {
        executed: false,
        recordedIn: 'paper_ledger',
        note: 'ROOS never moves money, trades or signs on your behalf. The approval is recorded; perform the real action yourself in the provider’s own interface.',
      };
    };

    this.approvals.registerExecutor('spend.commit', async (a, actor) => {
      const experimentId = String(a.payload.experimentId);
      await this.ledger.record(a.orgId, { account: 'authorized_budgets', entryType: 'budget_authorized', amountUsd: -a.expectedCostUsd, memo: a.title, approvalId: a.id, experimentId });
      const r = await this.experiments.markRunning(a.orgId, experimentId, actor);
      return { experimentId, status: r.status, note: 'Budget authorised. Record actual spend as expenses against the experiment.' };
    });
    this.approvals.registerExecutor('outreach.send', async (a, actor) => ({ ...(await this.campaigns.send(a.orgId, String(a.payload.campaignId), actor)) }));
    this.approvals.registerExecutor('communication.mass', async (a, actor) => ({ ...(await this.campaigns.send(a.orgId, String(a.payload.campaignId), actor)) }));
    this.approvals.registerExecutor('deploy.production', async (a, actor) => this.products.prepareProductionDeployment(a.orgId, String(a.payload.projectId), a.id, actor));
    this.approvals.registerExecutor('security.policy_change', async (a, actor) => {
      await this.policy.apply(a.orgId, a.payload.action as ActionKey, a.payload.mode as ActionMode, (a.payload.limits ?? {}) as PolicyLimits, actor, a.id);
      return { applied: true, action: a.payload.action, mode: a.payload.mode };
    });
    this.approvals.registerExecutor('billing.configure', async (a) => {
      const key = (await this.secrets.get(a.orgId, 'billing.stripe.secret_key')) ?? this.cfg.billing.stripeSecretKey;
      if (!key) throw new ValidationError('Stripe is not configured for this workspace (billing.stripe.secret_key).');
      const productId = String(a.payload.productId);
      const link = await new StripeClient(key).createPaymentLink({ productName: String(a.payload.productName), unitAmountUsd: Number(a.payload.priceUsd), interval: (a.payload.interval as 'month' | 'year') ?? 'month', roosProductId: productId });
      await this.db.query(`UPDATE products SET pricing = pricing || $3::jsonb, updated_at = now() WHERE id = $1 AND org_id = $2`, [productId, a.orgId, JSON.stringify({ paymentLinkUrl: link.url, stripePriceId: link.priceId })]);
      return { ...link, note: 'Set PAYMENT_LINK_URL on the deployed product to enable checkout.' };
    });
    this.approvals.registerExecutor('financial.payment', paperOnly('payments'));
    this.approvals.registerExecutor('financial.transfer', paperOnly('transfers'));
    this.approvals.registerExecutor('financial.trade', paperOnly('paper_trading'));
    this.approvals.registerExecutor('contract.sign', paperOnly('contracts'));
    this.approvals.registerExecutor('external.high_risk', paperOnly('external_actions'));
    this.approvals.registerExecutor('data.sensitive', async (a) => ({ authorized: true, scope: a.payload.scope ?? 'lead_export', validForMinutes: 60 }));
  }
}
