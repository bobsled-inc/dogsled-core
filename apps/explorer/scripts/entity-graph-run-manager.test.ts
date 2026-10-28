import assert from 'node:assert/strict';
import test from 'node:test';

import { POST as startRun } from '../src/app/api/entity-graph/run/route';
import {
  cancelEntityGraphRun,
  claimEntityGraphRun,
  getActiveEntityGraphRunId,
  releaseEntityGraphRun,
  resetEntityGraphRunManagerForTests,
} from '../src/lib/entity-graph-run-manager';

test('claimEntityGraphRun prevents overlapping runs until release', (t) => {
  resetEntityGraphRunManagerForTests();
  t.after(() => resetEntityGraphRunManagerForTests());

  assert.equal(
    claimEntityGraphRun('run_a', () => undefined),
    true
  );
  assert.equal(
    claimEntityGraphRun('run_b', () => undefined),
    false
  );
  assert.equal(getActiveEntityGraphRunId(), 'run_a');

  releaseEntityGraphRun('run_a');

  assert.equal(
    claimEntityGraphRun('run_b', () => undefined),
    true
  );

  releaseEntityGraphRun('run_b');
});

test('cancelEntityGraphRun invokes the active run cancellation callback', (t) => {
  resetEntityGraphRunManagerForTests();
  t.after(() => resetEntityGraphRunManagerForTests());
  let cancelled = 0;

  assert.equal(
    claimEntityGraphRun('run_cancel', () => {
      cancelled += 1;
    }),
    true
  );

  assert.equal(cancelEntityGraphRun('run_cancel'), true);
  assert.equal(cancelled, 1);
  assert.equal(cancelEntityGraphRun('other_run'), false);

  releaseEntityGraphRun('run_cancel');
});

test('Entity Graph run route rejects overlapping runs while one is active', async () => {
  resetEntityGraphRunManagerForTests();
  assert.equal(
    claimEntityGraphRun('run_existing', () => undefined),
    true
  );

  try {
    const response = await startRun(
      new Request('http://localhost/api/entity-graph/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    const payload = (await response.json()) as { error?: string; runId?: string | null };

    assert.equal(response.status, 409);
    assert.equal(
      payload.error,
      'Entity Graph run already in progress. Wait for the current run to finish and retry.'
    );
    assert.equal(payload.runId, 'run_existing');
  } finally {
    releaseEntityGraphRun('run_existing');
    resetEntityGraphRunManagerForTests();
  }
});
