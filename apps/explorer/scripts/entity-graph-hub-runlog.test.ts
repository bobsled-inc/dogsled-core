import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { buildRunStatusText, buildResolveStats } from '../src/app/entity-graph/runlog-view-model';

const NOW = new Date('2026-01-01T01:00:00.000Z').getTime();

test('buildRunStatusText returns error message when runLogError is true', () => {
  assert.equal(
    buildRunStatusText(true, null),
    'Run log unavailable — check workspace/entity-graph-demo/ is accessible.'
  );
});

test('buildRunStatusText returns no-run message when lastRun is null', () => {
  assert.equal(
    buildRunStatusText(false, null),
    'No pipeline runs yet — design a spec and run the pipeline from Resolve.'
  );
});

test('buildRunStatusText returns formatted relative time when lastRun is present', () => {
  mock.method(Date, 'now', () => NOW);
  try {
    const lastRun = { finished_at: new Date(NOW - 5 * 60_000).toISOString() };
    assert.equal(buildRunStatusText(false, lastRun), 'Last run: 5m ago');
  } finally {
    mock.restoreAll();
  }
});

test('buildRunStatusText prefers error over lastRun', () => {
  const lastRun = { finished_at: '2026-01-01T00:55:00.000Z' };
  assert.equal(
    buildRunStatusText(true, lastRun),
    'Run log unavailable — check workspace/entity-graph-demo/ is accessible.'
  );
});

test('buildResolveStats returns empty array when lastRun is null', () => {
  assert.deepEqual(buildResolveStats({ clusters: 12, queue: 3 }, null), []);
});

test('buildResolveStats returns empty array when stats is null', () => {
  assert.deepEqual(buildResolveStats(null, { finished_at: '2026-01-01T00:55:00.000Z' }), []);
});

test('buildResolveStats returns full payload when both are present', () => {
  const stats = { clusters: 12, queue: 3 };
  const lastRun = { finished_at: '2026-01-01T00:55:00.000Z' };
  assert.deepEqual(buildResolveStats(stats, lastRun), [
    { label: 'Clusters', value: '12' },
    { label: 'Pending review', value: '3' },
    { label: 'Schema', value: 'entity_graph_demo' },
  ]);
});
