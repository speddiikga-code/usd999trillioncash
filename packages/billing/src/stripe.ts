import { createHmac } from 'node:crypto';
import { safeEqual, safeFetch, type HttpFetcher } from '@roos/security';
import { ExternalServiceError } from '@roos/shared';

/**
 * Stripe integration.
 *
 *  - Webhooks are the source of VERIFIED revenue: only events whose `Stripe-Signature` validates
 *    against STRIPE_WEBHOOK_SECRET are recorded with verified = true.
 *  - The API client is read-only by default (use a Stripe *restricted* key with read permissions).
 *  - Creating products / prices / payment links is a `billing.configure` action and only runs from
 *    an approved approval request.
 */

export interface SignatureCheck {
  valid: boolean;
  reason?: string;
  timestamp?: number;
}

export function verifyStripeSignature(rawBody: string | Buffer, header: string | undefined, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): SignatureCheck {
  if (!header) return { valid: false, reason: 'Missing Stripe-Signature header' };
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length) return { valid: false, reason: 'Malformed Stripe-Signature header' };
  if (Math.abs(nowSec - t) > toleranceSec) return { valid: false, reason: 'Timestamp outside tolerance (possible replay)', timestamp: t };
  const expected = createHmac('sha256', secret).update(`${t}.${typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')}`).digest('hex');
  return sigs.some((s) => safeEqual(s, expected)) ? { valid: true, timestamp: t } : { valid: false, reason: 'Signature mismatch', timestamp: t };
}

/** Test helper: produce a valid header for a payload. */
export function signStripePayload(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode?: boolean;
  data: { object: Record<string, any>; previous_attributes?: Record<string, any> };
}

export type NormalizedBillingEvent =
  | { kind: 'charge'; externalId: string; amountUsd: number; currency: string; occurredAt: string; customerExternalId?: string; customerEmail?: string; subscriptionId?: string; productRef?: string; livemode: boolean }
  | { kind: 'refund'; externalId: string; amountUsd: number; currency: string; occurredAt: string; customerExternalId?: string; productRef?: string; livemode: boolean }
  | { kind: 'subscription_upsert'; externalId: string; subscriptionId: string; mrrUsd: number; status: string; currency: string; occurredAt: string; customerExternalId?: string; productRef?: string; livemode: boolean }
  | { kind: 'subscription_canceled'; externalId: string; subscriptionId: string; currency: string; occurredAt: string; customerExternalId?: string; productRef?: string; livemode: boolean };

/** Monthly-normalised recurring amount of a Stripe subscription object (in major units). */
export function subscriptionMonthlyAmount(sub: Record<string, any>): number {
  const items: any[] = sub.items?.data ?? [];
  let total = 0;
  for (const it of items) {
    const price = it.price ?? it.plan ?? {};
    const unit = Number(price.unit_amount ?? price.amount ?? 0) / 100;
    const qty = Number(it.quantity ?? 1);
    const interval = price.recurring?.interval ?? price.interval ?? 'month';
    const count = Number(price.recurring?.interval_count ?? price.interval_count ?? 1) || 1;
    const perMonth = interval === 'year' ? unit / (12 * count) : interval === 'week' ? (unit * 52) / 12 / count : interval === 'day' ? (unit * 365) / 12 / count : unit / count;
    total += perMonth * qty;
  }
  const discountPct = Number(sub.discount?.coupon?.percent_off ?? 0);
  return Math.round(total * (1 - discountPct / 100) * 100) / 100;
}

const iso = (s: number) => new Date(s * 1000).toISOString();
const productRef = (o: Record<string, any>) => o.metadata?.roos_product_id ?? o.subscription_details?.metadata?.roos_product_id ?? undefined;

