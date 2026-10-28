/**
 * DuckDB end-to-end resolution execution test (in-process warehouse).
 *
 * Unlike the string-assertion unit tests, this EXECUTES the full resolution
 * pipeline against a real in-process DuckDB instance via `runResolveProject`,
 * then asserts on the materialized warehouse state. It exercises the asymmetric
 * two-input repro: `accounts_a` has `slug` (no `domain`), `accounts_b` has
 * `domain` (no `slug`), so the standardize UNION ALL must NULL-pad both ways
 * and still execute. DuckDB's native `jaro_winkler_similarity` runs for real,
 * so the scoring stage produces actual pair scores.
 *
 * The whole test is skipped when `@duckdb/node-api` (the native binding used by
 * the connections DuckDB runner) cannot be imported, mirroring the warehouse
 * harness pattern in @bobsled-inc/model-spec.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  resolveRunner,
  type IntegrationFile,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import { buildSourceRegistry, executeSqlStatements } from '@bobsled-inc/model-spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyReviewDecisions,
  clusterResolveProject,
  runResolveProject,
} from '../../src/api/index.js';
import { buildAuditVerifyQuery, generateAuditLogDdl } from '../../src/compiler/audit/codegen.js';
import type { AgentDecisionBundleV1 } from '../../src/compiler/agent/types.js';
import {
  buildForgetRecordRequest,
  generateForgetSql,
} from '../../src/compiler/identity/codegen-forget.js';
import {
  compileResolutionCluster,
  compileResolutionProfile,
} from '../../src/compiler/identity/codegen.js';
import { generateMaterializeDdl } from '../../src/compiler/identity/materializer.js';
import {
  discoverResolutionSpecs,
  resolveResolutionSpec,
} from '../../src/compiler/identity/parser.js';
import {
  writeAsymmetricFixture,
  writeAddressFixture,
  writeIncrementalFixture,
  writeNoColumnsFixture,
  ADDRESS_CANDIDATE_PAIRS_TABLE,
  ADDRESS_PAIR_SCORES_TABLE,
  INCREMENTAL_STANDARDIZED_DELTA_TABLE,
  INTEGRATION_HANDLE,
  NO_COL_INTEGRATION_HANDLE,
  PAIR_SCORES_TABLE,
  RESOLUTION_TARGET_SCHEMA,
  SOURCE_A_REF,
  SOURCE_B_REF,
  STANDARDIZED_TABLE,
} from './asymmetric-fixture.js';

const requireFromHere = createRequire(import.meta.url);

function duckdbAvailable(): boolean {
  try {
    const connectionsEntry = requireFromHere.resolve('@bobsled-inc/connections');
    requireFromHere.resolve('@duckdb/node-api', { paths: [dirname(connectionsEntry)] });
    return true;
  } catch {
    return false;
  }
}

const DUCKDB_AVAILABLE = duckdbAvailable();

function duckdbIntegration(dbPath: string): IntegrationFile {
  return {
    spec_version: '1',
    type: 'integration',
    name: INTEGRATION_HANDLE,
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: dbPath },
  };
}

function num(value: unknown): number {
  // DuckDB COUNT(*) comes back as a BigInt; normalize before comparing.
  return Number(value);
}

async function scalarCount(runner: SqlRunnerModule, sql: string): Promise<number> {
  if (!runner.query) {
    throw new Error('DuckDB runner does not expose query()');
  }
  const rows = await runner.query(sql);
  const first = rows[0];
  if (!first) {
    throw new Error(`query returned no rows: ${sql}`);
  }
  const value = first.c ?? first.C ?? Object.values(first)[0];
  if (value === undefined) {
    throw new Error(`query returned row with no recognizable count column: ${sql}`);
  }
  return num(value);
}

function resolvedAsymmetricSpec(dir: string) {
  const sourceResult = buildSourceRegistry(join(dir, 'sources'));
  if (!sourceResult.ok) {
    throw new Error(sourceResult.error);
  }
  const parsed = discoverResolutionSpecs(join(dir, 'entity-graph'))[0];
  if (!parsed) {
    throw new Error('expected fixture resolution spec');
  }
  return resolveResolutionSpec(
    parsed,
    sourceResult.registry,
    'duckdb',
    RESOLUTION_TARGET_SCHEMA,
    sourceResult.columnRegistry
  );
}

async function seedIncrementalBase(runner: SqlRunnerModule): Promise<void> {
  await runner.run(`CREATE SCHEMA IF NOT EXISTS ${RESOLUTION_TARGET_SCHEMA}`);
  await runner.run(
    `CREATE TABLE main.accounts_a (account_id VARCHAR, name VARCHAR, loaded_at TIMESTAMP)`
  );
  await runner.run(
    `CREATE TABLE main.accounts_b (pylon_id VARCHAR, name VARCHAR, loaded_at TIMESTAMP)`
  );
  await runner.run(
    `INSERT INTO main.accounts_a VALUES
      ('a1', 'Acme Corp', TIMESTAMP '2026-01-01 00:00:00'),
      ('a2', 'Globex', TIMESTAMP '2026-01-01 00:00:00')`
  );
  await runner.run(
    `INSERT INTO main.accounts_b VALUES
      ('b1', 'acme corp', TIMESTAMP '2026-01-01 00:00:00'),
      ('b2', 'Initech', TIMESTAMP '2026-01-01 00:00:00')`
  );
}

async function applyIncrementalChanges(runner: SqlRunnerModule): Promise<void> {
  await runner.run(
    `UPDATE main.accounts_a
     SET name = 'Globex Corp', loaded_at = TIMESTAMP '2026-01-03 00:00:00'
     WHERE account_id = 'a2'`
  );
  await runner.run(
    `INSERT INTO main.accounts_b VALUES
      ('b3', 'globex corp', TIMESTAMP '2026-01-01 00:00:00')`
  );
}

async function seedIncrementalFinal(runner: SqlRunnerModule): Promise<void> {
  await seedIncrementalBase(runner);
  await applyIncrementalChanges(runner);
}

async function snapshotResolutionTables(runner: SqlRunnerModule): Promise<{
  partitions: string[];
  crosswalks: string[];
  golden: string[];
}> {
  if (!runner.query) {
    throw new Error('DuckDB runner does not expose query()');
  }
  const clusters = await runner.query(
    `SELECT entity_id, record_id FROM ${RESOLUTION_TARGET_SCHEMA}.account__clusters`
  );
  const byEntity = new Map<string, string[]>();
  for (const row of clusters) {
    const entityId = String(row.entity_id);
    const recordId = String(row.record_id);
    byEntity.set(entityId, [...(byEntity.get(entityId) ?? []), recordId].sort());
  }
  const partitions = [...byEntity.values()].map((records) => records.join('|')).sort();
  const crosswalkRows = await runner.query(
    `SELECT source_ref, source_entity_id, record_id
     FROM ${RESOLUTION_TARGET_SCHEMA}.account__crosswalks
     ORDER BY source_ref, source_entity_id, record_id`
  );
  const goldenRows = await runner.query(
    `SELECT attribute_name, attribute_value, source_system
     FROM ${RESOLUTION_TARGET_SCHEMA}.account__golden_record
     ORDER BY attribute_name, attribute_value, source_system`
  );
  return {
    partitions,
    crosswalks: crosswalkRows.map(
      (row) => `${String(row.source_ref)}:${String(row.source_entity_id)}:${String(row.record_id)}`
    ),
    golden: goldenRows.map(
      (row) =>
        `${String(row.attribute_name)}:${String(row.attribute_value)}:${String(row.source_system)}`
    ),
  };
}

async function countStringOccurrencesInSchema(
  runner: SqlRunnerModule,
  schema: string,
  needle: string
): Promise<Array<{ table: string; count: number }>> {
  if (!runner.query) {
    throw new Error('DuckDB runner does not expose query()');
  }
  const tables = await runner.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}'`
  );
  const matches: Array<{ table: string; count: number }> = [];
  for (const table of tables) {
    const tableName = String(table.table_name);
    const columns = await runner.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = '${schema}' AND table_name = '${tableName}'`
    );
    const predicates = columns.map(
      (column) =>
        `CAST("${String(column.column_name)}" AS VARCHAR) LIKE '%${needle.replace(/'/g, "''")}%'`
    );
    if (predicates.length === 0) continue;
    const count = await scalarCount(
      runner,
      `SELECT COUNT(*) AS c FROM ${schema}.${tableName} WHERE ${predicates.join(' OR ')}`
    );
    if (count > 0) matches.push({ table: tableName, count });
  }
  return matches;
}

describe.skipIf(!DUCKDB_AVAILABLE)(
  'entity-graph DuckDB resolve e2e (no schema.columns — live repro)',
  () => {
    // Mirrors account_resolution_poc: neon_accounts (5 raw cols) + pylon_accounts
    // (3 raw cols), neither with schema.columns. The old `src.*` passthrough
    // caused "Queries in UNION ALL have mismatched column count: 12 columns vs
    // 10 columns". The fix drops raw passthrough in mixed mode so the UNION ALL
    // is valid and the pipeline completes.

    let dir: string;
    let dbPath: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'eg-nocols-e2e-'));
      dbPath = join(dir, 'resolve.duckdb');
      await writeNoColumnsFixture(dir, { duckdbDbPath: dbPath });

      // Use a DuckDB integration with handle `main` (matches the no-columns
      // fixture's connection name) so the source-registry fallback builds the
      // correct FQ table name: "main"."neon_accounts".
      const noColIntegration: IntegrationFile = {
        spec_version: '1',
        type: 'integration',
        name: NO_COL_INTEGRATION_HANDLE,
        source_type: 'duckdb',
        connection: { schema: 'main' },
        auth: { type: 'file', path: dbPath },
      };
      const runner = await resolveRunner(noColIntegration);
      try {
        await runner.run(`CREATE SCHEMA IF NOT EXISTS ${RESOLUTION_TARGET_SCHEMA}`);
        // neon_accounts: 5 raw columns (asymmetric — more than pylon_accounts).
        await runner.run(
          `CREATE TABLE main.neon_accounts
           (neon_id VARCHAR, name VARCHAR, email VARCHAR, plan VARCHAR, created_at VARCHAR)`
        );
        await runner.run(
          `INSERT INTO main.neon_accounts VALUES
            ('n1', 'Acme Corp', 'contact@acme.com.example.com', 'pro', '2024-01-01'),
            ('n2', 'Globex',    'hello@globex.io.example.com',  'free', '2024-02-01'),
            ('n3', 'Acme Corporation', 'admin@acme.com.example.com', 'pro', '2024-01-15')`
        );
        // pylon_accounts: 3 raw columns (asymmetric — fewer than neon_accounts).
        await runner.run(
          `CREATE TABLE main.pylon_accounts (pylon_id VARCHAR, name VARCHAR, domain VARCHAR)`
        );
        await runner.run(
          `INSERT INTO main.pylon_accounts VALUES
            ('p1', 'acme corp', 'acme.com'),
            ('p2', 'Initech',   'initech.io')`
        );
      } finally {
        await runner.close?.();
      }
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('completes the full pipeline without UNION ALL mismatch error', async () => {
      const result = await runResolveProject({
        cwd: dir,
        integration: NO_COL_INTEGRATION_HANDLE,
        schema: RESOLUTION_TARGET_SCHEMA,
      });

      expect(result.failure).toBeUndefined();
      expect(result.entities).toHaveLength(1);
      const entity = result.entities[0];
      expect(entity?.executed).toBe(true);

      const noColIntegration: IntegrationFile = {
        spec_version: '1',
        type: 'integration',
        name: NO_COL_INTEGRATION_HANDLE,
        source_type: 'duckdb',
        connection: { schema: 'main' },
        auth: { type: 'file', path: dbPath },
      };
      const runner = await resolveRunner(noColIntegration);
      try {
        // Row count = neon_accounts (3) + pylon_accounts (2) = 5 total.
        const stdCount = await scalarCount(
          runner,
          `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.${STANDARDIZED_TABLE}`
        );
        expect(stdCount).toBe(5);
      } finally {
        await runner.close?.();
      }
    });
  }
);

describe.skipIf(!DUCKDB_AVAILABLE)('entity-graph DuckDB incremental resolve parity', () => {
  let dir: string;
  let scratchDir: string;
  let dbPath: string;
  let scratchDbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eg-incremental-e2e-'));
    scratchDir = await mkdtemp(join(tmpdir(), 'eg-incremental-full-'));
    dbPath = join(dir, 'resolve.duckdb');
    scratchDbPath = join(scratchDir, 'resolve.duckdb');
    await writeIncrementalFixture(dir, { duckdbDbPath: dbPath });
    await writeIncrementalFixture(scratchDir, { duckdbDbPath: scratchDbPath });

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      await seedIncrementalBase(runner);
    } finally {
      await runner.close?.();
    }
    const scratchRunner = await resolveRunner(duckdbIntegration(scratchDbPath));
    try {
      await seedIncrementalFinal(scratchRunner);
    } finally {
      await scratchRunner.close?.();
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratchDir, { recursive: true, force: true });
  });

  it('matches a scratch full rebuild after new and updated rows', async () => {
    const baseline = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(baseline.failure).toBeUndefined();
    expect(baseline.entities[0]?.mode).toBe('full');
    await clusterResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      await applyIncrementalChanges(runner);
    } finally {
      await runner.close?.();
    }

    const incremental = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      incremental: true,
    });
    expect(incremental.failure).toBeUndefined();
    expect(incremental.entities[0]?.mode).toBe('incremental');
    expect(incremental.entities[0]?.mode_reason).toBe('resolve_state_matched');
    expect(incremental.entities[0]?.rows_written).toBe(2);
    await clusterResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });

    const scratch = await runResolveProject({
      cwd: scratchDir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(scratch.failure).toBeUndefined();
    await clusterResolveProject({
      cwd: scratchDir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });

    const incrementalRunner = await resolveRunner(duckdbIntegration(dbPath));
    const scratchRunner = await resolveRunner(duckdbIntegration(scratchDbPath));
    try {
      const deltaCount = await scalarCount(
        incrementalRunner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.${INCREMENTAL_STANDARDIZED_DELTA_TABLE}`
      );
      expect(deltaCount).toBe(2);
      const incrementalSnapshot = await snapshotResolutionTables(incrementalRunner);
      const scratchSnapshot = await snapshotResolutionTables(scratchRunner);
      expect(incrementalSnapshot.partitions).toEqual(scratchSnapshot.partitions);
      expect(incrementalSnapshot.crosswalks).toEqual(scratchSnapshot.crosswalks);
      expect(incrementalSnapshot.golden).toEqual(scratchSnapshot.golden);

      const currentCount = await scalarCount(
        incrementalRunner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__entity_id_current`
      );
      const crosswalkCount = await scalarCount(
        incrementalRunner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__crosswalks`
      );
      expect(currentCount).toBe(crosswalkCount);
    } finally {
      await incrementalRunner.close?.();
      await scratchRunner.close?.();
    }
  });

  it('falls back to full rebuild when the standardize/block/score fingerprint changes', async () => {
    const baseline = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(baseline.failure).toBeUndefined();

    const specPath = join(dir, 'entity-graph', 'account_resolution.yml');
    const original = await readFile(specPath, 'utf8');
    await writeFile(
      specPath,
      original.replace(
        'name: by_name\n      key: standardized_name',
        'name: by_name_v2\n      key: standardized_name'
      ),
      'utf8'
    );

    const next = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      incremental: true,
    });
    expect(next.failure).toBeUndefined();
    expect(next.entities[0]?.mode).toBe('full');
    expect(next.entities[0]?.mode_reason).toContain('spec_fingerprint_changed');
  });
});

describe.skipIf(!DUCKDB_AVAILABLE)('entity-graph DuckDB resolve e2e (asymmetric inputs)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eg-duckdb-e2e-'));
    dbPath = join(dir, 'resolve.duckdb');
    await writeAsymmetricFixture(dir, { duckdbDbPath: dbPath });

    // Seed source tables and the output schema via the same runner the
    // pipeline will use. accounts_a/accounts_b share two near-duplicate names
    // ("Acme Corp" / "acme corp") so the fuzzy scorer produces a real pair.
    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      await runner.run(`CREATE SCHEMA IF NOT EXISTS ${RESOLUTION_TARGET_SCHEMA}`);
      await runner.run(
        `CREATE TABLE main.accounts_a (account_id VARCHAR, name VARCHAR, slug VARCHAR)`
      );
      await runner.run(
        `INSERT INTO main.accounts_a VALUES
          ('a1', 'Acme Corp', 'acme'),
          ('a2', 'Globex', 'globex'),
          ('a3', 'Acme Corporation', 'acme-corp')`
      );
      await runner.run(
        `CREATE TABLE main.accounts_b (pylon_id VARCHAR, name VARCHAR, domain VARCHAR)`
      );
      await runner.run(
        `INSERT INTO main.accounts_b VALUES
          ('b1', 'acme corp', 'acme.com'),
          ('b2', 'Initech', 'initech.io')`
      );
    } finally {
      await runner.close?.();
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the full pipeline and materializes the expected tables', async () => {
    const result = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });

    expect(result.failure).toBeUndefined();
    expect(result.entities).toHaveLength(1);
    const entity = result.entities[0];
    if (!entity) {
      throw new Error('expected one executed entity');
    }
    expect(entity.executed).toBe(true);
    expect(entity.dry_run).toBe(false);

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      if (!runner.query) {
        throw new Error('DuckDB runner does not expose query()');
      }
      const tables = (
        await runner.query(
          `SELECT table_name FROM information_schema.tables
         WHERE table_schema = '${RESOLUTION_TARGET_SCHEMA}'`
        )
      ).map((row) => String(row.table_name));

      expect(tables).toContain(STANDARDIZED_TABLE);
      expect(tables).toContain(PAIR_SCORES_TABLE);

      // Standardized row count = rows_a (3) + rows_b (2) = 5.
      const stdCount = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.${STANDARDIZED_TABLE}`
      );
      expect(stdCount).toBe(5);
    } finally {
      await runner.close?.();
    }
  });

  it('NULL-pads asymmetric standardized columns by source system', async () => {
    const result = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(result.failure).toBeUndefined();

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const stdFq = `${RESOLUTION_TARGET_SCHEMA}.${STANDARDIZED_TABLE}`;

      // accounts_a has no `domain` → all 3 of its rows have NULL standardized_domain.
      const nullDomain = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${stdFq} WHERE standardized_domain IS NULL`
      );
      expect(nullDomain).toBe(3);

      // accounts_b has no `slug` → all 2 of its rows have NULL standardized_slug.
      const nullSlug = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${stdFq} WHERE standardized_slug IS NULL`
      );
      expect(nullSlug).toBe(2);

      // The NULLs line up with the source system that lacks the field.
      const aDomainNull = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${stdFq}
         WHERE _source_system = 'lake.accounts_a' AND standardized_domain IS NOT NULL`
      );
      expect(aDomainNull).toBe(0);
      const bSlugNull = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${stdFq}
         WHERE _source_system = 'lake.accounts_b' AND standardized_slug IS NOT NULL`
      );
      expect(bSlugNull).toBe(0);
    } finally {
      await runner.close?.();
    }
  });

  it('forgets a source record, repairs clusters, and prevents resurrection', async () => {
    const seedRunner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      await seedRunner.run(
        `UPDATE main.accounts_a SET slug = 'forget_unique_slug' WHERE account_id = 'a1'`
      );
    } finally {
      await seedRunner.close?.();
    }

    const runResult = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(runResult.failure).toBeUndefined();

    const clusterResult = await clusterResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(clusterResult.failure).toBeUndefined();

    const spec = resolvedAsymmetricSpec(dir);
    const forgetRequest = buildForgetRecordRequest(
      spec,
      { sourceRef: SOURCE_A_REF, pk: { account_id: 'a1' } },
      'gdpr erasure'
    );
    const statements = [
      ...generateMaterializeDdl(spec.entity, 'duckdb', RESOLUTION_TARGET_SCHEMA),
      ...generateAuditLogDdl('duckdb'),
      ...generateForgetSql({
        spec,
        dialect: 'duckdb',
        targetSchema: RESOLUTION_TARGET_SCHEMA,
        requests: [forgetRequest],
        reason: 'gdpr erasure',
      }),
      ...compileResolutionCluster(spec, 'duckdb', RESOLUTION_TARGET_SCHEMA).statements,
      ...compileResolutionProfile(spec, 'duckdb', RESOLUTION_TARGET_SCHEMA).statements,
    ];

    const executeForget = async () => {
      const runner = await resolveRunner(duckdbIntegration(dbPath));
      try {
        const results = await executeSqlStatements(
          statements.map((statement) => ({
            modelName: `account:${statement.name}`,
            sql: statement.sql,
            ignoreErrorPatterns: statement.ignoreErrorPatterns,
          })),
          runner.run
        );
        expect(
          results
            .filter((result) => result.status === 'failed')
            .map((result) => ({ model: result.modelName, error: result.error }))
        ).toEqual([]);
      } finally {
        await runner.close?.();
      }
    };

    await executeForget();
    await executeForget();

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      if (!runner.query) {
        throw new Error('DuckDB runner does not expose query()');
      }
      const standardizedCount = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__standardized`
      );
      expect(standardizedCount).toBe(4);

      const erasedRecordRows = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__clusters
         WHERE record_id = '${forgetRequest.tombstoneId}'`
      );
      expect(erasedRecordRows).toBe(0);

      const survivingB1Rows = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__clusters
         WHERE source_ref = '${SOURCE_B_REF}'
           AND source_pk_json = '{"pylon_id":"b1"}'`
      );
      expect(survivingB1Rows).toBe(1);

      const leakedRows = await countStringOccurrencesInSchema(
        runner,
        RESOLUTION_TARGET_SCHEMA,
        'forget_unique_slug'
      );
      expect(leakedRows).toEqual([]);

      const auditRows = await runner.query(buildAuditVerifyQuery('duckdb'));
      const status = String(auditRows[0]?.status ?? '').toLowerCase();
      expect(status).toBe('ok');
    } finally {
      await runner.close?.();
    }

    const rerun = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(rerun.failure).toBeUndefined();

    const verifyRunner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const resurrected = await scalarCount(
        verifyRunner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__standardized
         WHERE record_id = '${forgetRequest.tombstoneId}'`
      );
      expect(resurrected).toBe(0);
    } finally {
      await verifyRunner.close?.();
    }
  }, 30000);

  it('executes the rewritten review-apply DML shapes against a real warehouse', async () => {
    // Pins execution of the dialect-portable apply statements
    // (INSERT INTO ... WITH ... SELECT and DELETE ... WHERE ... IN (WITH ...))
    // — string-shape unit tests can't catch a parser rejection.
    const result = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(result.failure).toBeUndefined();

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    let pairId: string;
    try {
      if (!runner.query) {
        throw new Error('DuckDB runner does not expose query()');
      }
      const rows = await runner.query(
        `SELECT pair_id FROM ${RESOLUTION_TARGET_SCHEMA}.${PAIR_SCORES_TABLE} LIMIT 1`
      );
      pairId = String(rows[0]?.pair_id ?? '');
      expect(pairId).not.toBe('');
    } finally {
      await runner.close?.();
    }

    const bundle: AgentDecisionBundleV1 = {
      version: 'entity_graph_decision_bundle.v1',
      entity: 'account',
      mode: 'apply',
      decision_source: 'agent',
      threshold_bands: ['review'],
      decisions: [
        { pair_id: pairId, decision: 'not_match', confidence: 0.95, reason: 'distinct orgs' },
      ],
    };
    const applied = await applyReviewDecisions({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      bundle,
    });
    expect(applied.failure).toBeUndefined();
    expect(applied.executed).toBe(true);
    expect(applied.statements.every((stmt) => stmt.status === 'success')).toBe(true);

    const verifyRunner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const decisionCount = await scalarCount(
        verifyRunner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_decisions
         WHERE pair_id = '${pairId}'`
      );
      expect(decisionCount).toBe(1);
      const edgeCount = await scalarCount(
        verifyRunner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.account__not_match_edges
         WHERE pair_id = '${pairId}'`
      );
      expect(edgeCount).toBe(1);
    } finally {
      await verifyRunner.close?.();
    }
  });

  it('runs end-to-end with auto_merge: null — only deterministic rules merge', async () => {
    // Override the fixture resolution spec: scoring stays, but score-driven
    // auto-merge is disabled; a deterministic rule on standardized_name is
    // the only merge-edge source.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(dir, 'entity-graph', 'account_resolution.yml'),
      [
        `spec_version: '0.2'`,
        'type: resolution',
        'name: account_resolution',
        'description: Deterministic-only merging.',
        'inputs:',
        '  - ref: lake.accounts_a',
        '    role: internal',
        '    id_fields: [account_id]',
        '  - ref: lake.accounts_b',
        '    role: internal',
        '    id_fields: [pylon_id]',
        'standardize:',
        '  - field: name',
        '    transforms: [lowercase, trim]',
        'blocking:',
        '  rules:',
        '    - name: by_name',
        '      key: standardized_name',
        'deterministic_rules:',
        '  - name: exact_standardized_name',
        '    conditions:',
        '      - field: standardized_name',
        '        operator: exact',
        '        both_not_null: true',
        '    action: auto_merge',
        '    confidence: 1',
        'scoring:',
        '  method: weighted_features',
        '  features:',
        '    - field: standardized_name',
        '      algorithm: jaro_winkler',
        '      weight: 1.0',
        'thresholds:',
        '  auto_merge: null',
        '  review: 0.6',
        '  auto_reject: 0.3',
        'outputs:',
        '  target_schema: entity_graph',
        '',
      ].join('\n'),
      'utf8'
    );

    const result = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(result.failure).toBeUndefined();

    const clustered = await clusterResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(clustered.failure).toBeUndefined();

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      // 'Acme Corp' (a1) and 'acme corp' (b1) standardize identically →
      // deterministic pair → merged into one component despite the absence
      // of a numeric auto_merge cutoff: 5 records → 4 components.
      const componentCount = await scalarCount(
        runner,
        `SELECT COUNT(DISTINCT component_id) AS c
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__components`
      );
      expect(componentCount).toBe(4);

      // No deterministic pair may sit in the review queue — they merged.
      const deterministicInQueue = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_queue rq
         JOIN ${RESOLUTION_TARGET_SCHEMA}.${PAIR_SCORES_TABLE} ps ON rq.pair_id = ps.pair_id
         WHERE ps.match_type = 'deterministic'`
      );
      expect(deterministicInQueue).toBe(0);
    } finally {
      await runner.close?.();
    }
  });

  it('flag_for_review queues the pair (even above auto_merge) and merges only after an applied decision', async () => {
    // A flag_for_review rule with confidence 0.95 — ABOVE auto_merge 0.9. If
    // the clustering exclusion is broken the pair merges; if the threshold OR
    // is broken the pair never reaches the queue. Both fail this test.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(dir, 'entity-graph', 'account_resolution.yml'),
      [
        `spec_version: '0.2'`,
        'type: resolution',
        'name: account_resolution',
        'description: Flag-for-review deterministic rule.',
        'inputs:',
        '  - ref: lake.accounts_a',
        '    role: internal',
        '    id_fields: [account_id]',
        '  - ref: lake.accounts_b',
        '    role: internal',
        '    id_fields: [pylon_id]',
        'standardize:',
        '  - field: name',
        '    transforms: [lowercase, trim]',
        'blocking:',
        '  rules:',
        '    - name: by_name',
        '      key: standardized_name',
        'deterministic_rules:',
        '  - name: exact_standardized_name',
        '    conditions:',
        '      - field: standardized_name',
        '        operator: exact',
        '        both_not_null: true',
        '    action: flag_for_review',
        '    confidence: 0.95',
        'scoring:',
        '  method: weighted_features',
        '  features:',
        '    - field: standardized_name',
        '      algorithm: jaro_winkler',
        '      weight: 1.0',
        'thresholds:',
        '  auto_merge: 0.9',
        '  review: 0.6',
        '  auto_reject: 0.3',
        'outputs:',
        '  target_schema: entity_graph',
        '',
      ].join('\n'),
      'utf8'
    );

    const result = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(result.failure).toBeUndefined();

    const clustered = await clusterResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(clustered.failure).toBeUndefined();

    let pairId = '';
    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      if (!runner.query) {
        throw new Error('DuckDB runner does not expose query()');
      }
      // 'Acme Corp' (a1) / 'acme corp' (b1) standardize identically → the
      // flag rule fires and the pair sits in the queue with its band + rule.
      const queueRows = await runner.query(
        `SELECT pair_id, rule_name
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__review_queue
         WHERE threshold_band = 'deterministic_review'`
      );
      expect(queueRows).toHaveLength(1);
      expect(String(queueRows[0]?.rule_name)).toBe('exact_standardized_name');
      pairId = String(queueRows[0]?.pair_id ?? '');
      expect(pairId).not.toBe('');

      // Not merged: all 5 records remain their own component.
      const componentCount = await scalarCount(
        runner,
        `SELECT COUNT(DISTINCT component_id) AS c
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__components`
      );
      expect(componentCount).toBe(5);
    } finally {
      await runner.close?.();
    }

    // Adjudicate: an applied merge decision folds the pair in on re-cluster.
    const bundle: AgentDecisionBundleV1 = {
      version: 'entity_graph_decision_bundle.v1',
      entity: 'account',
      mode: 'apply',
      decision_source: 'agent',
      threshold_bands: ['deterministic_review'],
      decisions: [{ pair_id: pairId, decision: 'merge', confidence: 0.98, reason: 'same org' }],
    };
    const applied = await applyReviewDecisions({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
      quiet: true,
      bundle,
    });
    expect(applied.failure).toBeUndefined();
    expect(applied.executed).toBe(true);

    const reclustered = await clusterResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(reclustered.failure).toBeUndefined();

    const verifyRunner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      const componentCount = await scalarCount(
        verifyRunner,
        `SELECT COUNT(DISTINCT component_id) AS c
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__components`
      );
      expect(componentCount).toBe(4);
    } finally {
      await verifyRunner.close?.();
    }
  });

  it('executes native fuzzy scoring to produce candidate pair scores', async () => {
    const result = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(result.failure).toBeUndefined();

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      // The two "Acme Corp" / "acme corp" rows block together and score via
      // DuckDB's native jaro_winkler_similarity, yielding at least one pair.
      const scoreCount = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.${PAIR_SCORES_TABLE}`
      );
      expect(scoreCount).toBeGreaterThan(0);

      const maxScore = await scalarCount(
        runner,
        `SELECT MAX(composite_score) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.${PAIR_SCORES_TABLE}`
      );
      expect(maxScore).toBeGreaterThan(0);
      expect(maxScore).toBeLessThanOrEqual(1);
    } finally {
      await runner.close?.();
    }
  });

  it('blocks and scores USPS-normalized street/postal address pairs', async () => {
    const addressDir = await mkdtemp(join(tmpdir(), 'eg-duckdb-address-'));
    const addressDbPath = join(addressDir, 'address.duckdb');
    await writeAddressFixture(addressDir, { duckdbDbPath: addressDbPath });

    const runner = await resolveRunner(duckdbIntegration(addressDbPath));
    try {
      await runner.run(`CREATE SCHEMA IF NOT EXISTS ${RESOLUTION_TARGET_SCHEMA}`);
      await runner.run(
        `CREATE TABLE main.addresses_a (address_id VARCHAR, street VARCHAR, postal_code VARCHAR)`
      );
      await runner.run(
        `INSERT INTO main.addresses_a VALUES
          ('a1', '123 Main St.', '12345-6789'),
          ('a2', '500 Market Road', '94105')`
      );
      await runner.run(
        `CREATE TABLE main.addresses_b (provider_id VARCHAR, street VARCHAR, postal_code VARCHAR)`
      );
      await runner.run(
        `INSERT INTO main.addresses_b VALUES
          ('b1', '123 main street', '123456789'),
          ('b2', '88 Broadway Avenue', '10001')`
      );
    } finally {
      await runner.close?.();
    }

    const result = await runResolveProject({
      cwd: addressDir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(result.failure).toBeUndefined();

    const verifyRunner = await resolveRunner(duckdbIntegration(addressDbPath));
    try {
      const candidateCount = await scalarCount(
        verifyRunner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.${ADDRESS_CANDIDATE_PAIRS_TABLE}`
      );
      expect(candidateCount).toBe(1);

      const maxScore = await scalarCount(
        verifyRunner,
        `SELECT MAX(composite_score) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.${ADDRESS_PAIR_SCORES_TABLE}`
      );
      expect(maxScore).toBe(1);
    } finally {
      await verifyRunner.close?.();
      await rm(addressDir, { recursive: true, force: true });
    }
  });

  it('executes fellegi_sunter probabilistic scoring on DuckDB', async () => {
    // Override the fixture spec with a probabilistic (Fellegi–Sunter) scorer:
    // m/u are supplied per level, weights are inlined as log2(m/u), and the
    // composite is the sigmoid 1/(1 + EXP(-bits·ln2)). Pins that the generated
    // SQL actually executes and yields calibrated probabilities in (0, 1).
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(dir, 'entity-graph', 'account_resolution.yml'),
      [
        `spec_version: '0.2'`,
        'type: resolution',
        'name: account_resolution',
        'description: Probabilistic linkage demo.',
        'inputs:',
        '  - ref: lake.accounts_a',
        '    role: internal',
        '    id_fields: [account_id]',
        '  - ref: lake.accounts_b',
        '    role: internal',
        '    id_fields: [pylon_id]',
        'standardize:',
        '  - field: name',
        '    transforms: [lowercase, trim]',
        'blocking:',
        '  rules:',
        '    - name: by_name',
        '      key: standardized_name',
        'scoring:',
        '  method: fellegi_sunter',
        '  prior: 0.0001',
        '  comparisons:',
        '    - field: standardized_name',
        '      levels:',
        '        - { op: exact, m: 0.85, u: 0.0001 }',
        '        - { op: jaro_winkler, gte: 0.9, m: 0.1, u: 0.001 }',
        '        - { op: else, m: 0.05, u: 0.9989 }',
        'thresholds:',
        '  auto_merge: 0.99',
        '  review: 0.5',
        '  auto_reject: 0.1',
        'outputs:',
        '  target_schema: entity_graph',
        '',
      ].join('\n'),
      'utf8'
    );

    const result = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(result.failure).toBeUndefined();

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      // The blocked "acme corp" pair scores via the probabilistic model.
      const fsCount = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.${PAIR_SCORES_TABLE}
         WHERE match_type = 'fellegi_sunter'`
      );
      expect(fsCount).toBeGreaterThan(0);

      // Every calibrated probability stays strictly within (0, 1).
      const outOfRange = await scalarCount(
        runner,
        `SELECT COUNT(*) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.${PAIR_SCORES_TABLE}
         WHERE match_type = 'fellegi_sunter'
           AND (composite_score <= 0 OR composite_score >= 1)`
      );
      expect(outOfRange).toBe(0);

      // Known-pair oracle: the single exact-name pair (a1/b1), prior 0.0001 and
      // exact m=0.85,u=0.0001 → total ≈ -0.234 bits → composite ≈ 0.4595. Pins the
      // prior + weight + sigmoid wiring end-to-end (a sign flip → ~0.54; a dropped
      // prior → ~0.9999 — both fall outside this window).
      const fsScore = await scalarCount(
        runner,
        `SELECT composite_score AS c FROM ${RESOLUTION_TARGET_SCHEMA}.${PAIR_SCORES_TABLE}
         WHERE match_type = 'fellegi_sunter'`
      );
      expect(Math.abs(fsScore - 0.4595)).toBeLessThan(1e-3);
    } finally {
      await runner.close?.();
    }
  });

  it('routes fellegi_sunter pairs through threshold + clustering on DuckDB', async () => {
    // A stronger model (exact m=0.95, u=1e-6) pushes the "acme corp" pair above
    // auto_merge (0.9), so it must flow through threshold routing into clustering
    // and merge — proving FS reuses the existing pipeline, not just scoring.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(dir, 'entity-graph', 'account_resolution.yml'),
      [
        `spec_version: '0.2'`,
        'type: resolution',
        'name: account_resolution',
        'description: Probabilistic linkage — strong match clusters.',
        'inputs:',
        '  - ref: lake.accounts_a',
        '    role: internal',
        '    id_fields: [account_id]',
        '  - ref: lake.accounts_b',
        '    role: internal',
        '    id_fields: [pylon_id]',
        'standardize:',
        '  - field: name',
        '    transforms: [lowercase, trim]',
        'blocking:',
        '  rules:',
        '    - name: by_name',
        '      key: standardized_name',
        'scoring:',
        '  method: fellegi_sunter',
        '  prior: 0.0001',
        '  comparisons:',
        '    - field: standardized_name',
        '      levels:',
        '        - { op: exact, m: 0.95, u: 0.000001 }',
        '        - { op: else, m: 0.05, u: 0.999999 }',
        'thresholds:',
        '  auto_merge: 0.9',
        '  review: 0.5',
        '  auto_reject: 0.1',
        'outputs:',
        '  target_schema: entity_graph',
        '',
      ].join('\n'),
      'utf8'
    );

    const result = await runResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(result.failure).toBeUndefined();

    const clustered = await clusterResolveProject({
      cwd: dir,
      integration: INTEGRATION_HANDLE,
      schema: RESOLUTION_TARGET_SCHEMA,
    });
    expect(clustered.failure).toBeUndefined();

    const runner = await resolveRunner(duckdbIntegration(dbPath));
    try {
      // a1/b1 ("acme corp") merge: 5 records → 4 components.
      const componentCount = await scalarCount(
        runner,
        `SELECT COUNT(DISTINCT component_id) AS c
         FROM ${RESOLUTION_TARGET_SCHEMA}.account__components`
      );
      expect(componentCount).toBe(4);

      // Its calibrated score sits in the expected high band — the prior is applied
      // (a dropped-prior bug would push it to ~0.99999, outside this window).
      const fsScore = await scalarCount(
        runner,
        `SELECT MAX(composite_score) AS c FROM ${RESOLUTION_TARGET_SCHEMA}.${PAIR_SCORES_TABLE}
         WHERE match_type = 'fellegi_sunter'`
      );
      expect(fsScore).toBeGreaterThan(0.98);
      expect(fsScore).toBeLessThan(0.995);
    } finally {
      await runner.close?.();
    }
  });
});
