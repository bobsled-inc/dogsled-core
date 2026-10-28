import { describe, expect, it } from 'vitest';

import {
  assertLiveModeSupported,
  canonicalizeParserVersions,
  checkFreshness,
  createCacheSubstrate,
  type CacheManifestRow,
  type CacheSqlExecutor,
  type CacheSubstrate,
  type FreshnessProbe,
} from '../../src/runtime/cache-substrate.js';
import type { WarehouseClient } from '../../src/runtime/warehouse-client.js';

const baseRow: CacheManifestRow = {
  document_id: 'doc1',
  document_version_id: 'docv1',
  source_uri: 'file:test.md',
  content_hash: 'a',
  source_revision: null,
  etag: null,
  mtime: null,
  size: null,
  embedder_role: 'default_embedding_v1',
  embedder_underlying_model: 'amazon.titan-embed-text-v2:0',
  embedding_dimension: 1024,
  parser_versions: { md: 'md:1.0.0' },
  chunker_config_hash: 'cfg-a',
  document_count: 1,
  chunk_count: 4,
  parse_status: 'parsed',
  cached_at: '2026-05-06T00:00:00.000Z',
};

const baseProbe: FreshnessProbe = {
  embedderRole: baseRow.embedder_role,
  embedderUnderlyingModel: baseRow.embedder_underlying_model,
  embeddingDimension: baseRow.embedding_dimension,
  parserVersions: { md: 'md:1.0.0' },
  chunkerConfigHash: baseRow.chunker_config_hash,
};

describe('checkFreshness', () => {
  it('marks fresh when all probes match', () => {
    expect(checkFreshness(baseRow, baseProbe).fresh).toBe(true);
  });

  it('invalidates on embedder role change', () => {
    const verdict = checkFreshness(baseRow, { ...baseProbe, embedderRole: 'other_role' });
    expect(verdict).toEqual({ fresh: false, reason: 'embedder_role_changed' });
  });

  it('invalidates on embedding dimension change', () => {
    const verdict = checkFreshness(baseRow, { ...baseProbe, embeddingDimension: 768 });
    expect(verdict.reason).toBe('embedding_dimension_changed');
  });

  it('invalidates on parser version change', () => {
    const verdict = checkFreshness(baseRow, {
      ...baseProbe,
      parserVersions: { md: 'md:2.0.0' },
    });
    expect(verdict.reason).toBe('parser_version_changed');
  });

  it('invalidates when probe declares a format not in the manifest (newly-added format)', () => {
    // Regression: prior implementation only iterated manifest-side keys, so adding
    // a format to the config without invalidating the cache would silently skip
    // every document of the new format under lazy/live dispatch.
    const verdict = checkFreshness(baseRow, {
      ...baseProbe,
      parserVersions: { md: 'md:1.0.0', html: 'html:1.0.0' },
    });
    expect(verdict.reason).toBe('parser_version_changed');
  });

  it('invalidates when config removes a parser format present in the manifest', () => {
    const verdict = checkFreshness(
      { ...baseRow, parser_versions: { md: 'md:1.0.0', html: 'html:1.0.0' } },
      baseProbe
    );
    expect(verdict.reason).toBe('parser_version_changed');
  });

  it('invalidates on chunker config hash change', () => {
    const verdict = checkFreshness(baseRow, { ...baseProbe, chunkerConfigHash: 'cfg-b' });
    expect(verdict.reason).toBe('chunker_config_changed');
  });
});

describe('assertLiveModeSupported', () => {
  function fake(level: CacheSubstrate['atomicityLevel']): CacheSubstrate {
    return {
      kind: 'duckdb',
      atomicityLevel: level,
      ftsCapability: 'extension_required',
      vectorCapability: 'native',
      beginCacheWrite: async () => ({ resource: 'r', inner: null }),
      commitCacheWrite: async () => {},
      abortCacheWrite: async () => {},
      readManifest: async () => [],
      writeManifestRow: async () => {},
    };
  }

  it('passes silently for transactional substrates', () => {
    expect(assertLiveModeSupported(fake('transaction'))).toEqual({});
  });

  it('returns a warn for idempotent_writes substrates', () => {
    const result = assertLiveModeSupported(fake('idempotent_writes'));
    expect(result.warn).toBeTruthy();
  });

  it('throws for lww substrates', () => {
    expect(() => assertLiveModeSupported(fake('lww'))).toThrow(/LIVE_MODE_UNSUPPORTED_SUBSTRATE/);
  });
});

