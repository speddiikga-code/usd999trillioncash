import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { hmacSign, safeEqual, safeFetch } from '@roos/security';
import { camelize, ConflictError, errorMessage, newId, NotFoundError, PolicyDeniedError, sha256Hex, type AppConfig, type CampaignCreateInput, type Logger } from '@roos/shared';
import type { ApprovalService } from './approvals';
import type { Actor, AuditService } from './audit';
import type { EventBus } from './events';
import type { LeadService } from './leads';
import type { PolicyEngine } from './policy';

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  unsubscribeUrl: string;
}

export interface EmailSender {
  readonly name: 'outbox' | 'resend';
  send(m: EmailMessage): Promise<{ accepted: boolean; providerMessageId?: string; note?: string }>;
}

/** Default: nothing leaves the system. Messages stay in the outbox, clearly marked as not delivered. */
export class OutboxSender implements EmailSender {
  readonly name = 'outbox' as const;
  async send() {
    return { accepted: false, note: 'EMAIL_DRIVER=outbox — stored in the outbox, NOT delivered. Configure an email provider to send.' };
  }
}

export class ResendSender implements EmailSender {
  readonly name = 'resend' as const;
  constructor(private apiKey: string) {}
  async send(m: EmailMessage) {
    const res = await safeFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text, headers: { 'List-Unsubscribe': `<${m.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }),
      timeoutMs: 15_000,
    });
    if (!res.ok) throw new Error(`Resend API ${res.status}: ${res.text().slice(0, 200)}`);
    return { accepted: true, providerMessageId: res.json<{ id: string }>().id };
  }
}

const MERGE = /\{\{\s*(name|first_name|company|title|product|sender)\s*\}\}/g;

/**
 * Outbound campaigns. Drafting is autonomous; SENDING is the `outreach.send` action
 * (REQUIRE_APPROVAL by default; > 100 recipients also needs `communication.mass`).
 * Every message carries an unsubscribe link and the sender's postal address; suppressed,
 * unsubscribed and unknown-consent leads are never contacted; a daily cap applies.
 */
export class CampaignService {
  constructor(
    private db: Db,
    private cfg: AppConfig,
    private logger: Logger,
    private audit: AuditService,
    private events: EventBus,
    private policy: PolicyEngine,
    private approvals: ApprovalService,
    private leads: LeadService,
    /** Resolved per organisation, so a workspace's stored provider key applies to its sends. */
    private senderFor: (orgId: string) => Promise<EmailSender>,
  ) {}

  unsubscribeToken(orgId: string, email: string) {
    return hmacSign(`${orgId}:${email.toLowerCase()}`, this.cfg.secrets.appSecret).slice(0, 32);
  }

  unsubscribeUrl(orgId: string, email: string) {
    return `${this.cfg.api.publicUrl}/api/public/unsubscribe?o=${encodeURIComponent(orgId)}&e=${encodeURIComponent(email)}&t=${this.unsubscribeToken(orgId, email)}`;
  }

  async unsubscribe(orgId: string, email: string, token: string) {
    if (!safeEqual(token, this.unsubscribeToken(orgId, email))) return false;
    await this.leads.suppress(orgId, email, 'unsubscribe_link');
    await this.audit.record({ orgId, actor: { type: 'webhook', id: 'unsubscribe-link' }, action: 'lead.unsubscribe', details: { emailHash: sha256Hex(email.toLowerCase()) } });
    return true;
  }

  private render(template: string, lead: Record<string, any>, product: string) {
    const first = String(lead.name ?? '').split(' ')[0] ?? '';
    const vars: Record<string, string> = { name: lead.name ?? '', first_name: first, company: lead.company ?? 'your team', title: lead.title ?? '', product, sender: this.cfg.email.from ?? 'The team' };
    return template.replace(MERGE, (_, k: string) => vars[k] ?? '');
  }

  private footer(orgId: string, lead: Record<string, any>) {
    const why: Record<string, string> = {
      inbound: 'you signed up for early access',
      opt_in: 'you opted in to hear from us',
      existing_customer: 'you are a customer',
      legitimate_interest: 'we believe this is relevant to your role',
    };
    return `\n\n—\nYou are receiving this because ${why[lead.consent_basis] ?? 'of your prior contact with us'}.\nUnsubscribe: ${this.unsubscribeUrl(orgId, lead.email)}\n${this.cfg.email.postalAddress ?? '[POSTAL ADDRESS REQUIRED BEFORE SENDING]'}`;
  }

  async create(orgId: string, input: CampaignCreateInput, actor: Actor) {
    const id = newId('campaign');
    const product = input.productId ? await this.db.value<string>('SELECT name FROM products WHERE id = $1 AND org_id = $2', [input.productId, orgId]) : null;
    await this.db.query(
      `INSERT INTO campaigns (id, org_id, product_id, opportunity_id, experiment_id, name, subject_template, body_template, audience, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, orgId, input.productId ?? null, input.opportunityId ?? null, input.experimentId ?? null, input.name, input.subjectTemplate, input.bodyTemplate, json({ leadIds: input.leadIds ?? null, minLeadScore: input.minLeadScore ?? null }), actor.id],
    );
    const params: unknown[] = [orgId];
    let where = 'org_id = $1';
    if (input.leadIds?.length) {
      params.push(input.leadIds);
      where += ` AND id = ANY($${params.length})`;
    } else {
      if (input.opportunityId) {
        params.push(input.opportunityId);
        where += ` AND opportunity_id = $${params.length}`;
      }
      if (input.minLeadScore !== undefined) {
        params.push(input.minLeadScore);
        where += ` AND score >= $${params.length}`;
      }
    }
    const audience = await this.db.many<Record<string, any>>(`SELECT * FROM leads WHERE ${where} LIMIT 5000`, params);
    let drafted = 0;
    const skipped: Record<string, number> = {};
    for (const lead of audience) {
      let reason: string | null = null;
      if (!lead.email) reason = 'no_email';
      else if (lead.consent_basis === 'unknown') reason = 'consent_unknown';
      else if (['unsubscribed', 'lost'].includes(lead.status)) reason = `status_${lead.status}`;
      else if (await this.leads.isSuppressed(orgId, lead.email)) reason = 'suppressed';
      if (reason) {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
        continue;
      }
      const subject = this.render(input.subjectTemplate, lead, product ?? 'our product').slice(0, 200);
      const body = this.render(input.bodyTemplate, lead, product ?? 'our product') + this.footer(orgId, lead);
      await this.db.query(`INSERT INTO outbox_messages (id, org_id, campaign_id, lead_id, to_address, subject, body) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [newId('outbox'), orgId, id, lead.id, lead.email, subject, body]);
      drafted++;
    }
    await this.db.query('UPDATE campaigns SET stats = $3 WHERE id = $1 AND org_id = $2', [id, orgId, json({ drafted, skipped, audience: audience.length })]);
    await this.audit.record({ orgId, actor, action: 'campaign.create', targetType: 'campaign', targetId: id, details: { drafted, skipped } });
    await this.events.publish(orgId, 'campaign.updated', { entityType: 'campaign', entityId: id, payload: { status: 'draft', drafted } });
    return this.get(orgId, id);
  }

  async get(orgId: string, id: string) {
    const row = await this.db.one('SELECT * FROM campaigns WHERE id = $1 AND org_id = $2', [id, orgId]);
    if (!row) throw new NotFoundError('Campaign', id);
    const messages = await this.db.many('SELECT id, lead_id, to_address, subject, body, status, provider, error, sent_at FROM outbox_messages WHERE campaign_id = $1 ORDER BY created_at LIMIT 500', [id]);
    const campaign: Record<string, any> = camelize<Record<string, any>>(row);
    campaign.messages = messages.map((m) => camelize<Record<string, any>>(m));
    return campaign as Record<string, any> & { id: string; name: string; status: string; messages: Record<string, any>[] };
  }

  async list(orgId: string) {
    return (await this.db.many('SELECT * FROM campaigns WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100', [orgId])).map((r) => camelize(r));
  }

  async requestSend(orgId: string, id: string, actor: Actor, opts: { taskId?: string } = {}) {
    const c = await this.get(orgId, id);
    if (!['draft', 'rejected'].includes(c.status)) throw new ConflictError(`Campaign is ${c.status}`);
    const recipients = c.messages.filter((m: any) => m.status === 'drafted').length;
    if (!recipients) throw new ConflictError('No eligible recipients (check consent basis, suppressions and emails).');
    if (!this.cfg.email.postalAddress) throw new PolicyDeniedError('COMPANY_POSTAL_ADDRESS must be configured before sending commercial email (CAN-SPAM / PECR).');
    const send = await this.policy.evaluate(orgId, 'outreach.send', { amountUsd: 0 });
    const mass = recipients > 100 ? await this.policy.evaluate(orgId, 'communication.mass') : null;
    if (send.decision === 'deny' || mass?.decision === 'deny') throw new PolicyDeniedError(send.reason);
    if (send.decision === 'allow' && (!mass || mass.decision === 'allow')) {
      await this.policy.recordAutonomous(orgId, 'outreach.send', actor, { campaignId: id, recipients });
      return { status: 'sending' as const, result: await this.send(orgId, id, actor) };
    }
    const sender = await this.senderFor(orgId);
    const approval = await this.approvals.request(orgId, {
      actionType: recipients > 100 ? 'communication.mass' : 'outreach.send',
      title: `Send campaign "${c.name}" to ${recipients} recipient(s)`,
      what: `Email ${recipients} lead(s) via ${sender.name}${sender.name === 'outbox' ? ' (stored only — nothing is delivered until an email provider is configured)' : ''}. Sample subject: "${c.messages[0]?.subject ?? ''}".`,
      why: c.experimentId ? `Drive traffic for experiment ${c.experimentId}.` : 'Reach consented leads about the product.',
      expectedBenefit: 'Replies, demos and signups from leads who already expressed interest.',
      expectedCostUsd: 0,
      risk: { level: recipients > 100 ? 'high' : 'medium', description: 'Unwanted email harms reputation and may breach anti-spam law. Only consented, unsuppressed leads are included; every message has an unsubscribe link.' },
      dataSources: [{ name: 'ROOS CRM (leads with declared consent basis)' }],
      reversibility: 'irreversible',
      payload: { campaignId: id, recipients, samples: c.messages.slice(0, 3).map((m: any) => ({ to: m.toAddress, subject: m.subject, body: m.body.slice(0, 600) })) },
      requestedBy: actor.id,
      taskId: opts.taskId ?? null,
    });
    await this.db.query(`UPDATE campaigns SET status = 'pending_approval', approval_id = $3, updated_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId, approval.id]);
    await this.events.publish(orgId, 'campaign.updated', { entityType: 'campaign', entityId: id, payload: { status: 'pending_approval' } });
    return { status: 'pending_approval' as const, approvalId: approval.id };
  }

