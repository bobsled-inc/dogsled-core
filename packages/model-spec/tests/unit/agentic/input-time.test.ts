import { expect, it } from 'vitest';
import { executeAgenticRun } from '../../../src/agentic/index.js';
import { MemoryStateStore, runFixture } from './state-fixture.js';

it('saves the host input time and preserves it on resume', async () => {
  const f = runFixture(1);
  const store = new MemoryStateStore();
  const options = { projectDirectory: '.', stateStore: store };
  const before = Date.now();
  await executeAgenticRun(f.host, f.context(), { ...options, run: { id: 'time', mode: 'start' } });
  const first = [...store.runs.values()][0]!.work[0]!.assignment.input.retrieved_at!;
  expect(Date.parse(first)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(first)).toBeLessThanOrEqual(Date.now());
  f.host.prepare = async () => {
    throw new Error('Resume must reuse the saved input');
  };
  f.host.executeAgent = async () => {
    throw new Error('Resume must reuse accepted work');
  };
  const resumed = await executeAgenticRun(f.host, f.context(), {
    ...options,
    run: { id: 'time', mode: 'resume' },
  });
  expect(resumed.reusedCompletion).toBe(true);
  expect([...store.runs.values()][0]!.work[0]!.assignment.input.retrieved_at).toBe(first);
});
