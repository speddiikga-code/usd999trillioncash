import { describe, expect, it } from 'vitest';
import { clusterDocuments, detectSignals, inferSegments, screenRegulatory, tokenize, topKeywords } from '../src/text';

describe('text analytics', () => {
  it('tokenises, removes stopwords and stems', () => {
    expect(tokenize('The invoices are reconciled manually in spreadsheets')).toEqual(['invoice', 'reconcil', 'manually', 'spreadsheet']);
  });

  it('detects pain, seeking and willingness-to-pay language', () => {
    const s = detectSignals('Is there a tool for this? We waste hours every week copy-pasting invoices into Excel. I would happily pay $50/month.');
    expect(s.seekingMentions).toBeGreaterThanOrEqual(1);
    expect(s.wtpMentions).toBeGreaterThanOrEqual(1);
    expect(s.manualWorkMentions).toBe(1);
    expect(s.painScore).toBeGreaterThan(0.5);
    expect(s.matches.some((m) => m.label === 'would-pay')).toBe(true);
    expect(detectSignals('Nice weather today.').painScore).toBe(0);
  });

  it('clusters topically similar documents', () => {
    const docs = [
      { id: '1', text: 'Invoice reconciliation for small accounting firms is painful and manual' },
      { id: '2', text: 'Our accounting firm spends hours on invoice reconciliation every month' },
      { id: '3', text: 'Manual invoice reconciliation in spreadsheets is killing our accounting team' },
      { id: '4', text: 'Kubernetes deploys keep failing with helm chart drift in production clusters' },
      { id: '5', text: 'Helm chart drift breaks our kubernetes production deploys weekly' },
      { id: '6', text: 'My cat likes sleeping in the sun' },
    ];
    const clusters = clusterDocuments(docs, { threshold: 0.1, minSize: 2 });
    const sets = clusters.map((c) => new Set(c.ids));
    expect(sets.some((s) => s.has('1') && s.has('2') && s.has('3') && !s.has('4'))).toBe(true);
    expect(sets.some((s) => s.has('4') && s.has('5') && !s.has('1'))).toBe(true);
    expect(sets.some((s) => s.has('6'))).toBe(false);
    expect(clusters[0]!.keywords.length).toBeGreaterThan(0);
  });

  it('infers customer segments and screens regulatory risk', () => {
    expect(inferSegments('Our dental clinic loses patient records')[0]!.segment.segment).toMatch(/Healthcare/);
    const r = screenRegulatory('An app that stores patient medical records and offers lending');
    expect(r.risk).toBeGreaterThan(0.7);
    expect(r.flags.map((f) => f.area)).toEqual(expect.arrayContaining(['Health data / medical', 'Financial services']));
    expect(screenRegulatory('A tool to format markdown tables').risk).toBeLessThan(0.3);
  });

  it('extracts top keywords', () => {
    const k = topKeywords(['invoice reconciliation pain', 'invoice reconciliation hours', 'reconciliation for invoices']);
    expect(k.join(' ')).toMatch(/invoice|reconcil/);
  });
});
