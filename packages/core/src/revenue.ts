import { computeRevenueMetrics, projectCashFlow, type RevenueMetrics } from '@roos/analytics';
import { normalizeStripeEvent, StripeClient, verifyStripeSignature, type NormalizedBillingEvent, type StripeEvent } from '@roos/billing';
import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { camelize, ForbiddenError, newId, NotFoundError, round, sha256Hex, ValidationError, type AppConfig, type Logger } from '@roos/shared';
import type { Actor, AuditService } from './audit';
import type { EventBus } from './events';
import type { OrgService } from './orgs';
import type { SecretsService } from './secrets';

/**
 * Revenue engine. Only payment-provider data (signature-verified Stripe webhooks or read-only API
 * sync) is VERIFIED revenue. Manual entries are USER_INPUT; demo data is DEMO. The database itself
 * rejects `verified = true` for anything that is not provider data (see migration 004).
 */
export class RevenueService {
  constructor(
    private db: Db,
    private cfg: AppConfig,
    private logger: Logger,
    private audit: AuditService,
    private events: EventBus,
    private orgs: OrgService,
    private secrets: SecretsService,
  ) {}

  async recordManual(
    orgId: string,
    input: { type: 'charge' | 'refund' | 'subscription_started' | 'subscription_canceled' | 'subscription_changed'; amountUsd: number; mrrUsd?: number; occurredAt?: string; productId?: string; customerId?: string; customerEmail?: string; note?: string },
    actor: Actor,
  ) {
    let customerId = input.customerId ?? null;
    if (!customerId && input.customerEmail) {
      const hash = sha256Hex(input.customerEmail.toLowerCase());
      customerId =
        (await this.db.value<string>(`SELECT id FROM customers WHERE org_id = $1 AND source = 'manual' AND external_id = $2`, [orgId, hash])) ??
        (await this.upsertCustomer(orgId, 'manual', hash, { emailHash: hash, productId: input.productId ?? null }));
    }
    let mrrDelta = 0;
    if (input.type === 'subscription_started') mrrDelta = input.mrrUsd ?? input.amountUsd;
    if (input.type === 'subscription_canceled') mrrDelta = -(input.mrrUsd ?? (customerId ? await this.customerMrr(orgId, customerId) : input.amountUsd));
    if (input.type === 'subscription_changed') {
      if (input.mrrUsd === undefined || !customerId) throw new ValidationError('subscription_changed requires mrrUsd and a customer');
      mrrDelta = input.mrrUsd - (await this.customerMrr(orgId, customerId));
    }
    const id = newId('revenue');
    await this.db.query(
      `INSERT INTO revenue_events (id, org_id, product_id, customer_id, type, amount_usd, mrr_delta_usd, occurred_at, source, verified, verification, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',false,$9,$10)`,
      [id, orgId, input.productId ?? null, customerId, input.type, ['charge', 'refund'].includes(input.type) ? input.amountUsd : 0, mrrDelta, input.occurredAt ?? new Date().toISOString(), json({ kind: 'USER_INPUT', enteredBy: actor.id }), input.note ?? null],
    );
    if (customerId) await this.refreshCustomer(orgId, customerId);
    await this.audit.record({ orgId, actor, action: 'revenue.manual', targetType: 'revenue_event', targetId: id, details: { type: input.type, amountUsd: input.amountUsd, mrrDelta } });
    await this.events.publish(orgId, 'revenue.recorded', { entityType: 'revenue_event', entityId: id, payload: { type: input.type, verified: false } });
    return { id, verified: false, dataKind: 'USER_INPUT' };
  }

  async recordExpense(orgId: string, input: { category: string; amountUsd: number; occurredAt?: string; productId?: string; experimentId?: string; description?: string }, actor: Actor) {
    const id = newId('expense');
    await this.db.query(`INSERT INTO expenses (id, org_id, product_id, experiment_id, category, amount_usd, occurred_at, description, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual')`, [
      id,
      orgId,
      input.productId ?? null,
      input.experimentId ?? null,
      input.category,
      input.amountUsd,
      input.occurredAt ?? new Date().toISOString(),
      input.description ?? null,
    ]);
    await this.audit.record({ orgId, actor, action: 'expense.record', targetType: 'expense', targetId: id, details: { category: input.category, amountUsd: input.amountUsd } });
    await this.events.publish(orgId, 'expense.recorded', { entityType: 'expense', entityId: id, payload: { amountUsd: input.amountUsd } });
    return { id };
  }

