import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildOnboardingSnapshot } from '../../../src/runtime/onboarding/snapshot.js';
it('shows user-authored meanings without copying connection credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-definitions-'));
  try {
    await mkdir(join(root, 'data/tv-night'), { recursive: true });
    await mkdir(join(root, 'models'));
    await writeFile(join(root, 'data/tv-night/manifest.json'), '{"version":"1","sources":[]}');
    await writeFile(join(root, 'data/tv-night/preview.json'), '[]');
    await writeFile(
      join(root, 'models/products.yml'),
      'name: products\ndescription: One packaged product\ncolumns:\n  - name: sugar\n    expr: sugar_100g\nsecret: do-not-render\n'
    );
    const snapshot = await buildOnboardingSnapshot(root);
    expect(snapshot).toHaveProperty('definitions.0.name', 'products');
    expect(JSON.stringify(snapshot)).not.toContain('do-not-render');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('uses loaded rows and keeps metric expressions and join keys in the page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-loaded-'));
  try {
    await mkdir(join(root, 'data/tv-night'), { recursive: true });
    for (const dir of ['metrics', 'relationships']) await mkdir(join(root, dir));
    await writeFile(join(root, 'data/tv-night/manifest.json'), '{"version":"1","sources":[]}');
    await writeFile(
      join(root, 'data/tv-night/preview.json'),
      JSON.stringify([
        { name: 'Bundled', columns: ['name'], rows: [{ name: 'old' }], totalRows: 1 },
      ])
    );
    await writeFile(
      join(root, 'metrics/count.yml'),
      'name: count\nexpression: COUNT({products}.code)\n'
    );
    await writeFile(
      join(root, 'relationships/prices.yml'),
      'name: prices\nleft_model: products\nright_model: prices\njoin_type: left\nrelationship_type: one_to_many\njoin_columns:\n  - left: code\n    right: product_code\n'
    );
    const { saveCheckpoint } = await import('../../../src/runtime/onboarding/state.js');
    await saveCheckpoint(root, 'load', {
      mode: 'offline',
      tables: [{ name: 'Loaded', columns: ['name'], rows: [{ name: 'new' }], totalRows: 2 }],
      receipts: [],
    });
    const snapshot = await buildOnboardingSnapshot(root);
    expect(snapshot.tables[0]?.rows).toEqual([{ name: 'new' }]);
    expect(snapshot.definitions?.flatMap((d) => d.fields)).toEqual(
      expect.arrayContaining(['COUNT({products}.code)', 'products → prices', 'code = product_code'])
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('starts with no records and no invented recommendation before ETL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-empty-'));
  try {
    await mkdir(join(root, 'data/tv-night'), { recursive: true });
    await writeFile(
      join(root, 'data/tv-night/manifest.json'),
      '{"version":"tv-night-1","sources":[]}'
    );
    const snapshot = await buildOnboardingSnapshot(root);
    expect(snapshot.tables).toEqual([]);
    expect(snapshot.state.steps[0]?.id).toBe('connect');
    expect(snapshot.state.steps.every((s) => s.status === 'not_started')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('loads the original question from the learner project without substituting an example', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-question-'));
  try {
    await mkdir(join(root, 'data/tv-night'), { recursive: true });
    await writeFile(join(root, 'data/tv-night/manifest.json'), '{"version":"1","sources":[]}');
    expect((await buildOnboardingSnapshot(root)).question).toBeUndefined();
    await writeFile(
      join(root, 'data/tv-night/question.json'),
      JSON.stringify({ original: 'I liked The Expanse. What should I watch next?' })
    );
    expect((await buildOnboardingSnapshot(root)).question).toBe(
      'I liked The Expanse. What should I watch next?'
    );
    await writeFile(
      join(root, 'data/tv-night/question.json'),
      JSON.stringify({
        original: 'What should I watch next?',
        preferences: 'Sci-fi and political intrigue',
      })
    );
    const withPreferences = await buildOnboardingSnapshot(root);
    expect(withPreferences.question).toBe('What should I watch next?');
    expect(withPreferences.preferences).toBe('Sci-fi and political intrigue');
    await writeFile(
      join(root, 'data/tv-night/question.json'),
      JSON.stringify({ original: 'x'.repeat(2001) })
    );
    await expect(buildOnboardingSnapshot(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves learner inspection after source edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-review-stale-'));
  try {
    await mkdir(join(root, 'data/tv-night'), { recursive: true });
    await mkdir(join(root, 'sources'));
    await writeFile(join(root, 'data/tv-night/manifest.json'), '{"version":"1","sources":[]}');
    const source = join(root, 'sources/probe.yml');
    await writeFile(source, 'name: tvmaze_probe\nfilter:\n  id: 1825\n');
    const { saveCheckpoint } = await import('../../../src/runtime/onboarding/state.js');
    const { reviewChapter } = await import('../../../src/runtime/onboarding/journal.js');
    await saveCheckpoint(root, 'connect', { mode: 'live', tables: [], receipts: [] });
    await reviewChapter(root, 'connect');
    expect((await buildOnboardingSnapshot(root)).progress?.reviewed).toContain('connect');
    await writeFile(source, 'name: tvmaze_probe\nfilter:\n  id: 166\n');
    const snapshot = await buildOnboardingSnapshot(root);
    expect(snapshot.progress?.reviewed).toContain('connect');
    expect(snapshot.progress?.current).toBe('load');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('includes source descriptions and nested column meanings in the semantic overview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-source-semantics-'));
  try {
    await mkdir(join(root, 'data/tv-night'), { recursive: true });
    await mkdir(join(root, 'sources'));
    await writeFile(join(root, 'data/tv-night/manifest.json'), '{"version":"1","sources":[]}');
    await writeFile(
      join(root, 'sources/shows.yml'),
      `name: shows
source_type: warehouse_table
description: One row per fetched series.
ai_context:
  synonyms: [series, TV programme]
schema:
  columns:
    - name: average_runtime
      type: INTEGER
      description: Average minutes, not a maximum.
      ai_context:
        synonyms: [episode length]
secret: do-not-render
`
    );
    const snapshot = await buildOnboardingSnapshot(root);
    expect(snapshot.definitions?.[0]).toMatchObject({ kind: 'sources', name: 'shows' });
    expect(snapshot.definitions?.[0]?.description).toContain('TV programme');
    expect(snapshot.definitions?.[0]?.fields).toEqual([
      'average_runtime — Average minutes, not a maximum. · {"synonyms":["episode length"]}',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('do-not-render');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
