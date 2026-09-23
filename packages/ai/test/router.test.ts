import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BudgetExceededError } from '@roos/shared';
import { AnthropicProvider, extractJson, MockProvider, ModelRouter, PricingTable, ProviderError, type ModelCallRecord } from '../src';

const Schema = z.object({ title: z.string(), score: z.number().min(0).max(1) });

describe('ModelRouter', () => {
  it('reports unavailable when no provider is configured', () => {
    const r = new ModelRouter({ providers: [] });
    expect(r.available()).toBe(false);
  });

  it('chooses tiers by purpose and prompt size', () => {
    const r = new ModelRouter({ providers: [new MockProvider(() => '{}')] });
    expect(r.chooseTier({ purpose: 'research.extract_pain', prompt: 'x' })).toBe('fast');
    expect(r.chooseTier({ purpose: 'market.synthesize', prompt: 'x' })).toBe('balanced');
    expect(r.chooseTier({ purpose: 'product.spec', prompt: 'x' })).toBe('deep');
    expect(r.chooseTier({ purpose: 'research.extract_pain', prompt: 'x'.repeat(70_000) })).toBe('balanced');
    expect(r.chooseTier({ purpose: 'anything', tier: 'deep', prompt: 'x' })).toBe('deep');
  });

  it('falls back to the next provider on failure and records every attempt with cost', async () => {
    const calls: ModelCallRecord[] = [];
    const failing = new MockProvider(() => new ProviderError('anthropic', 'unavailable', 'overloaded', true), 'anthropic');
    const working = new MockProvider(() => ({ title: 'ok', score: 0.5 }), 'openai');
    const pricing = new PricingTable([{ provider: 'openai', model: 'mock-balanced', inputPerMtok: 1, outputPerMtok: 2 }]);
    const r = new ModelRouter({ providers: [working, failing], order: ['anthropic', 'openai'], pricing, onCall: (c) => void calls.push(c) });
    const out = await r.generateJson({ purpose: 'market.synthesize', prompt: 'hello' }, Schema, { orgId: 'org_1', taskId: 'task_1' });
    expect(out.data).toEqual({ title: 'ok', score: 0.5 });
    expect(out.meta.provider).toBe('openai');
    expect(out.meta.costUsd).toBeGreaterThan(0);
    expect(calls.map((c) => [c.provider, c.status])).toEqual([
      ['anthropic', 'error'],
      ['openai', 'ok'],
    ]);
    expect(calls[1]!.orgId).toBe('org_1');
    expect(calls[1]!.quality.validated).toBe(true);
  });

  it('repairs invalid JSON once, then escalates quality stats', async () => {
    const p = new MockProvider((_req, i) => (i === 0 ? 'Sure! {"title": "x", "score": 7}' : '```json\n{"title":"x","score":0.7}\n```'));
    const r = new ModelRouter({ providers: [p] });
    const out = await r.generateJson({ purpose: 'market.synthesize', prompt: 'p' }, Schema);
    expect(out.data.score).toBe(0.7);
    expect(p.calls[1]!.prompt).toMatch(/failed validation/);
    expect(r.qualityStats()[0]!.invalid).toBe(1);
  });

  it('throws after the repair attempt also fails', async () => {
    const r = new ModelRouter({ providers: [new MockProvider(() => 'not json')] });
    await expect(r.generateJson({ purpose: 'x', prompt: 'p' }, Schema)).rejects.toThrow(/validation/);
  });

  it('enforces budgets before calling and charges actual cost after', async () => {
    // A provider named 'mock' is always priced at $0, so impersonate a priced provider.
    const named = new MockProvider(() => ({ title: 't', score: 1 }), 'openai');
    const pricing = new PricingTable([{ provider: 'openai', model: 'mock-balanced', inputPerMtok: 1000, outputPerMtok: 1000 }]);
    const r2 = new ModelRouter({ providers: [named], pricing });
    let charged = 0;
    const budget = {
      remaining: 0.01,
      check(est: number) {
        if (est > this.remaining) throw new BudgetExceededError(`Estimated $${est} exceeds remaining $${this.remaining}`);
      },
      charge(usd: number) {
        charged += usd;
      },
    };
    await expect(r2.generateJson({ purpose: 'x', prompt: 'p'.repeat(1000) }, Schema, { budget })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(named.calls).toHaveLength(0);
    budget.remaining = 100;
    await r2.generateJson({ purpose: 'x', prompt: 'p' }, Schema, { budget });
    expect(charged).toBeGreaterThan(0);
  });

  it('applies a local per-provider rate limit and falls through to the next provider', async () => {
    const a = new MockProvider(() => ({ title: 'a', score: 0 }), 'anthropic');
    const b = new MockProvider(() => ({ title: 'b', score: 0 }), 'openai');
    const r = new ModelRouter({ providers: [a, b], rpm: { anthropic: 1 } });
    expect((await r.generateJson({ purpose: 'x', prompt: 'p' }, Schema)).data.title).toBe('a');
    expect((await r.generateJson({ purpose: 'x', prompt: 'p' }, Schema)).data.title).toBe('b');
  });

  it('always adds the untrusted-data system note', async () => {
    const p = new MockProvider(() => ({ title: 't', score: 0 }));
    await new ModelRouter({ providers: [p] }).generateJson({ purpose: 'x', system: 'You are a market analyst.', prompt: 'p' }, Schema);
    expect(p.calls[0]!.system).toMatch(/untrusted_data/);
    expect(p.calls[0]!.system).toMatch(/market analyst/);
    expect(p.calls[0]!.jsonSchema).toBeTruthy();
  });

  it('extracts JSON from noisy text', () => {
    expect(extractJson('Here you go:\n{"a":1}\nThanks')).toEqual({ a: 1 });
    expect(extractJson('```json\n[1,2]\n```')).toEqual([1, 2]);
    expect(extractJson('nothing')).toBeUndefined();
  });
});

describe('AnthropicProvider (official SDK against a local stub of the Messages API)', () => {
  let server: http.Server;
  let baseURL: string;
  const bodies: Record<string, unknown>[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  let nextResponse: Record<string, unknown> = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        bodies.push(JSON.parse(data));
        headers.push(req.headers);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(nextResponse));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const message = (text: string, stop_reason = 'end_turn', model = 'claude-opus-5') => ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });

  it('sends structured-output format, effort and the server-side refusal fallback for Claude Opus 5', async () => {
    nextResponse = message('{"title":"Invoice automation","score":0.8}');
    const p = new AnthropicProvider('test-key', undefined, { baseURL, maxRetries: 0 });
    const out = await p.complete({ model: 'claude-opus-5', prompt: 'hi', system: 'sys', maxOutputTokens: 16000, schema: Schema, effort: 'high', timeoutMs: 10_000 });
    expect(out.parsed).toEqual({ title: 'Invoice automation', score: 0.8 });
    expect(out.inputTokens).toBe(120);
    const body = bodies.at(-1)!;
    expect(body.model).toBe('claude-opus-5');
    expect(body.fallbacks).toBe('default');
    expect(String(headers.at(-1)!['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    const oc = body.output_config as { effort?: string; format?: { type: string } };
    expect(oc.effort).toBe('high');
    expect(oc.format?.type).toBe('json_schema');
  });

  it('does not send effort or fallbacks to Claude Haiku 4.5', async () => {
    nextResponse = message('plain text', 'end_turn', 'claude-haiku-4-5');
    const p = new AnthropicProvider('test-key', undefined, { baseURL, maxRetries: 0 });
    const out = await p.complete({ model: 'claude-haiku-4-5', prompt: 'hi', maxOutputTokens: 1000, effort: 'low', timeoutMs: 10_000 });
    expect(out.text).toBe('plain text');
    const body = bodies.at(-1)!;
    expect(body.fallbacks).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  it('maps stop_reason "refusal" to a non-retryable ProviderError', async () => {
    nextResponse = { ...message(''), content: [], stop_reason: 'refusal' };
    const p = new AnthropicProvider('test-key', undefined, { baseURL, maxRetries: 0 });
    await expect(p.complete({ model: 'claude-opus-5', prompt: 'hi', maxOutputTokens: 100, timeoutMs: 10_000 })).rejects.toMatchObject({ kind: 'refusal', retryable: false });
  });

  it('reports the model that actually served the request (server-side fallback)', async () => {
    nextResponse = message('ok', 'end_turn', 'claude-opus-4-8');
    const p = new AnthropicProvider('test-key', undefined, { baseURL, maxRetries: 0 });
    const out = await p.complete({ model: 'claude-opus-5', prompt: 'hi', maxOutputTokens: 100, timeoutMs: 10_000 });
    expect(out.model).toBe('claude-opus-4-8');
    expect(new PricingTable().cost('anthropic', out.model, 1_000_000, 0).priced).toBe(true);
  });
});