  private async customerMrr(orgId: string, customerId: string) {
    return Number((await this.db.value('SELECT COALESCE(SUM(mrr_delta_usd), 0) FROM revenue_events WHERE org_id = $1 AND customer_id = $2', [orgId, customerId])) ?? 0);
  }

  private async upsertCustomer(orgId: string, source: 'stripe' | 'manual', externalId: string, extra: { emailHash?: string | null; productId?: string | null }) {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO customers (id, org_id, product_id, external_id, email_hash, source, status) VALUES ($1,$2,$3,$4,$5,$6,'active')
       ON CONFLICT (org_id, source, external_id) DO UPDATE SET email_hash = COALESCE(customers.email_hash, EXCLUDED.email_hash), updated_at = now()
       RETURNING id`,
      [newId('customer'), orgId, extra.productId ?? null, externalId, extra.emailHash ?? null, source],
    );
    return row!.id;
  }

  private async refreshCustomer(orgId: string, customerId: string) {
    const mrr = await this.customerMrr(orgId, customerId);
    await this.db.query(
      `UPDATE customers SET mrr_usd = $3::float8, status = CASE WHEN $3::float8 > 0 THEN 'active' WHEN EXISTS (SELECT 1 FROM revenue_events r WHERE r.customer_id = customers.id AND r.type = 'subscription_canceled') THEN 'churned' ELSE status END,
         churned_at = CASE WHEN $3::float8 <= 0 AND EXISTS (SELECT 1 FROM revenue_events r WHERE r.customer_id = customers.id AND r.type = 'subscription_canceled') THEN COALESCE(churned_at, now()) ELSE NULL END, updated_at = now()
       WHERE id = $1 AND org_id = $2`,
      [customerId, orgId, round(mrr, 2)],
    );
  }

  private async resolveProduct(orgId: string, ref?: string) {
    if (!ref) return null;
    return this.db.value<string>('SELECT id FROM products WHERE id = $1 AND org_id = $2', [ref, orgId]);
  }

  /** Apply a provider-verified billing event (idempotent on external ids). */
  async applyVerified(orgId: string, n: NormalizedBillingEvent, verification: Record<string, unknown>): Promise<{ applied: boolean; reason?: string }> {
    if (n.currency.toLowerCase() !== 'usd') return { applied: false, reason: `Currency ${n.currency} not supported yet (USD only)` };
    const productId = await this.resolveProduct(orgId, n.productRef);
    const customerId = n.customerExternalId ? await this.upsertCustomer(orgId, 'stripe', n.customerExternalId, { emailHash: 'customerEmail' in n && n.customerEmail ? sha256Hex(n.customerEmail.toLowerCase()) : null, productId }) : null;
    const insert = async (type: string, amount: number, mrrDelta: number, externalId: string, extra: Record<string, unknown> = {}) => {
      const r = await this.db.query(
        `INSERT INTO revenue_events (id, org_id, product_id, customer_id, type, amount_usd, mrr_delta_usd, currency, occurred_at, source, external_id, verified, verification)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'stripe',$10,true,$11) ON CONFLICT (org_id, source, external_id) DO NOTHING`,
        [newId('revenue'), orgId, productId, customerId, type, amount, mrrDelta, n.currency.toLowerCase(), n.occurredAt, externalId, json({ ...verification, ...extra, livemode: n.livemode })],
      );
      return r.rowCount > 0;
    };

    let applied = false;
    if (n.kind === 'charge') applied = await insert('charge', n.amountUsd, 0, n.externalId, { subscriptionId: n.subscriptionId });
    else if (n.kind === 'refund') applied = await insert('refund', n.amountUsd, 0, n.externalId);
    else {
      const current = Number(
        (await this.db.value(`SELECT COALESCE(SUM(mrr_delta_usd), 0) FROM revenue_events WHERE org_id = $1 AND source = 'stripe' AND verification->>'subscriptionId' = $2`, [orgId, n.subscriptionId])) ?? 0,
      );
      const target = n.kind === 'subscription_canceled' ? 0 : n.mrrUsd;
      const delta = round(target - current, 2);
      if (delta !== 0) {
        const type = n.kind === 'subscription_canceled' || target === 0 ? 'subscription_canceled' : current === 0 ? 'subscription_started' : 'subscription_changed';
        applied = await insert(type, 0, delta, n.externalId, { subscriptionId: n.subscriptionId, status: 'status' in n ? n.status : 'canceled' });
      }
    }
    if (customerId) await this.refreshCustomer(orgId, customerId);
    if (applied) await this.events.publish(orgId, 'revenue.recorded', { payload: { kind: n.kind, verified: true, amountUsd: 'amountUsd' in n ? n.amountUsd : undefined } });
    return { applied, reason: applied ? undefined : 'Duplicate or no MRR change' };
  }

  async webhookSecret(orgId: string) {
    return (await this.secrets.get(orgId, 'billing.stripe.webhook_secret')) ?? this.cfg.billing.stripeWebhookSecret ?? null;
  }

  /** Stripe webhook entry point: POST /api/webhooks/stripe/:orgSlug */
  async handleStripeWebhook(orgSlug: string, rawBody: string, signature: string | undefined) {
    const org = await this.orgs.getBySlug(orgSlug);
    if (!org) throw new NotFoundError('Organization');
    if (org.isDemo) throw new ForbiddenError('Demo workspaces cannot receive real payment data');
    const secret = await this.webhookSecret(org.id);
    if (!secret) throw new ForbiddenError('Stripe webhook secret not configured for this workspace');
    const check = verifyStripeSignature(rawBody, signature, secret);
    if (!check.valid) {
      await this.audit.record({ orgId: org.id, actor: { type: 'webhook', id: 'stripe' }, action: 'webhook.stripe', outcome: 'denied', details: { reason: check.reason } });
      throw new ForbiddenError(`Invalid Stripe signature: ${check.reason}`);
    }
    const evt = JSON.parse(rawBody) as StripeEvent;
    const n = normalizeStripeEvent(evt);
    const result = n ? await this.applyVerified(org.id, n, { method: 'webhook_signature', eventId: evt.id, signatureTimestamp: check.timestamp }) : { applied: false, reason: `Ignored event type ${evt.type}` };
    await this.audit.record({ orgId: org.id, actor: { type: 'webhook', id: 'stripe' }, action: 'webhook.stripe', details: { eventId: evt.id, type: evt.type, ...result } });
    return { received: true, ...result };
  }

  /** Read-only backfill from the Stripe API (use a restricted, read-only key). */
  async syncStripe(orgId: string, actor: Actor, fetcher?: ConstructorParameters<typeof StripeClient>[1]) {
    const org = await this.orgs.get(orgId);
    if (org.isDemo) throw new ForbiddenError('Demo workspaces cannot sync real payment data');
    const key = (await this.secrets.get(orgId, 'billing.stripe.secret_key')) ?? this.cfg.billing.stripeSecretKey;
    if (!key) throw new ValidationError('Stripe key not configured (Settings → Secrets → billing.stripe.secret_key)');
    const client = new StripeClient(key, fetcher);
    const since = Math.floor(Date.now() / 1000) - 90 * 86400;
    const invoices = await client.listPaidInvoices(since);
    let applied = 0;
    for (const inv of invoices.data) {
      const n = normalizeStripeEvent({ id: `sync_${inv.id}`, type: 'invoice.paid', created: inv.created, livemode: inv.livemode, data: { object: inv } });
      if (n && (await this.applyVerified(orgId, n, { method: 'api_sync' })).applied) applied++;
    }
    const subs = await client.listSubscriptions('active');
    for (const s of subs.data) {
      const n = normalizeStripeEvent({ id: `sync_sub_${s.id}_${Date.now()}`, type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000), livemode: s.livemode, data: { object: s } });
      if (n && (await this.applyVerified(orgId, n, { method: 'api_sync' })).applied) applied++;
    }
    await this.audit.record({ orgId, actor, action: 'revenue.stripe_sync', details: { invoices: invoices.data.length, subscriptions: subs.data.length, applied } });
    return { invoices: invoices.data.length, subscriptions: subs.data.length, applied };
  }

  private async loadLedger(orgId: string) {
    const [events, expenses, customers] = await Promise.all([
      this.db.many<Record<string, any>>(`SELECT type, amount_usd, mrr_delta_usd, occurred_at, customer_id, verified FROM revenue_events WHERE org_id = $1 AND currency = 'usd' ORDER BY occurred_at`, [orgId]),
      this.db.many<Record<string, any>>('SELECT category, amount_usd, occurred_at FROM expenses WHERE org_id = $1', [orgId]),
      this.db.many<Record<string, any>>('SELECT id, status, started_at, churned_at, mrr_usd FROM customers WHERE org_id = $1', [orgId]),
    ]);
    return {
      events: events.map((e) => ({ type: e.type, amountUsd: e.amount_usd, mrrDeltaUsd: e.mrr_delta_usd, occurredAt: e.occurred_at, customerId: e.customer_id, verified: e.verified })),
      expenses: expenses.map((e) => ({ category: e.category, amountUsd: e.amount_usd, occurredAt: e.occurred_at })),
      customers: customers.map((c) => ({ id: c.id, status: c.status, startedAt: c.started_at, churnedAt: c.churned_at, mrrUsd: c.mrr_usd })),
    };
  }

  async metrics(orgId: string, verifiedOnly: boolean, now?: Date): Promise<RevenueMetrics> {
    const l = await this.loadLedger(orgId);
    return computeRevenueMetrics({ ...l, verifiedOnly, now });
  }

  async summary(orgId: string) {
    const org = await this.orgs.get(orgId);
    const [verified, reported, counts] = await Promise.all([
      this.metrics(orgId, true),
      this.metrics(orgId, false),
      this.db.one<{ verified: number; manual: number; demo: number; simulation: number }>(
        `SELECT COUNT(*) FILTER (WHERE verified)::int AS verified, COUNT(*) FILTER (WHERE source = 'manual')::int AS manual,
                COUNT(*) FILTER (WHERE source = 'demo')::int AS demo, COUNT(*) FILTER (WHERE source = 'simulation')::int AS simulation
         FROM revenue_events WHERE org_id = $1`,
        [orgId],
      ),
    ]);
    const stripeConfigured = !!((await this.secrets.get(orgId, 'billing.stripe.secret_key')) ?? this.cfg.billing.stripeSecretKey) || !!(await this.webhookSecret(orgId));
    return {
      isDemo: org.isDemo,
      dataKind: org.isDemo ? 'DEMO' : 'OBSERVED',
      verified,
      reported,
      eventCounts: counts,
      stripeConfigured,
      notes: [
        org.isDemo ? 'DEMO DATA — synthetic figures for demonstration only. Not real revenue.' : 'Verified = Stripe signature-checked webhooks or API sync. Reported = verified + manual (USER_INPUT) entries.',
        ...(!stripeConfigured && !org.isDemo ? ['No payment provider connected — verified revenue will stay at $0 until Stripe is configured.'] : []),
      ],
    };
  }

  async listEvents(orgId: string, limit = 200) {
    return (await this.db.many('SELECT * FROM revenue_events WHERE org_id = $1 ORDER BY occurred_at DESC LIMIT $2', [orgId, limit])).map((r) => camelize(r));
  }

  async listExpenses(orgId: string, limit = 200) {
    return (await this.db.many('SELECT * FROM expenses WHERE org_id = $1 ORDER BY occurred_at DESC LIMIT $2', [orgId, limit])).map((r) => camelize(r));
  }

  async cashflow(orgId: string, opts: { cashOnHandUsd?: number; months?: number } = {}) {
    const org = await this.orgs.get(orgId);
    // Projections use all reported revenue (verified + USER_INPUT); the inputs block says which were observed.
    const m = await this.metrics(orgId, false);
    const g = m.momGrowth;
    const churn = m.customerChurnRate;
    const gm = m.grossMargin;
    const growth = g !== null ? { low: Math.min(g * 0.3, g), mode: g, high: Math.max(g * 1.5, g) } : { low: 0, mode: 0.05, high: 0.15 };
    const churnR = churn !== null ? { low: churn * 0.6, mode: churn, high: Math.min(0.5, churn * 1.6) } : { low: 0.02, mode: 0.04, high: 0.08 };
    const gmR = gm !== null ? { low: Math.max(0, gm - 0.1), mode: gm, high: Math.min(1, gm + 0.05) } : { low: 0.65, mode: 0.8, high: 0.9 };
    const fixed = m.expensesLast30;
    const result = projectCashFlow({
      currentMrrUsd: m.mrr,
      monthlyGrowth: growth,
      monthlyChurn: churnR,
      grossMargin: gmR,
      monthlyFixedExpensesUsd: fixed,
      monthlyAcquisitionSpendUsd: 0,
      cashOnHandUsd: opts.cashOnHandUsd ?? org.settings.constraints?.initialCapitalUsd ?? 0,
      months: opts.months ?? 12,
      seed: orgId,
    });
    return {
      ...result,
      inputs: {
        growthSource: g !== null ? 'OBSERVED (MoM MRR growth)' : 'MODEL_ASSUMPTION (no MRR history)',
        churnSource: churn !== null ? 'OBSERVED' : 'MODEL_ASSUMPTION',
        marginSource: gm !== null ? 'OBSERVED' : 'MODEL_ASSUMPTION',
        expensesSource: 'OBSERVED (last 30 days of recorded expenses)',
        isDemo: org.isDemo,
      },
    };
  }
}