describe('canonicalizeParserVersions', () => {
  it('order-insensitive', () => {
    const a = canonicalizeParserVersions({ md: 'md:1.0.0', pdf: 'pdf:1.0.0' });
    const b = canonicalizeParserVersions({ pdf: 'pdf:1.0.0', md: 'md:1.0.0' });
    expect(a).toBe(b);
  });

  it('changes when a version changes', () => {
    const a = canonicalizeParserVersions({ md: 'md:1.0.0' });
    const b = canonicalizeParserVersions({ md: 'md:2.0.0' });
    expect(a).not.toBe(b);
  });
});

describe('DuckDB in-memory cache substrate', () => {
  it('round-trips a manifest write', async () => {
    const substrate = createCacheSubstrate('duckdb');
    const handle = await substrate.beginCacheWrite('docs');
    await substrate.writeManifestRow(handle, baseRow);
    await substrate.commitCacheWrite(handle);
    const rows = await substrate.readManifest('docs');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.document_id).toBe('doc1');

    rows.push({ ...baseRow, document_id: 'mutated-array' });
    rows[0]!.parser_versions.md = 'mutated-version';
    const reread = await substrate.readManifest('docs');
    expect(reread).toHaveLength(1);
    expect(reread[0]?.document_id).toBe('doc1');
    expect(reread[0]?.parser_versions.md).toBe('md:1.0.0');
  });

  it('readManifest returns a defensive snapshot — caller mutations do not leak back', async () => {
    const substrate = createCacheSubstrate('duckdb');
    const handle = await substrate.beginCacheWrite('docs');
    await substrate.writeManifestRow(handle, baseRow);
    await substrate.commitCacheWrite(handle);
    const firstRead = await substrate.readManifest('docs');
    // Mutate the returned array + the row's nested object — neither should affect
    // persisted state. Without defensive copies, the second read would surface the
    // tampering.
    firstRead.push({ ...baseRow, document_id: 'forged' });
    if (firstRead[0]) {
      firstRead[0].document_id = 'mutated';
      firstRead[0].parser_versions['md'] = 'forged:99';
    }
    const secondRead = await substrate.readManifest('docs');
    expect(secondRead).toHaveLength(1);
    expect(secondRead[0]?.document_id).toBe('doc1');
    expect(secondRead[0]?.parser_versions['md']).toBe('md:1.0.0');
  });

  it('aborts cleanly without committing', async () => {
    const substrate = createCacheSubstrate('duckdb');
    const handle = await substrate.beginCacheWrite('docs');
    await substrate.writeManifestRow(handle, baseRow);
    await substrate.abortCacheWrite(handle);
    const rows = await substrate.readManifest('docs');
    expect(rows).toHaveLength(0);
  });

  it('rejects parallel writes to the same resource', async () => {
    const substrate = createCacheSubstrate('duckdb');
    await substrate.beginCacheWrite('docs');
    await expect(substrate.beginCacheWrite('docs')).rejects.toThrow(/already in flight/);
  });

  it('exposes the contract capabilities', () => {
    const substrate = createCacheSubstrate('duckdb');
    expect(substrate.kind).toBe('duckdb');
    expect(substrate.atomicityLevel).toBe('transaction');
    expect(substrate.vectorCapability).toBe('native');
  });

  it('registers DuckLake as the local-default alias with DuckDB capabilities', () => {
    const substrate = createCacheSubstrate('ducklake');
    expect(substrate.kind).toBe('ducklake');
    expect(substrate.atomicityLevel).toBe('transaction');
    expect(substrate.ftsCapability).toBe('extension_required');
    expect(substrate.vectorCapability).toBe('native');
  });
});

class RecordingExecutor implements CacheSqlExecutor {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = [];
  rows: Record<string, unknown>[] = [];

  async query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    this.calls.push({ sql, params });
    if (/^\s*SELECT\b/i.test(sql)) {
      return this.rows;
    }
    return [];
  }

  sqlLog(): string {
    return this.calls.map((call) => call.sql).join('\n');
  }
}

class FailingMergeExecutor extends RecordingExecutor {
  override async query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    this.calls.push({ sql, params });
    if (/^\s*MERGE\b/i.test(sql)) {
      throw new Error('merge failed');
    }
    if (/^\s*SELECT\b/i.test(sql)) {
      return this.rows;
    }
    return [];
  }
}

function fakeWarehouseClient(dialect: WarehouseClient['dialect']): WarehouseClient {
  return {
    dialect,
    execute: async function* (): AsyncGenerator<Record<string, unknown>[]> {
      yield [];
    },
    testConnection: async () => ({ success: true }),
    introspect: async () => [],
    close: async () => {},
  };
}

