import { describe, it, expect } from 'vitest';

import { createCompromiseFallback } from '../../src/runtime/mention/compromise-fallback.js';

describe('createCompromiseFallback', () => {
  it('preserves exact source spans with the real compromise runtime, including quoted names', async () => {
    const text = '"Alice Wong" traveled to Tokyo. Acme Corp opened an office.';
    const spans = await createCompromiseFallback().extract({
      text,
      chunkId: 'c1',
      documentId: 'd1',
      documentVersionId: 'd1@v1',
    });

    expect(
      spans.map(({ entity_type, entity_name, span_start, span_end }) => ({
        entity_type,
        entity_name,
        span_start,
        span_end,
      }))
    ).toEqual([
      { entity_type: 'person', entity_name: '"Alice Wong"', span_start: 0, span_end: 12 },
      { entity_type: 'company', entity_name: 'Acme Corp', span_start: 32, span_end: 41 },
      { entity_type: 'location', entity_name: 'Tokyo.', span_start: 25, span_end: 31 },
    ]);
    for (const span of spans) {
      expect(text.slice(span.span_start, span.span_end)).toBe(span.entity_name);
    }
  });

  it('extracts person / company / place spans via the injected nlp factory', async () => {
    const fakeNlp = (_text: string) => ({
      people: () => ({
        out: () => [{ text: 'Alice Wong', offset: { start: 0, length: 10 } }],
      }),
      organizations: () => ({
        out: () => [{ text: 'Acme Corp', offset: { start: 30, length: 9 } }],
      }),
      places: () => ({
        out: () => [{ text: 'Tokyo', offset: { start: 50, length: 5 } }],
      }),
      match: () => ({ out: () => [] }),
    });
    const fb = createCompromiseFallback({ nlp: fakeNlp });
    const spans = await fb.extract({
      text: 'Alice Wong met with Acme Corp in Tokyo last week.',
      chunkId: 'c1',
      documentId: 'd1',
      documentVersionId: 'd1@v1',
    });
    expect(spans).toHaveLength(3);
    const byType = Object.fromEntries(spans.map((s) => [s.entity_type, s]));
    expect(byType['person']?.entity_name).toBe('Alice Wong');
    expect(byType['company']?.entity_name).toBe('Acme Corp');
    expect(byType['location']?.entity_name).toBe('Tokyo');
  });

  it('drops single-character noise terms', async () => {
    const fakeNlp = () => ({
      people: () => ({ out: () => [{ text: 'A', offset: { start: 0, length: 1 } }] }),
      organizations: () => ({ out: () => [] }),
      places: () => ({ out: () => [] }),
      match: () => ({ out: () => [] }),
    });
    const fb = createCompromiseFallback({ nlp: fakeNlp });
    const spans = await fb.extract({
      text: 'A',
      chunkId: 'c',
      documentId: 'd',
      documentVersionId: 'd@v',
    });
    expect(spans).toHaveLength(0);
  });

  it('reports per-entity-type source_confidence per Drop 5 research', async () => {
    const fakeNlp = () => ({
      people: () => ({ out: () => [{ text: 'Alice Wong', offset: { start: 0, length: 10 } }] }),
      organizations: () => ({
        out: () => [{ text: 'Acme Corp', offset: { start: 0, length: 9 } }],
      }),
      places: () => ({ out: () => [{ text: 'Tokyo', offset: { start: 0, length: 5 } }] }),
      match: () => ({ out: () => [] }),
    });
    const fb = createCompromiseFallback({ nlp: fakeNlp });
    const spans = await fb.extract({
      text: '...',
      chunkId: 'c',
      documentId: 'd',
      documentVersionId: 'd@v',
    });
    const byType = Object.fromEntries(spans.map((s) => [s.entity_type, s.source_confidence]));
    expect(byType['person']).toBeCloseTo(0.7);
    expect(byType['location']).toBeCloseTo(0.6);
    expect(byType['company']).toBeCloseTo(0.55);
  });

  it('keeps generic spans neutral when multiple project entity types are available', async () => {
    const fakeNlp = () => ({
      people: () => ({ out: () => [] }),
      organizations: () => ({
        out: () => [{ text: 'Acme Corp', offset: { start: 0, length: 9 } }],
      }),
      places: () => ({ out: () => [] }),
      match: () => ({ out: () => [] }),
    });
    const fb = createCompromiseFallback({
      nlp: fakeNlp,
      entityTypes: ['Customer', 'Product'],
    });
    const spans = await fb.extract({
      text: 'Acme Corp',
      chunkId: 'c',
      documentId: 'd',
      documentVersionId: 'd@v',
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.entity_type).toBe('company');
  });

  it('keeps person spans neutral for candidate-led multi-entity extraction', async () => {
    const fakeNlp = () => ({
      people: () => ({ out: () => [{ text: 'Alice Wong', offset: { start: 0, length: 10 } }] }),
      organizations: () => ({ out: () => [] }),
      places: () => ({ out: () => [] }),
      match: () => ({ out: () => [] }),
    });
    const fb = createCompromiseFallback({
      nlp: fakeNlp,
      entityTypes: ['Customer', 'Engineer', 'Product'],
    });
    const spans = await fb.extract({
      text: 'Alice Wong owns the rollout.',
      chunkId: 'c',
      documentId: 'd',
      documentVersionId: 'd@v',
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.entity_type).toBe('person');
  });

  it('maps generic spans to the only project entity type for single-entity specs', async () => {
    const fakeNlp = () => ({
      people: () => ({ out: () => [] }),
      organizations: () => ({
        out: () => [{ text: 'Acme Corp', offset: { start: 0, length: 9 } }],
      }),
      places: () => ({ out: () => [] }),
      match: () => ({ out: () => [] }),
    });
    const fb = createCompromiseFallback({
      nlp: fakeNlp,
      entityTypes: ['Customer'],
    });
    const spans = await fb.extract({
      text: 'Acme Corp',
      chunkId: 'c',
      documentId: 'd',
      documentVersionId: 'd@v',
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.entity_type).toBe('Customer');
  });
});
