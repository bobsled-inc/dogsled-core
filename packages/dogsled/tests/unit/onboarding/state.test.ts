import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  inspectOnboarding,
  saveCheckpoint,
  saveAttempt,
  writeArtifact,
} from '../../../src/runtime/onboarding/state.js';

const roots: string[] = [];
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'tv-state-'));
  roots.push(root);
  await mkdir(join(root, 'data/tv-night'), { recursive: true });
  await writeFile(
    join(root, 'data/tv-night/manifest.json'),
    JSON.stringify({ version: '1', sources: [] })
  );
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('starts unfinished and preserves completed checks when source data changes', async () => {
  const root = await project();
  const first = await inspectOnboarding(root);
  expect(first.steps.find((s) => s.id === 'load')?.status).toBe('not_started');
  await saveCheckpoint(root, 'load', {
    mode: 'offline',
    tables: [{ name: 'catalog', columns: ['code'], rows: [{ code: '001' }], totalRows: 1 }],
    receipts: [],
  });
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'load')?.status).toBe(
    'complete'
  );
  await writeFile(join(root, 'data/tv-night/new.json'), '[]');
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'load')?.status).toBe(
    'complete'
  );
});
it('rejects reads and writes through a symlink outside the project', async () => {
  const root = await project();
  const outside = await mkdtemp(join(tmpdir(), 'tv-outside-'));
  roots.push(outside);
  await symlink(outside, join(root, '.dogsled'));
  await expect(writeArtifact(root, '<html>safe</html>')).rejects.toThrow(/symbolic|symlink/i);
});
it('does not mark a recorded transformation as a completed live run', async () => {
  const root = await project();
  await saveCheckpoint(root, 'transform', { mode: 'recorded', tables: [], receipts: [] });
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'transform')?.status).toBe(
    'needs_input'
  );
});
it('preserves completed checks when the database changes', async () => {
  const root = await project();
  await mkdir(join(root, '.dogsled'), { recursive: true });
  await writeFile(join(root, '.dogsled/dogsled.duckdb'), 'first database');
  await saveCheckpoint(root, 'query', { mode: 'offline', tables: [], receipts: [] });
  await writeFile(join(root, '.dogsled/dogsled.duckdb'), 'changed database contents');
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'query')?.status).toBe(
    'complete'
  );
});

it('does not accept a checkpoint with an unsupported format version', async () => {
  const root = await project();
  await mkdir(join(root, '.dogsled/onboarding'), { recursive: true });
  await writeFile(
    join(root, '.dogsled/onboarding/load.json'),
    JSON.stringify({
      step: 'load',
      mode: 'offline',
      tables: [],
      receipts: [],
      inputHash: 'a'.repeat(64),
      at: new Date().toISOString(),
    })
  );
  await expect(inspectOnboarding(root)).rejects.toThrow();
});

it('keeps a connection check current when only the local database changes', async () => {
  const root = await project();
  await saveCheckpoint(root, 'connect', { mode: 'live', tables: [], receipts: [] });
  await writeFile(join(root, '.dogsled/dogsled.duckdb'), 'new ETL tables');
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'connect')?.status).toBe(
    'complete'
  );
});

it('preserves the probe snapshot when preferences, sources and later chapter files change', async () => {
  const root = await project();
  for (const dir of ['sources', 'integrations', 'resources/api', 'models']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await writeFile(
    join(root, 'sources/custom-probe.yml'),
    'name: tvmaze_probe\nintegration: tvmaze\nresource: probe\nconnection: warehouse\n'
  );
  await writeFile(
    join(root, 'integrations/tvmaze.yml'),
    'name: tvmaze\ntransport:\n  base_url: https://api.tvmaze.com\n'
  );
  await writeFile(
    join(root, 'integrations/warehouse.yml'),
    'name: warehouse\nsource_type: duckdb\n'
  );
  const probePath = join(root, 'resources/api/one-show.yml');
  await writeFile(probePath, 'name: probe\nintegration: tvmaze\ninput:\n  show_id: 1825\n');
  await saveCheckpoint(root, 'connect', { mode: 'live', tables: [], receipts: [] });
  await writeFile(
    join(root, 'data/tv-night/question.json'),
    JSON.stringify({ original: 'What should I watch next?', preferences: 'Sci-fi' })
  );
  await writeFile(join(root, 'dogsled.yml'), 'pipelines: []\n');
  await writeFile(join(root, 'resources/api/catalog.yml'), 'name: shows\nintegration: tvmaze\n');
  await writeFile(join(root, 'models/shows.yml'), 'name: shows\n');
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'connect')?.status).toBe(
    'complete'
  );
  await writeFile(probePath, 'name: probe\nintegration: tvmaze\ninput:\n  show_id: 166\n');
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'connect')?.status).toBe(
    'complete'
  );
  await saveCheckpoint(root, 'connect', { mode: 'live', tables: [], receipts: [] });
  await writeFile(
    join(root, 'integrations/tvmaze.yml'),
    'name: tvmaze\ntransport:\n  base_url: https://example.com\n'
  );
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'connect')?.status).toBe(
    'complete'
  );
  await saveCheckpoint(root, 'connect', { mode: 'live', tables: [], receipts: [] });
  await rm(probePath);
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'connect')?.status).toBe(
    'complete'
  );
});

it('preserves all legacy chapter snapshots and inspections after normal project growth', async () => {
  const root = await project();
  const { steps } = await import('../../../src/runtime/onboarding/tutorials/tv-night/steps.js');
  const { reviewChapter } = await import('../../../src/runtime/onboarding/journal.js');
  const { buildOnboardingSnapshot } = await import('../../../src/runtime/onboarding/snapshot.js');
  for (const step of steps) {
    await saveCheckpoint(root, step.id, {
      mode: 'offline',
      tables: [],
      receipts: [],
    });
    // Old checkpoints have no scoped probe hash or database fingerprint.
    const path = join(root, `.dogsled/onboarding/${step.id}.json`);
    const record = JSON.parse(await readFile(path, 'utf8'));
    delete record.probeInputHash;
    delete record.databaseFingerprint;
    await writeFile(path, JSON.stringify(record));
    await reviewChapter(root, step.id);
  }
  const before = await inspectOnboarding(root);
  await mkdir(join(root, 'models'));
  await writeFile(join(root, 'models/next.yml'), 'name: next\n');
  await writeFile(join(root, '.dogsled/dogsled.duckdb'), 'new chapter data');
  const after = await buildOnboardingSnapshot(root);
  expect(after.state.steps.every((step) => step.status === 'complete')).toBe(true);
  expect(after.progress?.reviewed).toEqual(steps.map((step) => step.id));
  expect(after.state.steps.map((step) => step.evidence)).toEqual(
    before.steps.map((step) => step.evidence)
  );
});

it('keeps explicit failed and running attempts visible even after input edits', async () => {
  const root = await project();
  for (const status of ['running', 'failed'] as const) {
    await saveAttempt(root, 'load', status, 'a'.repeat(64));
    await writeFile(join(root, 'data/tv-night/new.json'), JSON.stringify({ status }));
    expect((await inspectOnboarding(root)).steps.find((step) => step.id === 'load')?.status).toBe(
      status
    );
  }
});
