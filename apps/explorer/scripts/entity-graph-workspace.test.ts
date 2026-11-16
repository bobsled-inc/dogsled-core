import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveSafePathWithinRoot } from '../src/lib/entity-graph-workspace';
import { getRelativeEntityGraphDatabasePath } from '../src/lib/entity-graph-workspace-inventory';
import { spawnBobsledCommand } from '../src/lib/bobsled-cli';
import { getEntityGraphRunsLogPath, readRunLog } from '../src/lib/entity-graph-workspace';

test('resolveSafePathWithinRoot rejects writes through symlinked parent directories', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'entity-graph-workspace-'));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'entity-graph-outside-'));
  const safeDir = path.join(tempRoot, 'entity-graph');
  const linkPath = path.join(safeDir, 'link');

  await fs.mkdir(safeDir, { recursive: true });
  await fs.symlink(outsideRoot, linkPath);

  try {
    assert.throws(
      () => resolveSafePathWithinRoot(tempRoot, path.join('entity-graph', 'link', 'new.yml')),
      /Path escapes root/
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
});

test('spawnBobsledCommand rejects commands outside the allowlist', () => {
  assert.throws(() => spawnBobsledCommand('totally-not-allowed', []), /Command not allowed/);
});

test('resolveSafePathWithinRoot rejects null bytes in the subpath', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'entity_graph-workspace-nul-'));
  try {
    assert.throws(() => resolveSafePathWithinRoot(tempRoot, 'good\0/etc/passwd'), /null byte/i);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('readRunLog strips legacy workspace paths from returned entries', async () => {
  const logPath = getEntityGraphRunsLogPath();
  const original = await fs.readFile(logPath, 'utf8').catch(() => null);

  try {
    await fs.writeFile(
      logPath,
      `${JSON.stringify({
        run_id: 'run_legacy',
        entity: 'company',
        resolution_spec: 'company_resolution',
        survivorship_spec: 'company_survivorship',
        status: 'success',
        started_at: '2026-04-19T18:00:00.000Z',
        finished_at: '2026-04-19T18:05:00.000Z',
        failure_step: 'resolve:run',
        failure_code: 'step_failed',
        failure_message: 'disk full',
        workspace: '/tmp/secret/path',
      })}\n`,
      'utf8'
    );

    const runs = await readRunLog();
    assert.deepEqual(runs, [
      {
        run_id: 'run_legacy',
        scenario: 'default',
        entity: 'company',
        resolution_spec: 'company_resolution',
        survivorship_spec: 'company_survivorship',
        status: 'success',
        started_at: '2026-04-19T18:00:00.000Z',
        finished_at: '2026-04-19T18:05:00.000Z',
        failure_step: 'resolve:run',
        failure_code: 'step_failed',
        failure_message: 'disk full',
      },
    ]);
    assert.equal('workspace' in runs[0]!, false);
  } finally {
    if (original === null) {
      await fs.rm(logPath, { force: true });
    } else {
      await fs.writeFile(logPath, original, 'utf8');
    }
  }
});

test('getRelativeEntityGraphDatabasePath returns a project-relative DuckDB file path when present', async () => {
  const defaultPath = await getRelativeEntityGraphDatabasePath('default');
  if (defaultPath !== null) {
    assert.equal(path.isAbsolute(defaultPath), false);
    assert.match(defaultPath, /^workspace[\\/]entity-graph-demo[\\/][^\n]+\.(?:db|duckdb)$/i);
  }
});
