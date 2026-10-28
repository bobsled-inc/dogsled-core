import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getResourcePath, listResourceFiles, readYamlFile } from '../src/loader.js';
import { buildCatalogManifestFromYaml } from '../src/catalog/yaml-walker.js';

const testsDir = dirname(fileURLToPath(import.meta.url));
const CATALOG_WALK_TIMEOUT_MS = 30_000;

describe('vercel integration', () => {
  it('publishes the bounded usage and cost resource surface', () => {
    expect(listResourceFiles('vercel')).toEqual([
      'billing_charges',
      'contract_commitments',
      'deployment_details',
      'deployments',
      'metric_catalog',
      'metric_query',
      'metric_schema',
      'projects',
      'sandbox_session_details',
      'sandbox_sessions',
      'sandboxes',
    ]);
  });

  it(
    'appears in the generated catalog walker',
    () => {
      const source = buildCatalogManifestFromYaml().sources.find(
        (entry) => entry.name === 'vercel'
      );
      expect(source).toBeDefined();
      expect(source?.resource_count).toBe(11);
    },
    CATALOG_WALK_TIMEOUT_MS
  );

  it('marks FOCUS resources as JSONL and keys them by snapshot and ordinal', () => {
    for (const resourceName of ['billing_charges', 'contract_commitments']) {
      const resource = readYamlFile(getResourcePath('vercel', resourceName)) as {
        api: { response_format?: string };
        output: Record<string, { path?: string }>;
        extract: { table: { primary_key: string[] } };
      };

      expect(resource.api.response_format).toBe('jsonl');
      expect(resource.output.snapshot_id.path).toBe('$.__input__.snapshot_id');
      expect(resource.output.record_ordinal.path).toBe('$.__input__.__record_ordinal__');
      expect(resource.extract.table.primary_key).toEqual(['snapshot_id', 'record_ordinal']);
    }
  });

  it('maps sandbox session detail fields from the documented response envelope', () => {
    const resource = readYamlFile(getResourcePath('vercel', 'sandbox_session_details')) as {
      output: Record<string, { path?: string }>;
      extract: {
        for_each?: {
          bindings?: Array<{ field: string; input: string }>;
        };
      };
    };

    expect(resource.output.id.path).toBe('$.session.id');
    expect(resource.output.active_cpu_duration_ms.path).toBe('$.session.activeCpuDurationMs');
    expect(resource.output.runtime.path).toBe('$.session.runtime');
    expect(resource.output.cwd.path).toBe('$.session.cwd');
    expect(resource.output.snapshotted_at.path).toBe('$.session.snapshottedAt');
    expect(resource.output.routes.path).toBe('$.routes');
    expect(resource.extract.for_each?.bindings).toEqual(
      expect.arrayContaining([
        { field: 'id', input: 'session_id' },
        { field: 'team_id', input: 'team_id' },
        { field: 'team_slug', input: 'team_slug' },
      ])
    );
  });

  it('preserves documented sandbox configuration fields', () => {
    const resource = readYamlFile(getResourcePath('vercel', 'sandboxes')) as {
      output: Record<string, { path?: string; type?: string; unit?: string }>;
    };

    expect(resource.output.snapshot_expiration.path).toBe('$.snapshotExpiration');
    expect(resource.output.keep_last_snapshots.path).toBe('$.keepLastSnapshots');
    expect(resource.output.network_id.path).toBe('$.networkId');
    expect(resource.output.cwd.path).toBe('$.cwd');
    expect(resource.output.mounts.path).toBe('$.mounts');
    expect(resource.output.mounts.type).toBe('object');
    expect(resource.output.timeout.unit).toBe('milliseconds');
  });

  it('preserves team scope through deployment detail lookups', () => {
    const resource = readYamlFile(getResourcePath('vercel', 'deployment_details')) as {
      extract: {
        for_each?: {
          bindings?: Array<{ field: string; input: string }>;
        };
      };
    };

    expect(resource.extract.for_each?.bindings).toEqual(
      expect.arrayContaining([
        { field: 'uid', input: 'id_or_url' },
        { field: 'team_id', input: 'team_id' },
        { field: 'team_slug', input: 'team_slug' },
      ])
    );
  });

  it('keeps duplicate-looking billing lines in the fixture', () => {
    const fixturePath = join(testsDir, 'fixtures', 'vercel', 'billing_charges.jsonl');
    const records = readFileSync(fixturePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { ChargeCategory: string });

    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.ChargeCategory)).size).toBe(2);
  });
});
