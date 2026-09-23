import type { Db } from '@roos/database';
import { json } from '@roos/database';
import { hmacSign } from '@roos/security';
import { newId, NotFoundError, randomToken, sha256Hex, type AppConfig, type TrackEventInput } from '@roos/shared';
import type { EventBus } from './events';
import type { LeadService } from './leads';
import { markStep } from './orgs';

const BOT_UA = /(bot|crawler|spider|slurp|headless|phantom|lighthouse|curl\/|wget\/|python-requests|go-http-client|scrapy)/i;

/**
 * Public funnel-event ingestion for launched products (landing pages / MVPs). Authenticated by the
 * product's write key; IPs are stored only as a keyed hash; bots are flagged and excluded from
 * experiment statistics; signups become inbound (consented) leads with referral attribution.
 */
export class TrackingService {
  constructor(
    private db: Db,
    private cfg: AppConfig,
    private events: EventBus,
    private leads: LeadService,
  ) {}

  async ingest(writeKey: string, input: TrackEventInput, meta: { ip?: string; userAgent?: string } = {}) {
    const product = await this.db.one<{ id: string; org_id: string; opportunity_id: string | null }>('SELECT id, org_id, opportunity_id FROM products WHERE write_key = $1', [writeKey]);
    if (!product) throw new NotFoundError('Product for write key');
    const orgId = product.org_id;

    let experimentId: string | null = null;
    if (input.experimentId) {
      experimentId = await this.db.value<string>('SELECT id FROM experiments WHERE id = $1 AND org_id = $2 AND (product_id = $3 OR product_id IS NULL)', [input.experimentId, orgId, product.id]);
    }
    const ua = meta.userAgent ?? '';
    const isBot = BOT_UA.test(ua) || BOT_UA.test(String(input.properties?.userAgent ?? ''));
    const ipHash = meta.ip ? hmacSign(meta.ip, this.cfg.secrets.appSecret).slice(0, 22) : null;

    let leadId: string | null = null;
    if (input.event === 'signup' && input.email && !isBot) {
      leadId = await this.leads.upsertInbound(orgId, {
        email: input.email,
        name: input.name,
        productId: product.id,
        opportunityId: product.opportunity_id,
        anonymousId: input.anonymousId,
        ref: input.ref,
      });
    }
    if ((input.event === 'unsubscribe' || input.event === 'complaint') && input.email) {
      await this.leads.suppress(orgId, input.email, input.event);
    }

    const id = newId('tracking');
    await this.db.query(
      `INSERT INTO tracking_events (id, org_id, product_id, experiment_id, variant, event, anonymous_id, lead_id, ref, path, value_usd, properties, occurred_at, ip_hash, user_agent_class, is_bot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id,
        orgId,
        product.id,
        experimentId,
        input.variant ?? null,
        input.event,
        input.anonymousId,
        leadId,
        input.ref ?? null,
        input.path ?? null,
        input.valueUsd ?? null,
        json(input.properties ?? {}),
        input.occurredAt ?? new Date().toISOString(),
        ipHash,
        isBot ? 'bot' : ua.slice(0, 40) || null,
        isBot,
      ],
    );
    if (!isBot) await markStep(this.db, orgId, 'track_results');
    if (['signup', 'payment', 'activation'].includes(input.event) && !isBot) {
      await this.events.publish(orgId, 'tracking.event', { entityType: 'product', entityId: product.id, payload: { event: input.event, experimentId } });
    }
    return { id, productId: product.id, experimentId, isBot, leadId };
  }

  async productSummary(orgId: string, productId: string) {
    return this.db.many(
      `SELECT event, COUNT(*)::int AS events, COUNT(DISTINCT anonymous_id)::int AS uniques FROM tracking_events
       WHERE org_id = $1 AND product_id = $2 AND NOT is_bot AND occurred_at > now() - interval '30 days' GROUP BY event ORDER BY uniques DESC`,
      [orgId, productId],
    );
  }

  static newReferralCode() {
    return `r_${randomToken(6).replace(/[^a-zA-Z0-9]/g, 'x')}`;
  }

  static emailHash(email: string) {
    return sha256Hex(email.trim().toLowerCase());
  }
}