  /** Executes an approved send (approval executor) or an AUTONOMOUS-policy send. */
  async send(orgId: string, id: string, actor: Actor) {
    const sender = await this.senderFor(orgId);
    await this.db.query(`UPDATE campaigns SET status = 'sending', updated_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId]);
    const sentToday = Number(await this.db.value(`SELECT COUNT(*) FROM outbox_messages WHERE org_id = $1 AND status = 'sent' AND sent_at > now() - interval '1 day'`, [orgId]));
    let budget = Math.max(0, this.cfg.email.dailyCap - sentToday);
    const msgs = await this.db.many<Record<string, any>>(`SELECT * FROM outbox_messages WHERE campaign_id = $1 AND org_id = $2 AND status = 'drafted'`, [id, orgId]);
    const stats = { sent: 0, notDelivered: 0, suppressed: 0, failed: 0, deferredByDailyCap: 0 };
    for (const m of msgs) {
      if (await this.leads.isSuppressed(orgId, m.to_address)) {
        await this.db.query(`UPDATE outbox_messages SET status = 'suppressed' WHERE id = $1`, [m.id]);
        stats.suppressed++;
        continue;
      }
      if (budget <= 0) {
        stats.deferredByDailyCap++;
        continue;
      }
      try {
        const r = await sender.send({ to: m.to_address, from: this.cfg.email.from ?? 'noreply@example.com', subject: m.subject, text: m.body, unsubscribeUrl: this.unsubscribeUrl(orgId, m.to_address) });
        if (r.accepted) {
          budget--;
          stats.sent++;
          await this.db.query(`UPDATE outbox_messages SET status = 'sent', provider = $2, provider_message_id = $3, sent_at = now() WHERE id = $1`, [m.id, sender.name, r.providerMessageId ?? null]);
          await this.db.query(`UPDATE leads SET status = CASE WHEN status IN ('new','qualified') THEN 'contacted' ELSE status END, last_contacted_at = now() WHERE id = $1`, [m.lead_id]);
        } else {
          stats.notDelivered++;
          await this.db.query(`UPDATE outbox_messages SET status = 'approved', provider = $2, error = $3 WHERE id = $1`, [m.id, sender.name, r.note ?? null]);
        }
      } catch (e) {
        stats.failed++;
        await this.db.query(`UPDATE outbox_messages SET status = 'failed', provider = $2, error = $3 WHERE id = $1`, [m.id, sender.name, errorMessage(e).slice(0, 500)]);
        this.logger.warn('Email send failed', { campaignId: id, error: errorMessage(e) });
      }
    }
    const final = stats.deferredByDailyCap ? 'approved' : 'sent';
    await this.db.query(`UPDATE campaigns SET status = $3, stats = stats || $4, updated_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId, final, json({ send: stats, driver: sender.name })]);
    await this.audit.record({ orgId, actor, action: 'campaign.send', targetType: 'campaign', targetId: id, details: { ...stats, driver: sender.name } });
    await this.events.publish(orgId, 'campaign.updated', { entityType: 'campaign', entityId: id, payload: { status: final, ...stats } });
    return stats;
  }
}
