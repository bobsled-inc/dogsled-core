import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  pruneStaleCaptureDirs,
  updateManifestDestination,
  validateDestinationCapabilities,
  validateResourceTableTargets,
} from '../../../src/commands/pipeline-fanout.js';
import { createManifest } from '../../../src/runner/manifest.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('validateDestinationCapabilities', () => {
  it('allows merge for supported database destinations', () => {
    expect(() =>
      validateDestinationCapabilities(
        [
          { name: 'duck', type: 'duckdb', db_path: './demo.duckdb' },
          { name: 'bq', type: 'bigquery', project: 'p', dataset: 'd' },
          {
            name: 'sf',
            type: 'snowflake',
            account: 'acme',
            username: 'loader',
            warehouse: 'wh',
            database: 'db',
          },
          {
            name: 'pg',
            type: 'postgres',
            host: 'db.example.com',
            database: 'warehouse',
            username: 'loader',
          },
          {
            name: 'mysql',
            type: 'mysql',
            host: 'mysql.example.com',
            database: 'warehouse',
            user: 'loader',
          },
          {
            name: 'clickhouse',
            type: 'clickhouse',
            host: 'ch.example.com',
            database: 'warehouse',
          },
          {
            name: 'turbopuffer',
            type: 'turbopuffer',
            api_key: '$TURBOPUFFER_API_KEY',
          },
        ],
        'merge'
      )
    ).not.toThrow();
  });

  it('rejects merge for file destinations with a validation exit code', () => {
    try {
      validateDestinationCapabilities([{ name: 'archive', type: 'local', format: 'csv' }], 'merge');
      throw new Error('expected validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).exitCode).toBe(EXIT_VALIDATION);
      expect((error as Error).message).toContain('does not support merge strategy');
    }
  });

  it('prefers the pipeline strategy over the destination strategy', () => {
    expect(() =>
      validateDestinationCapabilities(
        [{ name: 'archive', type: 'local', format: 'csv', load_strategy: 'append' }],
        'merge'
      )
    ).toThrow(/does not support merge strategy/);
  });

  it('skips validation when no strategy is configured', () => {
    expect(() =>
      validateDestinationCapabilities([
        { name: 'archive', type: 's3', bucket: 'raw', format: 'jsonl' },
      ])
    ).not.toThrow();
  });

  it('allows append and full_refresh for file destinations', () => {
    expect(() =>
      validateDestinationCapabilities(
        [
          { name: 'local', type: 'local', format: 'csv', load_strategy: 'append' },
          {
            name: 'gcs',
            type: 'gcs',
            bucket: 'raw',
            format: 'jsonl',
            load_strategy: 'full_refresh',
          },
          { name: 's3', type: 's3', bucket: 'raw', format: 'parquet', load_strategy: 'append' },
        ],
        'append'
      )
    ).not.toThrow();
  });

  it('rejects per-resource database overrides for file destinations', () => {
    expect(() =>
      validateDestinationCapabilities([{ name: 'archive', type: 'local' }], undefined, {
        issues: 'append',
      })
    ).toThrow(/does not support per-resource load_strategy overrides/);
    expect(() =>
      validateDestinationCapabilities([{ name: 'archive', type: 's3' }], undefined, undefined, {
        issues: 'raw_issues',
      })
    ).toThrow(/does not support per-resource table overrides/);
  });

  it('allows append/full-refresh strategy and table overrides on non-merge databases', () => {
    expect(() =>
      validateDestinationCapabilities(
        [{ name: 'sqlite', type: 'sqlite' }],
        undefined,
        { issues: 'append', teams: 'full_refresh' },
        { issues: 'raw_issues' }
      )
    ).not.toThrow();
  });

  it('still rejects merge overrides on non-merge databases', () => {
    expect(() =>
      validateDestinationCapabilities([{ name: 'sqlite', type: 'sqlite' }], undefined, {
        issues: 'merge',
      })
    ).toThrow(/does not support merge strategy/);
  });

  it('rejects two resources that resolve to the same final table', () => {
    expect(() =>
      validateResourceTableTargets(
        [{ name: 'warehouse', type: 'duckdb', table_prefix: 'github__' }],
        ['issues', 'github__issues'],
        undefined,
        { issues: 'github__github__issues' }
      )
    ).toThrow(/maps resources "issues" and "github__issues" to the same table/);
  });
});

describe('pruneStaleCaptureDirs', () => {
  it('removes only stale completed capture dirs and keeps active or unrelated entries', () => {
    const tempDir = makeTempDir('dogsled-capture-prune-test-');
    const staleDir = path.join(tempDir, 'dogsled-capture-stale');
    const freshDir = path.join(tempDir, 'dogsled-capture-fresh');
    const activeDir = path.join(tempDir, 'dogsled-capture-active');
    const captureFile = path.join(tempDir, 'dogsled-capture-file');
    const unrelatedDir = path.join(tempDir, 'keep-me');

    fs.mkdirSync(staleDir);
    fs.mkdirSync(freshDir);
    fs.mkdirSync(activeDir);
    fs.mkdirSync(unrelatedDir);
    fs.writeFileSync(captureFile, 'not a directory');
    fs.writeFileSync(
      path.join(staleDir, 'manifest.json'),
      JSON.stringify({ completed_at: '2026-04-07T00:00:00.000Z' })
    );
    fs.writeFileSync(path.join(freshDir, 'manifest.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(activeDir, 'manifest.json'), JSON.stringify({}));

    const staleDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(staleDir, staleDate, staleDate);
    fs.utimesSync(activeDir, staleDate, staleDate);
    fs.utimesSync(captureFile, staleDate, staleDate);

    pruneStaleCaptureDirs(tempDir, 24 * 60 * 60 * 1000);

    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(freshDir)).toBe(true);
    expect(fs.existsSync(activeDir)).toBe(true);
    expect(fs.existsSync(captureFile)).toBe(true);
    expect(fs.existsSync(unrelatedDir)).toBe(true);
  });
});

describe('updateManifestDestination', () => {
  it('marks destinations as killed only when an actual signal is present', () => {
    const summary = {
      streams: new Map([['repos', { records_emitted: 1, rows_loaded: 1 }]]),
    };

    const killedManifest = createManifest('github', '/tmp/dogsled-capture/output.jsonl', [
      { name: 'warehouse', type: 'local', format: 'csv' },
    ]);
    updateManifestDestination(killedManifest, 'warehouse', 143, summary, undefined, 'SIGTERM');
    expect(killedManifest.destinations[0]).toMatchObject({
      name: 'warehouse',
      status: 'killed',
      exit_code: 143,
      rows_loaded: { repos: 1 },
    });

    const failedManifest = createManifest('github', '/tmp/dogsled-capture/output.jsonl', [
      { name: 'warehouse', type: 'local', format: 'csv' },
    ]);
    updateManifestDestination(failedManifest, 'warehouse', 143, summary);
    expect(failedManifest.destinations[0]).toMatchObject({
      name: 'warehouse',
      status: 'failed',
      exit_code: 143,
      rows_loaded: { repos: 1 },
    });
  });
});