export function normalizeStripeEvent(evt: StripeEvent): NormalizedBillingEvent | null {
  const o = evt.data.object;
  const livemode = !!evt.livemode;
  switch (evt.type) {
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      if (!o.amount_paid) return null;
      return {
        kind: 'charge',
        externalId: `in:${o.id}`,
        amountUsd: o.amount_paid / 100,
        currency: String(o.currency ?? 'usd'),
        occurredAt: iso(o.status_transitions?.paid_at ?? evt.created),
        customerExternalId: o.customer ?? undefined,
        customerEmail: o.customer_email ?? undefined,
        subscriptionId: o.subscription ?? undefined,
        productRef: productRef(o),
        livemode,
      };
    }
    case 'charge.succeeded': {
      if (o.invoice) return null; // counted via invoice.paid — avoid double counting
      return { kind: 'charge', externalId: `ch:${o.id}`, amountUsd: o.amount / 100, currency: String(o.currency ?? 'usd'), occurredAt: iso(o.created ?? evt.created), customerExternalId: o.customer ?? undefined, customerEmail: o.billing_details?.email ?? undefined, productRef: productRef(o), livemode };
    }
    case 'charge.refunded': {
      const refunded = Number(o.amount_refunded ?? 0) - Number(evt.data.previous_attributes?.amount_refunded ?? 0);
      if (refunded <= 0) return null;
      return { kind: 'refund', externalId: `re:${o.id}:${o.amount_refunded}`, amountUsd: refunded / 100, currency: String(o.currency ?? 'usd'), occurredAt: iso(evt.created), customerExternalId: o.customer ?? undefined, productRef: productRef(o), livemode };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      if (['incomplete', 'incomplete_expired'].includes(o.status)) return null;
      const active = ['active', 'trialing', 'past_due'].includes(o.status);
      return {
        kind: 'subscription_upsert',
        externalId: `${evt.id}`,
        subscriptionId: o.id,
        mrrUsd: active && o.status !== 'trialing' ? subscriptionMonthlyAmount(o) : 0,
        status: o.status,
        currency: String(o.currency ?? o.items?.data?.[0]?.price?.currency ?? 'usd'),
        occurredAt: iso(evt.created),
        customerExternalId: o.customer ?? undefined,
        productRef: productRef(o),
        livemode,
      };
    }
    case 'customer.subscription.deleted':
      return { kind: 'subscription_canceled', externalId: `${evt.id}`, subscriptionId: o.id, currency: String(o.currency ?? 'usd'), occurredAt: iso(o.canceled_at ?? evt.created), customerExternalId: o.customer ?? undefined, productRef: productRef(o), livemode };
    default:
      return null;
  }
}

/** Minimal Stripe REST client (form-encoded) over the SSRF-guarded fetcher. */
export class StripeClient {
  constructor(
    private secretKey: string,
    private fetcher: HttpFetcher = safeFetch,
    private baseUrl = 'https://api.stripe.com/v1',
  ) {}

  private async request<T>(method: 'GET' | 'POST', path: string, params: Record<string, string | number> = {}): Promise<T> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString();
    const url = method === 'GET' && qs ? `${this.baseUrl}${path}?${qs}` : `${this.baseUrl}${path}`;
    const res = await this.fetcher(url, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`,
        ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        'stripe-version': '2024-06-20',
      },
      body: method === 'POST' ? qs : undefined,
      timeoutMs: 20_000,
    });
    const body = res.json<T & { error?: { message?: string } }>();
    if (!res.ok) throw new ExternalServiceError(`Stripe API ${res.status}: ${body.error?.message ?? 'error'}`, { retryable: res.status >= 500 || res.status === 429 });
    return body;
  }

  /** READ: paid invoices created after `sinceSec` (verified revenue backfill). */
  async listPaidInvoices(sinceSec: number, limit = 100) {
    return this.request<{ data: Record<string, any>[]; has_more: boolean }>('GET', '/invoices', { status: 'paid', 'created[gte]': sinceSec, limit });
  }

  /** READ: active subscriptions (MRR snapshot). */
  async listSubscriptions(status = 'active', limit = 100) {
    return this.request<{ data: Record<string, any>[]; has_more: boolean }>('GET', '/subscriptions', { status, limit });
  }

  /** WRITE (billing.configure — approval required): product + recurring price + payment link. */
  async createPaymentLink(input: { productName: string; unitAmountUsd: number; interval: 'month' | 'year'; roosProductId: string }) {
    const product = await this.request<{ id: string }>('POST', '/products', { name: input.productName, 'metadata[roos_product_id]': input.roosProductId });
    const price = await this.request<{ id: string }>('POST', '/prices', {
      product: product.id,
      currency: 'usd',
      unit_amount: Math.round(input.unitAmountUsd * 100),
      'recurring[interval]': input.interval,
      'metadata[roos_product_id]': input.roosProductId,
    });
    const link = await this.request<{ id: string; url: string }>('POST', '/payment_links', {
      'line_items[0][price]': price.id,
      'line_items[0][quantity]': 1,
      'metadata[roos_product_id]': input.roosProductId,
      'subscription_data[metadata][roos_product_id]': input.roosProductId,
    });
    return { productId: product.id, priceId: price.id, paymentLinkId: link.id, url: link.url };
  }
}