describe('SQL cache substrates', () => {
  it('requires an executor for non-DuckDB substrates', () => {
    expect(() => createCacheSubstrate('postgres')).toThrow(/requires an executor/);
  });

  it('rejects generic WarehouseClient executors for transactional substrates', () => {
    expect(() =>
      createCacheSubstrate('postgres', { executor: fakeWarehouseClient('postgres') })
    ).toThrow(/session-scoped transaction semantics/);
    expect(() =>
      createCacheSubstrate('snowflake', { executor: fakeWarehouseClient('snowflake') })
    ).toThrow(/session-scoped transaction semantics/);

    expect(
      createCacheSubstrate('bigquery', { executor: fakeWarehouseClient('bigquery') }).kind
    ).toBe('bigquery');
  });

  it('exposes Postgres capabilities and writes manifest rows transactionally', async () => {
    const executor = new RecordingExecutor();
    const substrate = createCacheSubstrate('postgres', { executor, schema: 'lazy_cache' });

    expect(substrate.atomicityLevel).toBe('transaction');
    expect(substrate.ftsCapability).toBe('native_index');
    expect(substrate.vectorCapability).toBe('native');

    const handle = await substrate.beginCacheWrite('docs');
    await substrate.writeManifestRow(handle, baseRow);
    await substrate.commitCacheWrite(handle);

    const log = executor.sqlLog();
    expect(log).toContain('CREATE SCHEMA IF NOT EXISTS "lazy_cache"');
    expect(log).toContain('CREATE TABLE IF NOT EXISTS "lazy_cache"."docs__cache_manifest"');
    expect(log).toContain('BEGIN');
    expect(log).toContain('DELETE FROM "lazy_cache"."docs__cache_manifest"');
    expect(log).toContain('CAST($12 AS JSONB)');
    expect(log).toContain('COMMIT');
  });

  it('rejects overlapping transactional writes across resources', async () => {
    const executor = new RecordingExecutor();
    const substrate = createCacheSubstrate('postgres', { executor });

    const handle = await substrate.beginCacheWrite('docs');
    await expect(substrate.beginCacheWrite('other_docs')).rejects.toThrow(
      /transactional write is already in flight/
    );
    await substrate.abortCacheWrite(handle);
  });

  it('exposes Snowflake capabilities and uses VARIANT parser-version storage', async () => {
    const executor = new RecordingExecutor();
    const substrate = createCacheSubstrate('snowflake', { executor });

    expect(substrate.atomicityLevel).toBe('transaction');
    expect(substrate.ftsCapability).toBe('full_scan_only');
    expect(substrate.vectorCapability).toBe('array_only');

    const handle = await substrate.beginCacheWrite('docs');
    await substrate.writeManifestRow(handle, baseRow);
    await substrate.abortCacheWrite(handle);

    const log = executor.sqlLog();
    expect(log).toContain('"parser_versions" VARIANT NOT NULL');
    expect(log).toContain('PARSE_JSON(:12)');
    expect(log).toContain('ROLLBACK');
  });

  it('exposes BigQuery capabilities and commits through a staging MERGE', async () => {
    const executor = new RecordingExecutor();
    const substrate = createCacheSubstrate('bigquery', { executor });

    expect(substrate.atomicityLevel).toBe('idempotent_writes');
    expect(substrate.ftsCapability).toBe('native_index');
    expect(substrate.vectorCapability).toBe('array_only');

    const handle = await substrate.beginCacheWrite('docs');
    await substrate.writeManifestRow(handle, baseRow);
    await substrate.commitCacheWrite(handle);

    const log = executor.sqlLog();
    expect(log).toContain('CREATE TABLE `lazy_cache`.`docs__cache_manifest__staging_');
    expect(log).toContain('MERGE `lazy_cache`.`docs__cache_manifest` AS T');
    expect(log).toContain('WHEN MATCHED THEN UPDATE SET `document_id` = S.`document_id`');
    expect(log).not.toContain('UPDATE SET T.`document_id`');
    expect(log).toContain('DROP TABLE IF EXISTS `lazy_cache`.`docs__cache_manifest__staging_');
    expect(log).not.toContain('BEGIN');
  });

  it('drops the BigQuery staging table when MERGE fails', async () => {
    const executor = new FailingMergeExecutor();
    const substrate = createCacheSubstrate('bigquery', { executor });

    const handle = await substrate.beginCacheWrite('docs');
    await substrate.writeManifestRow(handle, baseRow);
    await expect(substrate.commitCacheWrite(handle)).rejects.toThrow('merge failed');

    expect(executor.sqlLog()).toContain(
      'DROP TABLE IF EXISTS `lazy_cache`.`docs__cache_manifest__staging_'
    );
  });

  it('maps SQL manifest rows back to typed cache rows', async () => {
    const executor = new RecordingExecutor();
    executor.rows = [{ ...baseRow, parser_versions: JSON.stringify(baseRow.parser_versions) }];
    const substrate = createCacheSubstrate('postgres', { executor });

    const rows = await substrate.readManifest('docs');
    expect(rows).toEqual([baseRow]);
  });
});
