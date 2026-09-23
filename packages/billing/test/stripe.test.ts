import { describe, expect, it } from 'vitest';
import { normalizeStripeEvent, signStripePayload, subscriptionMonthlyAmount, verifyStripeSignature } from '../src';

const secret = 'whsec_test_secret';

describe('Stripe webhook signatures', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  it('accepts a valid signature', () => {
    expect(verifyStripeSignature(body, signStripePayload(body, secret), secret).valid).toBe(true);
  });
  it('rejects tampered bodies, wrong secrets, replays and malformed headers', () => {
    const header = signStripePayload(body, secret);
    expect(verifyStripeSignature(body + ' ', header, secret).reason).toBe('Signature mismatch');
    expect(verifyStripeSignature(body, header, 'whsec_other').valid).toBe(false);
    const old = signStripePayload(body, secret, Math.floor(Date.now() / 1000) - 3600);
    expect(verifyStripeSignature(body, old, secret).reason).toMatch(/tolerance/);
    expect(verifyStripeSignature(body, 'garbage', secret).valid).toBe(false);
    expect(verifyStripeSignature(body, undefined, secret).valid).toBe(false);
  });
});

describe('Stripe event normalisation', () => {
  it('normalises paid invoices and skips invoice-linked charges', () => {
    const inv = normalizeStripeEvent({ id: 'evt_1', type: 'invoice.paid', created: 1780000000, data: { object: { id: 'in_1', amount_paid: 4900, currency: 'usd', customer: 'cus_1', subscription: 'sub_1', metadata: { roos_product_id: 'prd_x' } } } });
    expect(inv).toMatchObject({ kind: 'charge', externalId: 'in:in_1', amountUsd: 49, productRef: 'prd_x' });
    expect(normalizeStripeEvent({ id: 'evt_2', type: 'charge.succeeded', created: 1, data: { object: { id: 'ch_1', amount: 4900, invoice: 'in_1' } } })).toBeNull();
    expect(normalizeStripeEvent({ id: 'evt_3', type: 'charge.succeeded', created: 1, data: { object: { id: 'ch_2', amount: 1500, invoice: null } } })).toMatchObject({ kind: 'charge', amountUsd: 15 });
  });

  it('computes only the newly refunded amount', () => {
    const r = normalizeStripeEvent({ id: 'evt_4', type: 'charge.refunded', created: 1, data: { object: { id: 'ch_1', amount_refunded: 3000 }, previous_attributes: { amount_refunded: 1000 } } });
    expect(r).toMatchObject({ kind: 'refund', amountUsd: 20 });
  });

  it('normalises subscriptions to monthly recurring revenue', () => {
    const sub = { id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ quantity: 2, price: { unit_amount: 12000, currency: 'usd', recurring: { interval: 'year', interval_count: 1 } } }, { quantity: 1, price: { unit_amount: 2900, recurring: { interval: 'month' } } }] } };
    expect(subscriptionMonthlyAmount(sub)).toBeCloseTo(20 + 29, 5);
    const up = normalizeStripeEvent({ id: 'evt_5', type: 'customer.subscription.created', created: 1, data: { object: sub } });
    expect(up).toMatchObject({ kind: 'subscription_upsert', mrrUsd: 49, subscriptionId: 'sub_1' });
    const trial = normalizeStripeEvent({ id: 'evt_6', type: 'customer.subscription.created', created: 1, data: { object: { ...sub, status: 'trialing' } } });
    expect(trial).toMatchObject({ mrrUsd: 0 });
    expect(normalizeStripeEvent({ id: 'evt_7', type: 'customer.subscription.deleted', created: 1, data: { object: sub } })).toMatchObject({ kind: 'subscription_canceled' });
    expect(normalizeStripeEvent({ id: 'evt_8', type: 'customer.created', created: 1, data: { object: {} } })).toBeNull();
  });
});
