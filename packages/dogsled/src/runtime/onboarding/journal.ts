import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CommandError } from '@bobsled-inc/protocol';
import { Cell, StepId, type Checkpoint } from './schema.js';
import { readBounded, writeLocal } from './files.js';
import { inspectOnboarding } from './state.js';
export const Journal = z.object({
  version: z.literal(1),
  reviews: z.record(z.string(), z.string()),
  history: z
    .array(
      z.object({
        step: StepId,
        at: z.string(),
        fingerprint: z.string(),
        rows: z.array(z.record(z.string(), Cell)).max(5),
      })
    )
    .max(30),
});
export const checkpointId = (record: Checkpoint): string =>
  createHash('sha256').update(JSON.stringify(record.tables)).digest('hex');
export async function readJournal(root: string): Promise<z.infer<typeof Journal>> {
  try {
    return Journal.parse(JSON.parse(await readBounded(root, '.dogsled/onboarding/journal.json')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return { version: 1, reviews: {}, history: [] };
  }
}
export async function recordHistory(root: string, record: Checkpoint): Promise<void> {
  if (!['query', 'transform', 'resolve'].includes(record.step)) return;
  const journal = await readJournal(root);
  // Keep a bounded history of actual evidence. Never turn generated prose into verified answers.
  const rows = (
    (record.tables.find((table) => table.name === 'Recommendations') ?? record.tables[0])?.rows ??
    []
  )
    .slice(0, 5)
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([key]) =>
          ['id', 'show_id', 'name', 'theme', 'ending', 'reason', 'review_status', 'fit'].includes(
            key
          )
        )
      )
    );
  journal.history.push({
    step: record.step,
    at: record.at,
    fingerprint: checkpointId(record),
    rows,
  });
  journal.history = journal.history.slice(-30);
  await writeLocal(root, '.dogsled/onboarding/journal.json', JSON.stringify(journal));
}
export async function reviewChapter(
  root: string,
  step: StepId,
  expectedCheckpoint?: string
): Promise<z.infer<typeof Journal>> {
  const current = (await inspectOnboarding(root)).steps.find((s) => s.id === step);
  if (current?.status !== 'complete' || !current.evidence) {
    throw new CommandError(
      'Run a successful check for this chapter before marking it inspected.',
      2
    );
  }
  if (expectedCheckpoint !== undefined && !/^[a-f0-9]{64}$/.test(expectedCheckpoint)) {
    throw new CommandError('Choose a valid saved checkpoint fingerprint.', 2);
  }
  if (expectedCheckpoint !== undefined && expectedCheckpoint !== checkpointId(current.evidence)) {
    throw new CommandError(
      'The saved results have changed. Render the page and review the current evidence before marking it reviewed.',
      3
    );
  }
  const journal = await readJournal(root);
  journal.reviews[step] = checkpointId(current.evidence);
  await writeLocal(root, '.dogsled/onboarding/journal.json', JSON.stringify(journal));
  return journal;
}
