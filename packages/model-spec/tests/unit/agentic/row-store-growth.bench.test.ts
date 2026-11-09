import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';
import { isDuckDbAvailable } from '@bobsled-inc/connections';
import { duckDbRowDialect } from '../../../src/agentic/row-state-dialect.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { benchmarkWorkload } from '../../support/agentic-benchmark.js';
import { writeDuckDbRun } from '../../support/agentic-row-run.js';
import { countSnapshotValidations } from '../../support/snapshot-validations.js';

// The row store holds a run up to its row limit. Resuming one reads all of it, so that must cost
// in step with the run, and a checkpoint late in the largest run must cost what one costs in a
// small run. Each run is written straight to its file with all but its last assignments done, and
// a copy of that file is resumed through the default store, as the CLI would: running every
// assignment would take minutes on a CI runner. Counts come first, because they do not depend on
// the machine and name what grew. The clock then catches a pass that no count sees.
const SMALL = 1_000;
const LARGE = duckDbRowDialect.limits.maxRows;
/** Assignments each resume runs, late in the run, where its state is largest. */
const LATE = 200;
const PAYLOAD = 1000;
/** A run ten times the size may cost twice as much per assignment before this fails. */
const MAX_GROWTH = 2;

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'row-growth-'));
  directories.push(path);
  return path;
};
afterAll(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function build(assignments: number) {
  const project = directory();
  await writeDuckDbRun(benchmarkWorkload(assignments, 'map', PAYLOAD), {
    project,
    runId: 'growth',
    finished: assignments - LATE,
  });
  return { assignments, project };
}

/** Resumes a copy of a built run until its last model call, which stops it before `complete`. */
async function resume({ assignments, project }: Awaited<ReturnType<typeof build>>) {
  const copy = directory();
  cpSync(project, copy, { recursive: true });
  const workload = benchmarkWorkload(assignments, 'map', PAYLOAD);
  const calls: number[] = [];
  const counters = { validations: 0 };
  let serialized = 0;
  // What the resume did before its first model call, and what the checkpoints after it did.
  let resumed = { validations: 0, serialized: 0 };
  const execute = workload.host.executeAgent!;
  workload.host.executeAgent = (request) => {
    calls.push(performance.now());
    if (calls.length === 1) resumed = { validations: counters.validations, serialized };
    if (calls.length === LATE) return Promise.reject(new Error('Stop before completion.'));
    return execute(request);
  };
  const stringify = JSON.stringify;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const text = stringify(...args) as string | undefined;
    serialized += text?.length ?? 0;
    return text;
  }) as typeof JSON.stringify;
  const restore = countSnapshotValidations(counters);
  const started = performance.now();
  try {
    await executeAgenticRun(workload.host, workload.context(), {
      projectDirectory: copy,
      run: { id: 'growth', mode: 'resume' },
    }).catch(() => undefined);
  } finally {
    restore();
    JSON.stringify = stringify;
  }
  expect(calls).toHaveLength(LATE);
  const gaps = calls
    .slice(1)
    .map((time, index) => time - calls[index]!)
    .sort((a, b) => a - b);
  return {
    resumeMsPerAssignment: (calls[0]! - started) / assignments,
    lateCheckpointMs: gaps[Math.floor(gaps.length / 2)]!,
    resumeValidations: resumed.validations,
    resumeSerializedPerAssignment: resumed.serialized / assignments,
    lateValidations: counters.validations - resumed.validations,
    lateSerializedPerCheckpoint: (serialized - resumed.serialized) / LATE,
  };
}

describe.skipIf(!(await isDuckDbAvailable()))('the row store as a run grows to its limit', () => {
  it('resumes a run at the row limit in step with its size, and checkpoints it at a flat cost', async () => {
    const small = await build(SMALL);
    const large = await build(LARGE);
    await resume(small); // The first resume pays for compilation.
    const rounds: { resume: number; late: number }[] = [];
    // Noise only adds time, and growth shows in every round, so the best round decides.
    for (let round = 0; round < 2; round++) {
      const before = await resume(small);
      const after = await resume(large);
      // A resume reads the run a fixed number of times, and a checkpoint reads none of it.
      expect(after.resumeValidations).toBe(before.resumeValidations);
      expect(after.resumeSerializedPerAssignment).toBeLessThan(
        before.resumeSerializedPerAssignment * 1.25
      );
      expect(after.lateValidations).toBe(before.lateValidations);
      expect(after.lateSerializedPerCheckpoint).toBeLessThan(
        before.lateSerializedPerCheckpoint * 1.25
      );
      rounds.push({
        resume: after.resumeMsPerAssignment / before.resumeMsPerAssignment,
        late: after.lateCheckpointMs / before.lateCheckpointMs,
      });
      if (rounds.at(-1)!.resume <= MAX_GROWTH && rounds.at(-1)!.late <= MAX_GROWTH) break;
    }
    expect(Math.min(...rounds.map((round) => round.resume))).toBeLessThanOrEqual(MAX_GROWTH);
    expect(Math.min(...rounds.map((round) => round.late))).toBeLessThanOrEqual(MAX_GROWTH);
  }, 900_000);
});
