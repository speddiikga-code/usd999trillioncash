import { pipelineValue, scoreLead } from '@roos/analytics';
import { parseCsv } from '@roos/connectors';
import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { csvSafe } from '@roos/security';
import {
  camelize,
  CONSENT_BASES,
  ConflictError,
  newId,
  NotFoundError,
  randomToken,
  sha256Hex,
  type ConsentBasis,
  type LeadCreateInput,
  type LeadStatus,
} from '@roos/shared';
import type { Actor, AuditService } from './audit';
import type { EventBus } from './events';

const emailHash = (e: string) => sha256Hex(e.trim().toLowerCase());
const referralCode = () => `r_${randomToken(6).replace(/[^a-zA-Z0-9]/g, 'x')}`;

/**
 * CRM. Leads come only from permitted sources: inbound signups (consented), operator-imported
 * lists that declare a consent basis, and manual entry. Leads with consent basis "unknown" are
 * stored and scored but never contacted. Suppressions (unsubscribes/complaints) are permanent.
 */
export class LeadService {
  constructor(
    private db: Db,
    private audit: AuditService,
    private events: EventBus,
  ) {}

  async list(orgId: string, q: { status?: LeadStatus; minScore?: number; q?: string; limit?: number } = {}) {
    const params: unknown[] = [orgId];
    let where = 'org_id = $1';
    if (q.status) {
      params.push(q.status);
      where += ` AND status = $${params.length}`;
    }
    if (q.minScore !== undefined) {
      params.push(q.minScore);
      where += ` AND score >= $${params.length}`;
    }
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      where += ` AND (lower(name) LIKE $${params.length} OR lower(coalesce(company,'')) LIKE $${params.length} OR lower(coalesce(email,'')) LIKE $${params.length})`;
    }
    params.push(Math.min(q.limit ?? 200, 1000));
    return (await this.db.many(`SELECT * FROM leads WHERE ${where} ORDER BY score DESC, created_at DESC LIMIT $${params.length}`, params)).map((r) => camelize<Record<string, any>>(r));
  }

  async get(orgId: string, id: string) {
    const row = await this.db.one('SELECT * FROM leads WHERE id = $1 AND org_id = $2', [id, orgId]);
    if (!row) throw new NotFoundError('Lead', id);
    return camelize<Record<string, any>>(row);
  }

  async create(orgId: string, input: LeadCreateInput, actor: Actor) {
    if (input.email && (await this.db.one('SELECT 1 FROM leads WHERE org_id = $1 AND email = $2', [orgId, input.email.toLowerCase()]))) throw new ConflictError('A lead with this email already exists');
    const id = newId('lead');
    await this.db.query(
      `INSERT INTO leads (id, org_id, opportunity_id, product_id, name, email, email_hash, company, title, website, source, consent_basis, notes, referral_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, orgId, input.opportunityId ?? null, input.productId ?? null, input.name, input.email?.toLowerCase() ?? null, input.email ? emailHash(input.email) : null, input.company ?? null, input.title ?? null, input.website ?? null, input.source, input.consentBasis, input.notes ?? null, referralCode()],
    );
    await this.rescore(orgId, id);
    await this.audit.record({ orgId, actor, action: 'lead.create', targetType: 'lead', targetId: id, details: { source: input.source, consentBasis: input.consentBasis } });
    await this.events.publish(orgId, 'lead.created', { entityType: 'lead', entityId: id, payload: { source: input.source } });
    return this.get(orgId, id);
  }

  /** Inbound signup from a launched product (consent basis: inbound). Returns the lead id. */
  async upsertInbound(orgId: string, s: { email: string; name?: string; productId: string; opportunityId?: string | null; anonymousId: string; ref?: string }) {
    const email = s.email.toLowerCase();
    const existing = await this.db.one<{ id: string }>('SELECT id FROM leads WHERE org_id = $1 AND email = $2', [orgId, email]);
    if (existing) {
      await this.db.query('UPDATE leads SET anonymous_id = COALESCE(anonymous_id, $3), updated_at = now() WHERE id = $1 AND org_id = $2', [existing.id, orgId, s.anonymousId]);
      await this.rescore(orgId, existing.id);
      return existing.id;
    }
    const referrer = s.ref ? await this.db.value<string>('SELECT id FROM leads WHERE org_id = $1 AND referral_code = $2', [orgId, s.ref]) : null;
    const id = newId('lead');
    await this.db.query(
      `INSERT INTO leads (id, org_id, opportunity_id, product_id, name, email, email_hash, source, consent_basis, anonymous_id, referral_code, referred_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'inbound_signup','inbound',$8,$9,$10)`,
      [id, orgId, s.opportunityId ?? null, s.productId, s.name?.slice(0, 200) || email.split('@')[0], email, emailHash(email), s.anonymousId, referralCode(), referrer],
    );
    await this.rescore(orgId, id);
    await this.events.publish(orgId, 'lead.created', { entityType: 'lead', entityId: id, payload: { source: 'inbound_signup', referred: !!referrer } });
    return id;
  }

  async update(orgId: string, id: string, patch: { status?: LeadStatus; notes?: string; consentBasis?: ConsentBasis }, actor: Actor) {
    await this.get(orgId, id);
    await this.db.query(`UPDATE leads SET status = COALESCE($3, status), notes = COALESCE($4, notes), consent_basis = COALESCE($5, consent_basis), updated_at = now() WHERE id = $1 AND org_id = $2`, [
      id,
      orgId,
      patch.status ?? null,
      patch.notes ?? null,
      patch.consentBasis ?? null,
    ]);
    await this.audit.record({ orgId, actor, action: 'lead.update', targetType: 'lead', targetId: id, details: patch });
    return this.get(orgId, id);
  }

  async importCsv(orgId: string, input: { csv: string; source: string; defaultConsentBasis: ConsentBasis; opportunityId?: string }, actor: Actor) {
    const rows = parseCsv(input.csv, { maxRows: 5000 });
    let created = 0;
    let skipped = 0;
    const problems: string[] = [];
    for (const [i, r] of rows.entries()) {
      const email = (r.email ?? '').toLowerCase();
      const name = r.name || r['full name'] || [r['first name'], r['last name']].filter(Boolean).join(' ');
      const consentRaw = (r.consent ?? r.consent_basis ?? '').toLowerCase();
      const consent = ((CONSENT_BASES as readonly string[]).includes(consentRaw) ? consentRaw : input.defaultConsentBasis) as ConsentBasis;
      if (!name || (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
        skipped++;
        if (problems.length < 20) problems.push(`Row ${i + 2}: missing name or invalid email`);
        continue;
      }
      if (email && (await this.db.one('SELECT 1 FROM leads WHERE org_id = $1 AND email = $2', [orgId, email]))) {
        skipped++;
        continue;
      }
      const id = newId('lead');
      await this.db.query(
        `INSERT INTO leads (id, org_id, opportunity_id, name, email, email_hash, company, title, website, source, consent_basis, notes, referral_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, orgId, input.opportunityId ?? null, name.slice(0, 200), email || null, email ? emailHash(email) : null, r.company?.slice(0, 200) || null, r.title?.slice(0, 200) || null, r.website?.slice(0, 500) || null, input.source, consent, r.notes?.slice(0, 2000) || null, referralCode()],
      );
      await this.rescore(orgId, id);
      created++;
    }
    await this.audit.record({ orgId, actor, action: 'lead.import', details: { rows: rows.length, created, skipped, source: input.source, defaultConsentBasis: input.defaultConsentBasis } });
    return {
      rows: rows.length,
      created,
      skipped,
      problems,
      note: input.defaultConsentBasis === 'unknown' ? 'Rows without a declared consent basis were imported as "unknown" and will never be contacted.' : undefined,
    };
  }

  async rescore(orgId: string, id: string) {
    const lead = await this.db.one<Record<string, any>>('SELECT * FROM leads WHERE id = $1 AND org_id = $2', [id, orgId]);
    if (!lead) return;
    const evRows = lead.anonymous_id
      ? await this.db.many<{ event: string; n: number }>(`SELECT event, COUNT(*)::int AS n FROM tracking_events WHERE org_id = $1 AND (anonymous_id = $2 OR lead_id = $3) AND NOT is_bot GROUP BY event`, [orgId, lead.anonymous_id, id])
      : [];
    const icp = lead.opportunity_id ? ((await this.db.value<string[]>(`SELECT signals->'keywords' FROM opportunities WHERE id = $1`, [lead.opportunity_id])) ?? []) : [];
    const referred = Number(await this.db.value('SELECT COUNT(*) FROM leads WHERE referred_by = $1', [id]));
    const s = scoreLead({
      title: lead.title,
      company: lead.company,
      email: lead.email,
      consentBasis: lead.consent_basis,
      icpKeywords: icp.flatMap((k) => k.split(' ')),
      events: { ...Object.fromEntries(evRows.map((e) => [e.event, e.n])), referral: referred },
      b2b: true,
    });
    await this.db.query('UPDATE leads SET score = $3, score_breakdown = $4, updated_at = now() WHERE id = $1 AND org_id = $2', [id, orgId, s.score, json({ ...s })]);
  }

  async suppress(orgId: string, email: string, reason: string) {
    await this.db.query('INSERT INTO suppressions (org_id, email_hash, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [orgId, emailHash(email), reason]);
    await this.db.query(`UPDATE leads SET status = 'unsubscribed', updated_at = now() WHERE org_id = $1 AND email_hash = $2`, [orgId, emailHash(email)]);
  }

  async isSuppressed(orgId: string, email: string) {
    return !!(await this.db.one('SELECT 1 FROM suppressions WHERE org_id = $1 AND email_hash = $2', [orgId, emailHash(email)]));
  }

  async pipeline(orgId: string) {
    const rows = await this.db.many<{ status: string; price: number | null }>(
      `SELECT l.status, COALESCE((o.estimated_price->>'value')::float8, 50) AS price FROM leads l LEFT JOIN opportunities o ON o.id = l.opportunity_id WHERE l.org_id = $1`,
      [orgId],
    );
    // Expected deal value = 12 months at the opportunity's price estimate (assumption).
    return pipelineValue(rows.map((r) => ({ status: r.status, expectedValueUsd: Number(r.price ?? 50) * 12 })));
  }

  async exportCsv(orgId: string, actor: Actor) {
    const leads = await this.list(orgId, { limit: 1000 });
    const header = ['name', 'email', 'company', 'title', 'status', 'score', 'consent_basis', 'source', 'created_at'];
    const lines = [header.join(',')].concat(leads.map((l) => [l.name, l.email, l.company, l.title, l.status, l.score, l.consentBasis, l.source, l.createdAt].map(csvSafe).join(',')));
    await this.audit.record({ orgId, actor, action: 'lead.export', details: { count: leads.length } });
    return lines.join('\n') + '\n';
  }
}
