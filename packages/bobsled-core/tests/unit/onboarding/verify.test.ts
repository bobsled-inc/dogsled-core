import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  verifyOnboarding as verifyRaw,
  type CliReader,
} from '../../../src/runtime/onboarding/verify.js';
import { inspectOnboarding } from '../../../src/runtime/onboarding/state.js';
const roots: string[] = [];
async function verifyOnboarding(
  root: string,
  step: Parameters<typeof verifyRaw>[1],
  read: CliReader
) {
  return verifyRaw(root, step, async (r, sql, remote) => {
    const result = (await read(r, sql, remote)) as { rows: Record<string, unknown>[] };
    if (sql.includes('FROM analytics.recommendations')) {
      return {
        rows: result.rows.map((row) => ({
          id: row['show_id'],
          fit: 'unknown',
          reason: 'Evidence is incomplete.',
        })),
      };
    }
    return result;
  });
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'tv-verify-'));
  roots.push(root);
  await mkdir(join(root, 'data/tv-night'), { recursive: true });
  await writeFile(join(root, 'data/tv-night/manifest.json'), '{"version":"1","sources":[]}');
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('does not save success when a required table is empty', async () => {
  const root = await project();
  await expect(verifyOnboarding(root, 'load', async () => ({ rows: [] }))).rejects.toThrow(/empty/);
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'load')?.status).toBe('failed');
});
it('checks rows and captures full counts separately from previews', async () => {
  const root = await project();
  const result = await verifyOnboarding(root, 'load', async () => ({
    rows: [{ code: '001', _total_rows: 1000 }],
  }));
  expect(result.tables[0]).toMatchObject({ totalRows: 1000, rows: [{ code: '001' }] });
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'load')?.status).toBe(
    'complete'
  );
});
it('refuses a checkpoint when an input changes during execution', async () => {
  const root = await project();
  await expect(
    verifyOnboarding(root, 'query', async () => {
      await writeFile(join(root, 'data/tv-night/new.json'), '[]');
      return { rows: [] };
    })
  ).rejects.toThrow(/changed/);
});
it('shows a failed rerun instead of claiming the old success is current', async () => {
  const root = await project();
  await verifyOnboarding(root, 'query', async () => ({ rows: [] }));
  await expect(
    verifyOnboarding(root, 'query', async () => {
      throw new Error('service unavailable');
    })
  ).rejects.toThrow();
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'query')?.status).toBe(
    'failed'
  );
});
const note = {
  show_id: 1,
  in_shortlist: true,
  revision_id: 20,
  theme: 'identity',
  ending: 'unknown',
  support_excerpt: 'identity',
  article_text: 'A story about identity.',
  _bobsled_run_id: 'tv-test',
};
it('rejects invented article evidence, unsupported labels and missing evidence for an ending', async () => {
  const root = await project();
  for (const changes of [
    { theme: 'healthy' },
    { support_excerpt: 'family' },
    { theme: 'unknown', ending: 'concluded', support_excerpt: '' },
    { revision_id: null },
  ]) {
    await expect(
      verifyOnboarding(root, 'transform', async () => ({ rows: [{ ...note, ...changes }] }))
    ).rejects.toThrow(/evidence/);
  }
});
it('accepts supported notes and explicit unknowns without claiming a new live AI run', async () => {
  const root = await project();
  const result = await verifyOnboarding(root, 'transform', async () => ({
    rows: [note, { ...note, show_id: 2, theme: 'unknown', ending: 'unknown', support_excerpt: '' }],
  }));
  expect(result.mode).toBe('offline');
  expect(result.tables[0]?.rows).toHaveLength(2);
});
it('requires accepted identity links with evidence', async () => {
  const root = await project();
  await expect(
    verifyOnboarding(root, 'resolve', async () => ({
      rows: [
        {
          show_id: 1,
          page_id: 2,
          match_method: 'title',
          evidence: 'same name',
          review_status: 'candidate',
        },
      ],
    }))
  ).rejects.toThrow(/accepted/);
});

it('checks the connection through the remote query path without loading tables', async () => {
  const root = await project();
  const calls: boolean[] = [];
  await verifyOnboarding(root, 'connect', async (_root, sql, remote) => {
    calls.push(remote);
    expect(sql).toContain('sources.tvmaze_probe');
    return { rows: [{ id: 1, name: 'Example' }], receipts: ['action=materialized'] };
  });
  expect(calls).toEqual([true]);
  const state = await inspectOnboarding(root);
  expect(state.steps.find((s) => s.id === 'connect')?.status).toBe('complete');
  expect(state.steps.find((s) => s.id === 'load')?.status).toBe('not_started');
});

