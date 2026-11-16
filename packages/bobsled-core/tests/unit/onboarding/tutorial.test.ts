import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveTutorial, getTutorial } from '../../../src/runtime/onboarding/tutorials.js';
import { inspectOnboarding, saveCheckpoint } from '../../../src/runtime/onboarding/state.js';
import { reviewChapter, readJournal } from '../../../src/runtime/onboarding/journal.js';

const roots: string[] = [];
async function project(tutorial?: string) {
  const root = await mkdtemp(join(tmpdir(), 'tutorial-'));
  roots.push(root);
  await mkdir(join(root, 'data/tv-night'), { recursive: true });
  await writeFile(
    join(root, 'data/tv-night/manifest.json'),
    JSON.stringify({ version: '1', sources: [], tutorial })
  );
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('resolves old and explicitly identified TV Night projects', async () => {
  expect((await resolveTutorial(await project())).id).toBe('tv-night');
  expect((await resolveTutorial(await project('tv-night'))).id).toBe('tv-night');
  expect(() => getTutorial('unknown')).toThrow(/Unknown tutorial/);
  await expect(resolveTutorial(await project('unknown'))).rejects.toThrow(/tutorial/i);
});
it('preserves legacy evidence and reviews without rewriting them', async () => {
  const root = await project();
  await saveCheckpoint(root, 'load', { mode: 'offline', tables: [], receipts: [] });
  const path = join(root, '.dogsled/onboarding/load.json');
  const old = JSON.parse(await readFile(path, 'utf8'));
  delete old.tutorial;
  await writeFile(path, JSON.stringify(old));
  await reviewChapter(root, 'load');
  const before = await readFile(path, 'utf8');
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'load')?.status).toBe(
    'complete'
  );
  expect((await readJournal(root)).reviews.load).toBeTruthy();
  expect(await readFile(path, 'utf8')).toBe(before);
});
it('rejects a saved checkpoint from another tutorial or chapter', async () => {
  const root = await project('tv-night');
  await saveCheckpoint(root, 'load', { mode: 'offline', tables: [], receipts: [] });
  const path = join(root, '.dogsled/onboarding/load.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(saved.tutorial).toBe('tv-night');
  await writeFile(path, JSON.stringify({ ...saved, tutorial: 'other' }));
  await expect(inspectOnboarding(root)).rejects.toThrow(/tutorial/i);
  await writeFile(path, JSON.stringify({ ...saved, step: 'query' }));
  await expect(inspectOnboarding(root)).rejects.toThrow(/chapter/i);
});

it('uses the same engine for a different definition, chapter order, database and page', async () => {
  const { buildOnboardingSnapshot } = await import('../../../src/runtime/onboarding/snapshot.js');
  const { renderOnboardingHtml } = await import('../../../src/runtime/onboarding/render.js');
  const { verifyOnboarding } = await import('../../../src/runtime/onboarding/verify.js');
  const root = await project();
  await mkdir(join(root, 'data/sample'), { recursive: true });
  await writeFile(
    join(root, 'data/sample/manifest.json'),
    '{"tutorial":"sample","version":"1","sources":[]}'
  );
  const tutorial: import('../../../src/runtime/onboarding/tutorial.js').TutorialDefinition = {
    id: 'sample',
    skill: 'sample',
    example: 'sample',
    dataDirectory: 'data/sample',
    databasePath: 'sample.duckdb',
    steps: [
      { id: 'count-items', label: 'Count items' },
      { id: 'describe-items', label: 'Describe items' },
    ],
    optionalSteps: [],
    lessons: {
      'count-items': {
        learn: 'Read item counts.',
        files: [],
        choice: 'Choose a count.',
        inspect: 'Inspect the count.',
      },
      'describe-items': {
        learn: 'Describe items.',
        files: [],
        choice: 'Choose a field.',
        inspect: 'Inspect the field.',
      },
    },
    teaching: {
      'count-items': { code: [], now: 'Counts are ready.', next: 'Describe items.', questions: [] },
      'describe-items': { code: [], now: 'Items are described.', next: 'Done.', questions: [] },
    },
    planned: { 'count-items': 'Count items.', 'describe-items': 'Describe items.' },
    descriptions: {},
    prompts: {},
    prepareCheck: () => ({
      queries: [{ name: 'Items', sql: 'SELECT item_id FROM items' }],
      remote: false,
      persist: true,
      receipts: [],
    }),
    validate(_step, tables) {
      if (tables[0]?.totalRows !== 6) throw new Error('Need six items.');
    },
    historyRows: (record) => record.tables[0]?.rows.slice(0, 1),
    sourceRows: (source) => source.rows,
    renderAnswer: () => '<p>Six items.</p>',
    teachingHtml: {},
    page: {
      title: 'Items',
      labels: {},
      titles: {},
      expandedTeaching: [],
      fallbackSource: 'Local files',
      noQuestion: 'Choose a question.',
      preferencesLabel: 'Your choice',
      noSources: 'Load items.',
      intro: 'Inspect items.',
      table: {
        passageColumns: ['notes'],
        passageLabel: 'Read notes',
        columnWidths: {},
        emptyDescription: 'Load items.',
      },
    },
  };
  const calls: unknown[][] = [];
  await verifyOnboarding(
    root,
    'count-items',
    async (...args) => {
      calls.push(args);
      return { rows: Array.from({ length: 6 }, (_, item_id) => ({ item_id })) };
    },
    {},
    tutorial
  );
  expect(calls).toEqual([[root, 'SELECT item_id FROM items', false, 'sample.duckdb']]);
  await reviewChapter(root, 'count-items', undefined, tutorial);
  const snapshot = await buildOnboardingSnapshot(root, tutorial);
  expect(snapshot.state.steps.map((s) => s.id)).toEqual(['count-items', 'describe-items']);
  expect(snapshot.progress?.current).toBe('describe-items');
  expect(snapshot.progress?.history[0]?.rows).toEqual([{ item_id: 0 }]);
  const html = renderOnboardingHtml(snapshot, tutorial);
  expect(html).toContain('Learn Dogsled with Items');
  expect(html).toContain('Count items');
  expect(html).toContain('Describe items');
  expect(html).toContain('sample.duckdb');
  expect(html).not.toMatch(/TVmaze|TV Night|Wikipedia|watchlist|shortlist|finalist|spoiler/);
  await expect(
    verifyOnboarding(
      root,
      'connect',
      async () => {
        throw new Error('Must not run');
      },
      {},
      tutorial
    )
  ).rejects.toThrow(/Choose count-items, describe-items/);
  expect(() => renderOnboardingHtml(snapshot)).toThrow(/Unknown tutorial/);
});

it('rejects unsafe chapter IDs before reading or writing progress', async () => {
  const root = await project();
  const { requireStep } = await import('../../../src/runtime/onboarding/tutorials.js');
  const { StepId } = await import('../../../src/runtime/onboarding/schema.js');
  for (const step of [
    '../load',
    '/load',
    'load/name',
    'load\\name',
    '',
    'a'.repeat(65),
    '<script>',
  ]) {
    expect(StepId.safeParse(step).success).toBe(false);
    expect(() => requireStep(getTutorial(), step)).toThrow(/Choose/);
    await expect(
      saveCheckpoint(root, step, { mode: 'offline', tables: [], receipts: [] })
    ).rejects.toThrow(/Choose/);
  }
});
