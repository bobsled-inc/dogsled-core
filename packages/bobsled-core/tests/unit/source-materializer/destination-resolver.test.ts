import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveDestinationFor } from '../../../src/runtime/source-materializer/destination-resolver.js';

const baseEntry = {
  kind: 'api_resource' as const,
  fqRef: 'sources.issues',
  integration: 'github',
  resource: 'issues',
  connection: 'github_prod',
  columns: [{ name: 'id', type: 'integer' as const }],
};

async function withConfig(text: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dr-'));
  await mkdir(join(root, '.dogsled'), { recursive: true });
  await writeFile(join(root, '.dogsled', 'config.yml'), text, 'utf8');
  return root;
}

describe('resolveDestinationFor', () => {
  it('mode: live returns in-memory DuckDB regardless of project default', async () => {
    const root = await withConfig(`default_destination:\n  dest: bigquery\n  datasetId: d\n`);
    const resolved = await resolveDestinationFor({
      entry: { ...baseEntry, mode: 'live' },
      projectRoot: root,
    });
    expect(resolved.kind).toBe('in_memory');
    expect(resolved.schema).toBe('sources');
    expect(resolved.sqlRunnerKind).toBe('duckdb');
  });

  it('defaults to DuckLake fallback when no config exists', async () => {
    const resolved = await resolveDestinationFor({
      entry: baseEntry,
      projectRoot: await mkdtemp(join(tmpdir(), 'dr-')),
    });
    expect(resolved.kind).toBe('ducklake');
    expect(resolved.schema).toBe('sources');
  });

  it('routes to BigQuery when default_destination.dest=bigquery', async () => {
    const root = await withConfig(
      `default_destination:\n  dest: bigquery\n  project: my-proj\n  dataset: analytics\n`
    );
    const resolved = await resolveDestinationFor({ entry: baseEntry, projectRoot: root });
    expect(resolved.kind).toBe('bigquery');
    expect(resolved.schema).toBe('analytics');
    expect(resolved.config.dest).toBe('bigquery');
    if (resolved.config.dest === 'bigquery') {
      expect(resolved.config.projectId).toBe('my-proj');
      expect(resolved.config.datasetId).toBe('analytics');
    }
  });

  it('routes to Snowflake when default_destination.dest=snowflake', async () => {
    const root = await withConfig(
      `default_destination:\n  dest: snowflake\n  account: abc\n  username: u\n  database: DB\n  schema: ANALYTICS\n  warehouse: WH\n`
    );
    const resolved = await resolveDestinationFor({ entry: baseEntry, projectRoot: root });
    expect(resolved.kind).toBe('snowflake');
    expect(resolved.schema).toBe('ANALYTICS');
  });

  it('honors per-source schema override', async () => {
    const root = await withConfig(`default_destination:\n  dest: bigquery\n  dataset: shared\n`);
    const resolved = await resolveDestinationFor({
      entry: { ...baseEntry, destination: { schema: 'sources_raw' } },
      projectRoot: root,
    });
    expect(resolved.schema).toBe('sources_raw');
  });

  it('errors with CommandError on unknown destinations', async () => {
    const root = await withConfig(`default_destination:\n  dest: martian-warehouse\n`);
    await expect(resolveDestinationFor({ entry: baseEntry, projectRoot: root })).rejects.toThrow(
      /unknown/i
    );
  });

  it('sanitizes source name to an identifier for the table name', async () => {
    const resolved = await resolveDestinationFor({
      entry: { ...baseEntry, fqRef: 'sources.Weird-Name' },
      projectRoot: await mkdtemp(join(tmpdir(), 'dr-')),
    });
    expect(resolved.table).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });
});