it('rejects more than five notes even when a preview would hide extra rows', async () => {
  const root = await project();
  await expect(
    verifyOnboarding(root, 'transform', async () => ({
      rows: [{ ...note, in_shortlist: true, _total_rows: 6 }],
    }))
  ).rejects.toThrow(/five/);
});
it('rejects notes outside the shortlist and duplicate show revisions', async () => {
  const root = await project();
  await expect(
    verifyOnboarding(root, 'transform', async () => ({ rows: [{ ...note, in_shortlist: false }] }))
  ).rejects.toThrow(/shortlist/);
  await expect(
    verifyOnboarding(root, 'transform', async () => ({
      rows: [
        { ...note, in_shortlist: true },
        { ...note, in_shortlist: true, revision_id: 21 },
      ],
    }))
  ).rejects.toThrow(/one note/);
});
it('does not mark enrichment complete when only one of three finalists has notes', async () => {
  const root = await project();
  await expect(
    verifyOnboarding(root, 'transform', async () => ({ rows: [{ ...note, finalist_count: 3 }] }))
  ).rejects.toThrow(/every finalist/);
});
it('does not mark federation complete with missing finalist articles', async () => {
  const root = await project();
  await expect(
    verifyOnboarding(root, 'federate', async () => ({
      rows: [{ id: 1, page_id: 2, article_text: 'text', finalist_count: 3 }],
    }))
  ).rejects.toThrow(/every finalist/);
});

it('renders nested source fields and large integer IDs without losing precision', async () => {
  const root = await project();
  const evidence = await verifyOnboarding(root, 'load', async () => ({
    rows: [{ id: 9007199254740993n, genres: ['Drama', 'Comedy'] }],
  }));
  expect(evidence.tables[0]?.rows[0]).toEqual({
    id: '9007199254740993',
    genres: '["Drama","Comedy"]',
  });
});

it('uses the same probe input scope for attempts and successful checks', async () => {
  const root = await project();
  await verifyOnboarding(root, 'connect', async () => {
    await writeFile(
      join(root, 'data/tv-night/question.json'),
      JSON.stringify({ original: 'What should I watch next?' })
    );
    return { rows: [{ id: 1825, name: 'The Expanse' }] };
  });
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'connect')?.status).toBe(
    'complete'
  );
  await expect(
    verifyOnboarding(root, 'connect', async () => {
      throw new Error('offline');
    })
  ).rejects.toThrow('offline');
  await writeFile(join(root, 'bobsled.yml'), 'pipelines: []\n');
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'connect')?.status).toBe(
    'failed'
  );
});

const passageNote = {
  show_id: 1,
  in_shortlist: true,
  revision_id: 20,
  article_text: 'A story about identity.',
  _bobsled_run_id: 'tv-test',
  fit: 'supported',
  explanation: 'The passage supports the criterion.',
  passage_ids: ['p1'],
  input_passages: [{ id: 'p1', text: 'A story about identity.' }],
  support_excerpt: 'A story about identity.',
};
it('checks selected passage IDs against the saved input without requiring legacy fields', async () => {
  const root = await project();
  await expect(
    verifyOnboarding(root, 'transform', async () => ({ rows: [passageNote] }))
  ).resolves.toBeDefined();
  for (const change of [
    { passage_ids: ['p2'] },
    { passage_ids: ['p1', 'p1'] },
    { support_excerpt: 'Changed wording' },
    { input_passages: [{ id: 'p1', text: 'Invented passage' }] },
    { passage_ids: [] },
    { fit: 'unknown' },
    { revision_id: 21, input_passages: null },
  ]) {
    await expect(
      verifyOnboarding(root, 'transform', async () => ({ rows: [{ ...passageNote, ...change }] }))
    ).rejects.toThrow(/evidence/);
  }
  await expect(
    verifyOnboarding(root, 'transform', async () => ({
      rows: [{ ...passageNote, fit: 'unknown', passage_ids: [], support_excerpt: '' }],
    }))
  ).resolves.toBeDefined();
});
it('checks one pilot without completing or resetting the chapter', async () => {
  const root = await project();
  const read: CliReader = async (_root, sql) => {
    expect(sql).toMatch(/WHERE (n.show_id|id) = 1 LIMIT/);
    return {
      rows: sql.includes('FROM analytics.recommendations')
        ? [{ id: 1, fit: 'supported', reason: 'Evidence reviewed.' }]
        : [{ ...passageNote, finalist_count: 5 }],
    };
  };
  const result = await verifyRaw(root, 'transform', read, { showId: 1 });
  expect(result.receipts[0]).toContain('Pilot check only');
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'transform')?.status).toBe(
    'not_started'
  );
  await expect(
    verifyRaw(root, 'transform', async () => ({ rows: [] }), { showId: 1 })
  ).rejects.toThrow(/empty/);
  expect((await inspectOnboarding(root)).steps.find((s) => s.id === 'transform')?.status).toBe(
    'not_started'
  );
  for (const showId of [0, -1, NaN, 1.5]) {
    await expect(verifyRaw(root, 'transform', read, { showId })).rejects.toThrow(
      /positive integer/
    );
  }
  await expect(verifyRaw(root, 'load', read, { showId: 1 })).rejects.toThrow(/transform/);
});
