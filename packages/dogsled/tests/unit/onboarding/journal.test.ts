import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildOnboardingSnapshot } from '../../../src/runtime/onboarding/snapshot.js';
import { saveCheckpoint } from '../../../src/runtime/onboarding/state.js';
import { readJournal, reviewChapter } from '../../../src/runtime/onboarding/journal.js';
it('keeps reviewed evidence separate from new runs and records answer history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-journal-'));
  try {
    await mkdir(join(root, 'data/tv-night'), { recursive: true });
    await writeFile(join(root, 'data/tv-night/manifest.json'), '{"version":"1","sources":[]}');
    const evidence = {
      mode: 'offline' as const,
      receipts: [],
      tables: [{ name: 'Your shortlist', columns: ['name'], rows: [{ name: 'A' }], totalRows: 1 }],
    };
    await saveCheckpoint(root, 'query', evidence);
    expect((await readJournal(root)).reviews.query).toBeUndefined();
    await reviewChapter(root, 'query');
    const journal = await readJournal(root);
    expect(journal.reviews.query).toBeTruthy();
    expect((await buildOnboardingSnapshot(root)).progress?.reviewed).toContain('query');
    await mkdir(join(root, 'models'));
    await writeFile(join(root, 'models/later.yml'), 'name: later\ncolumns: []\n');
    // File edits do not undo inspection of a saved result.
    expect((await readJournal(root)).reviews.query).toBe(journal.reviews.query);
    expect((await buildOnboardingSnapshot(root)).progress?.reviewed).toContain('query');
    expect(journal.history[0]?.rows).toEqual([{ name: 'A' }]);
    await saveCheckpoint(root, 'query', {
      ...evidence,
      tables: [{ ...evidence.tables[0]!, rows: [{ name: 'B' }] }],
    });
    expect((await readJournal(root)).history).toHaveLength(2);
    expect((await buildOnboardingSnapshot(root)).progress?.reviewed).not.toContain('query');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
