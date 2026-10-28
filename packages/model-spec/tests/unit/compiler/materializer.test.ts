import { describe, expect, it } from 'vitest';

import {
  materializeSql,
  planSchemaChange,
  planTransition,
} from '../../../src/compiler/materializer.js';
import { CommandError } from '../../../src/errors.js';

import type { SupportedDialect } from '../../../src/compiler/dialect.js';
import type { ResolvedTransformSpec } from '../../../src/compiler/parser.js';

const SELECT_SQL = 'SELECT id AS ID, name AS NAME FROM raw.users';

function makeSpec(overrides: Partial<ResolvedTransformSpec> = {}): ResolvedTransformSpec {
  return {
    name: 'test_model',
    description: 'Test model.',
    grain: 'id',
    trustTier: 'bronze',
    sourceRef: 'db.users',
    source: { fqTableName: 'RAW.USERS' },
    joins: [],
    columns: [
      { name: 'id', expr: 'id' },
      { name: 'name', expr: 'name' },
    ],
    materialization: 'view',
    ...overrides,
  };
}

describe('materializeSql', () => {
  // -----------------------------------------------------------------------
  // View materialization
  // -----------------------------------------------------------------------

  describe('view materialization', () => {
    const dialects: SupportedDialect[] = ['snowflake', 'bigquery', 'postgres', 'databricks'];

    for (const dialect of dialects) {
      it(`${dialect}: generates CREATE OR REPLACE VIEW`, () => {
        const spec = makeSpec({ materialization: 'view' });
        const result = materializeSql(SELECT_SQL, spec, 'my_schema', dialect);

        expect(result).toHaveLength(1);
        expect(result[0]).toContain('CREATE OR REPLACE VIEW');
        expect(result[0]).toContain(SELECT_SQL);
      });
    }
  });

  // -----------------------------------------------------------------------
  // Table materialization
  // -----------------------------------------------------------------------

  describe('table materialization', () => {
    it('snowflake: CREATE OR REPLACE TABLE', () => {
      const spec = makeSpec({ materialization: 'table' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake');

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('CREATE OR REPLACE TABLE');
      expect(result[0]).toContain(SELECT_SQL);
    });

    it('bigquery: CREATE OR REPLACE TABLE', () => {
      const spec = makeSpec({ materialization: 'table' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'bigquery');

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('CREATE OR REPLACE TABLE');
    });

    it('clickhouse: CREATE OR REPLACE TABLE with an explicit engine', () => {
      const spec = makeSpec({ materialization: 'table' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'clickhouse');

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('CREATE OR REPLACE TABLE');
      // ClickHouse has no default engine and MergeTree requires a sorting key,
      // so a statement missing either is rejected at CREATE time.
      expect(result[0]).toContain('ENGINE = MergeTree() ORDER BY tuple()');
      expect(result[0]).toContain(SELECT_SQL);
    });

    it('databricks: CREATE OR REPLACE TABLE', () => {
      const spec = makeSpec({ materialization: 'table' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'databricks');

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('CREATE OR REPLACE TABLE');
    });

    it('postgres: emits swap-rename DDL with CASCADE on the renamed-aside table', () => {
      const spec = makeSpec({ materialization: 'table', name: 'pg_stg_orders_enriched' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'postgres');

      // Swap-rename avoids `DROP TABLE` while a downstream materialized_view
      // references this table (Postgres pg_depend would otherwise block the drop).
      expect(result).toEqual([
        'DROP TABLE IF EXISTS "my_schema"."pg_stg_orders_enriched__dogsled_new";',
        'DROP TABLE IF EXISTS "my_schema"."pg_stg_orders_enriched__dogsled_old" CASCADE;',
        `CREATE TABLE "my_schema"."pg_stg_orders_enriched__dogsled_new" AS (\n${SELECT_SQL}\n);`,
        'ALTER TABLE IF EXISTS "my_schema"."pg_stg_orders_enriched" RENAME TO "pg_stg_orders_enriched__dogsled_old";',
        'ALTER TABLE "my_schema"."pg_stg_orders_enriched__dogsled_new" RENAME TO "pg_stg_orders_enriched";',
        'DROP TABLE IF EXISTS "my_schema"."pg_stg_orders_enriched__dogsled_old" CASCADE;',
      ]);
    });

    it('postgres: emits no plain `DROP TABLE <fqName>;` for the live table', () => {
      // Regression: prior shape was `DROP TABLE IF EXISTS <fq>; CREATE TABLE <fq> AS ...`
      // which fails on the second run when a downstream materialized_view depends
      // on the table. Make sure that exact pattern is gone.
      const spec = makeSpec({ materialization: 'table' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'postgres');

      const dropsLiveTable = result.some(
        (sql) =>
          sql.includes('DROP TABLE IF EXISTS "my_schema"."test_model";') ||
          sql.includes('DROP TABLE "my_schema"."test_model"')
      );
      expect(dropsLiveTable).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Incremental materialization — first run
  // -----------------------------------------------------------------------

  describe('incremental first run', () => {
    it('generates same as table on first run (snowflake)', () => {
      const spec = makeSpec({
        materialization: 'incremental',
        materializationConfig: { strategy: 'merge', unique_key: 'id' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake', {
        isFirstRun: true,
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('CREATE OR REPLACE TABLE');
    });

    it('generates swap-rename DDL on first run (postgres)', () => {
      const spec = makeSpec({
        materialization: 'incremental',
        materializationConfig: { strategy: 'merge', unique_key: 'id' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'postgres', {
        isFirstRun: true,
      });

      // First-run incremental shares the table-materialization path, so it must
      // also avoid dropping the live table while downstream MVs depend on it.
      expect(result).toHaveLength(6);
      expect(result[0]).toBe('DROP TABLE IF EXISTS "my_schema"."test_model__dogsled_new";');
      expect(result[2]).toContain('CREATE TABLE "my_schema"."test_model__dogsled_new"');
      expect(result[4]).toContain('RENAME TO "test_model"');
      expect(result[5]).toBe('DROP TABLE IF EXISTS "my_schema"."test_model__dogsled_old" CASCADE;');
    });
  });

  // -----------------------------------------------------------------------
  // Incremental — merge strategy
  // -----------------------------------------------------------------------

  describe('incremental merge', () => {
    it('snowflake: generates MERGE statement', () => {
      const spec = makeSpec({
        materialization: 'incremental',
        materializationConfig: { strategy: 'merge', unique_key: 'id' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'MY_SCHEMA', 'snowflake');

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('MERGE INTO');
      expect(result[0]).toContain('USING');
      expect(result[0]).toContain('__source');
      expect(result[0]).toContain('WHEN MATCHED THEN');
      expect(result[0]).toContain('UPDATE SET');
      expect(result[0]).toContain('WHEN NOT MATCHED THEN');
      expect(result[0]).toContain('INSERT');
    });

    it('bigquery: generates MERGE statement', () => {
      const spec = makeSpec({
        materialization: 'incremental',
        materializationConfig: { strategy: 'merge', unique_key: 'id' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'bigquery');

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('MERGE INTO');
    });

    it('postgres: generates MERGE statement', () => {
      const spec = makeSpec({
        materialization: 'incremental',
        materializationConfig: { strategy: 'merge', unique_key: 'id' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'postgres');

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('MERGE INTO');
    });

    it('databricks: generates MERGE statement', () => {
      const spec = makeSpec({
        materialization: 'incremental',
        materializationConfig: { strategy: 'merge', unique_key: 'id' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'databricks');

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('MERGE INTO');
    });

    it('handles composite unique_key', () => {
      const spec = makeSpec({
        materialization: 'incremental',
        materializationConfig: { strategy: 'merge', unique_key: ['id', 'name'] },
      });
      const result = materializeSql(SELECT_SQL, spec, 'MY_SCHEMA', 'snowflake');

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('__source.ID');
      expect(result[0]).toContain('__source.NAME');
    });

    it('aliases the target table and references keys through the alias', () => {
      const spec = makeSpec({
        materialization: 'incremental',
        materializationConfig: { strategy: 'merge', unique_key: 'id' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'MY_SCHEMA', 'snowflake');

      expect(result[0]).toContain('MERGE INTO "MY_SCHEMA"."TEST_MODEL" AS target');
      expect(result[0]).toContain('ON target.ID = __source.ID');
      // The ON clause must not re-qualify the key with the full table name —
      // that breaks BigQuery self-joins (see hyphenated-project test below).
      expect(result[0]).not.toContain('"TEST_MODEL".ID = __source.ID');
    });

    it('keeps a self-referencing incremental_filter valid for a hyphenated BigQuery project (self-join)', () => {
      // Regression: an unaliased MERGE target makes the `self` self-join's
      // qualified `<project>.<dataset>.<table>.<col>` reference parse as a name
      // expression on BigQuery, surfacing as `Unrecognized name: <project>` when
      // the GCP project id contains hyphens. Aliasing the target fixes it.
      const spec = makeSpec({
        name: 'linear_projects_enriched',
        columns: [
          { name: 'id', expr: 'id' },
          { name: 'updated_at', expr: 'updated_at' },
        ],
        materialization: 'incremental',
        materializationConfig: {
          strategy: 'merge',
          unique_key: 'id',
          incremental_filter:
            "updated_at > (SELECT COALESCE(MAX(updated_at), TIMESTAMP '1970-01-01') FROM self)",
        },
      });
      const selectSql =
        'SELECT t0.id AS id, t0.updated_at AS updated_at FROM dogsled_managed.raw_projects AS t0 ' +
        "WHERE (updated_at > (SELECT COALESCE(MAX(updated_at), CAST('1970-01-01' AS TIMESTAMP)) " +
        'FROM `ci-dogsled-tech-andyup`.`dogsled_managed`.`linear_projects_enriched`))';
      const result = materializeSql(
        selectSql,
        spec,
        'dogsled_managed',
        'bigquery',
        { isFirstRun: false },
        'ci-dogsled-tech-andyup'
      );

      // Target is aliased, so the self-join is unambiguous.
      expect(result[0]).toContain(
        'MERGE INTO `ci-dogsled-tech-andyup`.`dogsled_managed`.`linear_projects_enriched` AS target'
      );
      expect(result[0]).toContain('ON target.id = __source.id');
      // The key must be qualified by the alias, never by the fully-qualified name.
      expect(result[0]).not.toContain('`linear_projects_enriched`.id = __source.id');
      // The self-reference inside the USING subquery still carries its backticks.
      expect(result[0]).toContain(
        'FROM `ci-dogsled-tech-andyup`.`dogsled_managed`.`linear_projects_enriched`'
      );
    });
  });

  // -----------------------------------------------------------------------
  // Incremental — delete_insert strategy
  // -----------------------------------------------------------------------

  describe('incremental delete_insert', () => {
    it('snowflake: BEGIN/DELETE/INSERT/COMMIT', () => {
      const spec = makeSpec({
        materialization: 'incremental',
        materializationConfig: { strategy: 'delete_insert', unique_key: 'id' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'MY_SCHEMA', 'snowflake');

      expect(result).toHaveLength(4);
      expect(result[0]).toBe('BEGIN;');
      expect(result[1]).toContain('DELETE FROM');
      expect(result[2]).toContain('INSERT INTO');
      expect(result[3]).toBe('COMMIT;');
    });
  });

  // -----------------------------------------------------------------------
  // Incremental — append strategy
  // -----------------------------------------------------------------------

  describe('incremental append', () => {
    it('generates INSERT INTO', () => {
      const spec = makeSpec({
        materialization: 'incremental',
        materializationConfig: { strategy: 'append' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'MY_SCHEMA', 'snowflake');

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('INSERT INTO');
      expect(result[0]).toContain(SELECT_SQL);
    });
  });

  // -----------------------------------------------------------------------
  // Ephemeral materialization
  // -----------------------------------------------------------------------

  describe('ephemeral materialization', () => {
    it('returns empty array', () => {
      const spec = makeSpec({ materialization: 'ephemeral' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake');

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Hooks
  // -----------------------------------------------------------------------

  describe('hooks', () => {
    it('expands {schema} and {name} templates in hooks', () => {
      const spec = makeSpec({
        materialization: 'view',
        preHook: ['GRANT SELECT ON {schema}.{name} TO analyst_role;'],
        postHook: ["ALTER VIEW {schema}.{name} SET COMMENT = 'managed';"],
      });
      const result = materializeSql(SELECT_SQL, spec, 'MY_SCHEMA', 'snowflake');

      expect(result).toHaveLength(3);
      expect(result[0]).toBe('GRANT SELECT ON MY_SCHEMA.test_model TO analyst_role;');
      expect(result[2]).toBe("ALTER VIEW MY_SCHEMA.test_model SET COMMENT = 'managed';");
    });

    it('places pre-hooks before DDL and post-hooks after', () => {
      const spec = makeSpec({
        materialization: 'view',
        preHook: ['PRE_HOOK_SQL;'],
        postHook: ['POST_HOOK_SQL;'],
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake');

      expect(result).toHaveLength(3);
      expect(result[0]).toBe('PRE_HOOK_SQL;');
      expect(result[1]).toContain('CREATE OR REPLACE VIEW');
      expect(result[2]).toBe('POST_HOOK_SQL;');
    });

    it('handles multiple hooks', () => {
      const spec = makeSpec({
        materialization: 'view',
        preHook: ['PRE1;', 'PRE2;'],
        postHook: ['POST1;', 'POST2;'],
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake');

      expect(result).toHaveLength(5);
      expect(result[0]).toBe('PRE1;');
      expect(result[1]).toBe('PRE2;');
      expect(result[2]).toContain('CREATE OR REPLACE VIEW');
      expect(result[3]).toBe('POST1;');
      expect(result[4]).toBe('POST2;');
    });

    it('no hooks by default', () => {
      const spec = makeSpec({ materialization: 'view' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake');

      expect(result).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // dynamic_table materialization
  // -----------------------------------------------------------------------

  describe('dynamic_table materialization', () => {
    it('snowflake: requires an explicit or integration-provided warehouse', () => {
      const spec = makeSpec({ materialization: 'dynamic_table' });
      expect(() => materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake')).toThrow(
        /require a warehouse/i
      );
    });

    it('snowflake: generates DYNAMIC TABLE with bare DOWNSTREAM keyword (not a string literal)', () => {
      const spec = makeSpec({ materialization: 'dynamic_table' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake', {
        defaultDynamicTableWarehouse: 'transform_wh',
      });
      const joined = result.join(' ');
      expect(joined).toContain('DYNAMIC TABLE');
      expect(joined).toContain('TARGET_LAG = DOWNSTREAM');
      expect(joined).not.toContain("TARGET_LAG = 'DOWNSTREAM'");
      expect(joined).toContain('WAREHOUSE = TRANSFORM_WH');
      expect(joined).toContain('COPY GRANTS');
    });

    it('snowflake: applies target_lag and warehouse options', () => {
      const spec = makeSpec({
        materialization: 'dynamic_table',
        materializationConfig: { target_lag: '1 hour', warehouse: 'transform_wh' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake');
      const joined = result.join(' ');
      expect(joined).toContain("TARGET_LAG = '1 hour'");
      expect(joined).toContain('WAREHOUSE = TRANSFORM_WH');
    });

    it.each(['bigquery', 'postgres', 'databricks', 'duckdb'] as SupportedDialect[])(
      '%s: fails loudly',
      (dialect) => {
        const spec = makeSpec({ materialization: 'dynamic_table' });
        expect(() => materializeSql(SELECT_SQL, spec, 'my_schema', dialect)).toThrow(CommandError);
      }
    );

    // Regression guard for the selectable-session-warehouse feature: the
    // dynamic-table `materialization.warehouse` DDL clause (a WAREHOUSE = ...
    // clause baked into the CREATE DYNAMIC TABLE statement) is a separate
    // concept from the session warehouse override and must keep flowing
    // through `materialization.warehouse` / `defaultDynamicTableWarehouse`
    // unchanged. The session override never touches this DDL.
    it('snowflake: model-level materialization.warehouse still wins over the integration default', () => {
      const spec = makeSpec({
        materialization: 'dynamic_table',
        materializationConfig: { warehouse: 'model_wh' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake', {
        defaultDynamicTableWarehouse: 'integration_wh',
      });
      const joined = result.join(' ');
      expect(joined).toContain('WAREHOUSE = MODEL_WH');
      expect(joined).not.toContain('WAREHOUSE = INTEGRATION_WH');
    });
  });

  // -----------------------------------------------------------------------
  // materialized_view materialization
  // -----------------------------------------------------------------------

  describe('materialized_view materialization', () => {
    it('snowflake: CREATE OR REPLACE MATERIALIZED VIEW', () => {
      const spec = makeSpec({ materialization: 'materialized_view' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake');
      expect(result.join(' ')).toContain('MATERIALIZED VIEW');
      expect(result.join(' ')).toContain('COPY GRANTS');
    });

    it('bigquery: CREATE OR REPLACE MATERIALIZED VIEW', () => {
      const spec = makeSpec({ materialization: 'materialized_view' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'bigquery');
      expect(result.join(' ')).toContain('MATERIALIZED VIEW');
    });

    it('bigquery: emits max_staleness option', () => {
      const spec = makeSpec({
        materialization: 'materialized_view',
        materializationConfig: { max_staleness: '1 hour' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'bigquery');
      expect(result.join(' ')).toContain('OPTIONS (max_staleness = INTERVAL "1" HOUR)');
    });

    it('databricks: CREATE OR REPLACE MATERIALIZED VIEW', () => {
      const spec = makeSpec({ materialization: 'materialized_view' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'databricks');
      expect(result.join(' ')).toContain('MATERIALIZED VIEW');
    });

    it('postgres: DROP + CREATE MATERIALIZED VIEW (two statements)', () => {
      const spec = makeSpec({ materialization: 'materialized_view' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'postgres');
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.join(' ')).toContain('DROP MATERIALIZED VIEW');
      expect(result.join(' ')).toContain('CREATE MATERIALIZED VIEW');
    });

    it.each(['mysql', 'duckdb'] as SupportedDialect[])('%s: fails loudly', (dialect) => {
      const spec = makeSpec({ materialization: 'materialized_view' });
      expect(() => materializeSql(SELECT_SQL, spec, 'my_schema', dialect)).toThrow(CommandError);
    });
  });

  describe('transition planning', () => {
    it('plans explicit drop for view to table', () => {
      expect(planTransition('view', 'table', 'snowflake', 'MY_SCHEMA.MODEL', 'model')).toEqual({
        kind: 'recreate',
        preDdl: ['DROP VIEW IF EXISTS MY_SCHEMA.MODEL;'],
      });
    });

    it('plans explicit drop for table to view', () => {
      expect(planTransition('table', 'view', 'snowflake', 'MY_SCHEMA.MODEL', 'model')).toEqual({
        kind: 'recreate',
        preDdl: ['DROP TABLE IF EXISTS MY_SCHEMA.MODEL;'],
      });
    });

    it.each([
      ['incremental', 'table'],
      ['view', 'incremental'],
      ['snapshot', 'table'],
    ])('fails %s to %s', (previous, next) => {
      const decision = planTransition(previous, next, 'snowflake', 'MY_SCHEMA.MODEL', 'model');
      expect(decision.kind).toBe('fail');
      if (decision.kind === 'fail') expect(decision.exitCode).toBe(3);
    });
  });

  describe('schema change planning', () => {
    const previous = [{ name: 'ID', type: 'integer', primary_key: true, not_null: true }];
    const next = [
      { name: 'ID', type: 'integer', primary_key: true, not_null: true },
      { name: 'EMAIL', type: 'string', primary_key: false, not_null: false },
    ];

    it('fails drift by default', () => {
      const decision = planSchemaChange('model', 'v1:old', 'v1:new', previous, next, 'fail');
      expect(decision.kind).toBe('fail');
      if (decision.kind === 'fail') {
        expect(decision.exitCode).toBe(3);
        expect(decision.message).toContain('+ column `EMAIL`');
      }
    });

    it('requests full refresh when configured', () => {
      const decision = planSchemaChange(
        'model',
        'v1:old',
        'v1:new',
        previous,
        next,
        'full_refresh'
      );
      expect(decision).toEqual({ kind: 'full_refresh' });
    });
  });

  // -----------------------------------------------------------------------
  // Hook template expansion
  // -----------------------------------------------------------------------

  describe('hook template expansion', () => {
    it('expands {schema} and {name} in pre_hook', () => {
      const spec = makeSpec({
        materialization: 'view',
        preHook: ['GRANT SELECT ON {schema}.{name} TO ROLE analyst;'],
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake');
      expect(result[0]).toContain('my_schema');
      expect(result[0]).toContain('test_model');
      expect(result[0]).not.toContain('{schema}');
      expect(result[0]).not.toContain('{name}');
    });

    it('expands {schema} and {name} in post_hook', () => {
      const spec = makeSpec({
        materialization: 'view',
        postHook: ["COMMENT ON VIEW {schema}.{name} IS 'auto-generated';"],
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake');
      const last = result[result.length - 1]!;
      expect(last).toContain('my_schema');
      expect(last).toContain('test_model');
    });

    it('hooks appear in correct order: pre, DDL, post', () => {
      const spec = makeSpec({
        materialization: 'view',
        preHook: ['PRE;'],
        postHook: ['POST;'],
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake');
      expect(result[0]).toBe('PRE;');
      expect(result[1]).toContain('CREATE');
      expect(result[2]).toBe('POST;');
    });
  });

  // -----------------------------------------------------------------------
  // Incremental strategy edge cases
  // -----------------------------------------------------------------------

  describe('incremental strategy variants', () => {
    it('append generates INSERT without MERGE', () => {
      const spec = makeSpec({
        materialization: 'incremental',
        materializationConfig: { strategy: 'append', incremental_filter: "dt > '2024-01-01'" },
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake');
      const joined = result.join(' ');
      expect(joined).toContain('INSERT');
      expect(joined).not.toContain('MERGE');
    });

    it('merge with array unique_key generates compound ON', () => {
      const spec = makeSpec({
        materialization: 'incremental',
        materializationConfig: { strategy: 'merge', unique_key: ['order_id', 'line_id'] },
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'snowflake');
      const joined = result.join(' ');
      expect(joined).toContain('MERGE');
      expect(joined).toContain('ORDER_ID');
      expect(joined).toContain('LINE_ID');
    });
  });

  // -----------------------------------------------------------------------
  // Snapshot (SCD Type 2) materialization
  // -----------------------------------------------------------------------

  describe('snapshot first run', () => {
    it('snowflake: CREATE TABLE with valid_from/valid_to/is_current columns', () => {
      const spec = makeSpec({
        materialization: 'snapshot',
        materializationConfig: { unique_key: 'id' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'MY_SCHEMA', 'snowflake', {
        isFirstRun: true,
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('CREATE OR REPLACE TABLE');
      expect(result[0]).toContain('VALID_FROM');
      expect(result[0]).toContain('VALID_TO');
      expect(result[0]).toContain('IS_CURRENT');
      expect(result[0]).toContain('CURRENT_TIMESTAMP');
      expect(result[0]).toContain('NULL::TIMESTAMP');
      expect(result[0]).toContain('TRUE');
    });

    it('snowflake: uses custom valid_from/valid_to column names', () => {
      const spec = makeSpec({
        materialization: 'snapshot',
        materializationConfig: {
          unique_key: 'id',
          valid_from_column: 'effective_start',
          valid_to_column: 'effective_end',
        },
      });
      const result = materializeSql(SELECT_SQL, spec, 'MY_SCHEMA', 'snowflake', {
        isFirstRun: true,
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('EFFECTIVE_START');
      expect(result[0]).toContain('EFFECTIVE_END');
      expect(result[0]).not.toContain('VALID_FROM');
      expect(result[0]).not.toContain('VALID_TO');
    });

    it('mysql: DROP + CREATE on first run', () => {
      const spec = makeSpec({
        materialization: 'snapshot',
        materializationConfig: { unique_key: 'id' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'mysql', { isFirstRun: true });

      expect(result).toHaveLength(2);
      expect(result[0]).toContain('DROP TABLE IF EXISTS');
      expect(result[1]).toContain('CREATE TABLE');
      expect(result[1]).toContain('valid_from');
      expect(result[1]).toContain('valid_to');
      expect(result[1]).toContain('is_current');
      expect(result[1]).toContain('CAST(NULL AS DATETIME)');
    });
  });

  describe('snapshot subsequent run', () => {
    it('snowflake: MERGE closes changed rows + NOT EXISTS INSERT covers new and changed', () => {
      const spec = makeSpec({
        materialization: 'snapshot',
        materializationConfig: { unique_key: 'id' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'MY_SCHEMA', 'snowflake');

      expect(result).toHaveLength(2);
      // First statement: MERGE only closes changed rows (no WHEN NOT MATCHED).
      expect(result[0]).toContain('MERGE INTO');
      expect(result[0]).toContain('target.ID = __source.ID');
      expect(result[0]).toContain('IS_CURRENT = TRUE');
      expect(result[0]).toContain('IS DISTINCT FROM');
      expect(result[0]).toContain('WHEN MATCHED AND');
      expect(result[0]).toContain('UPDATE SET VALID_TO = CURRENT_TIMESTAMP');
      expect(result[0]).not.toContain('WHEN NOT MATCHED');
      // Second statement: NOT EXISTS INSERT handles both new keys and changed-key new versions.
      expect(result[1]).toContain('INSERT INTO');
      expect(result[1]).toContain('NOT EXISTS');
      expect(result[1]).toContain('target.ID = __source.ID');
      expect(result[1]).toContain('IS_CURRENT = TRUE');
      expect(result[1]).not.toContain('INNER JOIN');
    });

    it('snowflake: handles composite unique_key', () => {
      const spec = makeSpec({
        materialization: 'snapshot',
        materializationConfig: { unique_key: ['id', 'name'] },
        columns: [
          { name: 'id', expr: 'id' },
          { name: 'name', expr: 'name' },
          { name: 'status', expr: 'status' },
        ],
      });
      const result = materializeSql(SELECT_SQL, spec, 'MY_SCHEMA', 'snowflake');

      expect(result).toHaveLength(2);
      // ON clause should have both keys
      expect(result[0]).toContain('target.ID = __source.ID AND target.NAME = __source.NAME');
      // Change detection should only be on non-key columns
      expect(result[0]).toContain('target.STATUS IS DISTINCT FROM __source.STATUS');
      // NOT EXISTS predicate also matches both keys
      expect(result[1]).toContain('target.ID = __source.ID AND target.NAME = __source.NAME');
    });

    it('snowflake: uses explicit tracked_columns for change detection', () => {
      const spec = makeSpec({
        materialization: 'snapshot',
        materializationConfig: {
          unique_key: 'id',
          tracked_columns: ['name'],
        },
        columns: [
          { name: 'id', expr: 'id' },
          { name: 'name', expr: 'name' },
          { name: 'status', expr: 'status' },
        ],
      });
      const result = materializeSql(SELECT_SQL, spec, 'MY_SCHEMA', 'snowflake');

      expect(result).toHaveLength(2);
      // Should only track 'name', not 'status'
      expect(result[0]).toContain('target.NAME IS DISTINCT FROM __source.NAME');
      expect(result[0]).not.toContain('STATUS');
    });

    it('snowflake: default tracked_columns uses all non-key columns', () => {
      const spec = makeSpec({
        materialization: 'snapshot',
        materializationConfig: { unique_key: 'id' },
        columns: [
          { name: 'id', expr: 'id' },
          { name: 'name', expr: 'name' },
          { name: 'status', expr: 'status' },
        ],
      });
      const result = materializeSql(SELECT_SQL, spec, 'MY_SCHEMA', 'snowflake');

      expect(result).toHaveLength(2);
      // Both non-key columns should be in change detection
      expect(result[0]).toContain('target.NAME IS DISTINCT FROM __source.NAME');
      expect(result[0]).toContain('target.STATUS IS DISTINCT FROM __source.STATUS');
    });

    it('mysql: UPDATE + NOT EXISTS INSERT (no MERGE)', () => {
      const spec = makeSpec({
        materialization: 'snapshot',
        materializationConfig: { unique_key: 'id' },
      });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'mysql');

      expect(result).toHaveLength(2);
      // Step 1: UPDATE to close changed rows
      expect(result[0]).toContain('UPDATE');
      expect(result[0]).toContain('is_current = FALSE');
      expect(result[0]).toContain('<=>');
      // Step 2: NOT EXISTS INSERT for both new keys and changed-key new versions
      expect(result[1]).toContain('INSERT INTO');
      expect(result[1]).toContain('NOT EXISTS');
      expect(result[1]).toContain('t.id = __source.id');
      expect(result[1]).toContain('t.is_current = TRUE');
      expect(result[1]).not.toContain('LEFT JOIN');
      expect(result[1]).not.toContain('INNER JOIN');
    });
  });

  // -----------------------------------------------------------------------
  // pgvector / redshift target profiles
  // -----------------------------------------------------------------------
  describe('pgvector / redshift targets', () => {
    it('pgvector: table materialization uses postgres swap-rename path', () => {
      const spec = makeSpec({ materialization: 'table' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'pgvector');
      expect(result).toHaveLength(6);
      expect(result[2]).toContain('CREATE TABLE "my_schema"."test_model__dogsled_new"');
      expect(result[4]).toContain('RENAME TO "test_model"');
      expect(result[5]).toBe('DROP TABLE IF EXISTS "my_schema"."test_model__dogsled_old" CASCADE;');
    });

    it('redshift: table materialization uses postgres swap-rename path', () => {
      const spec = makeSpec({ materialization: 'table' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'redshift');
      expect(result).toHaveLength(6);
      expect(result[2]).toContain('CREATE TABLE "my_schema"."test_model__dogsled_new"');
      expect(result[4]).toContain('RENAME TO "test_model"');
      expect(result[5]).toBe('DROP TABLE IF EXISTS "my_schema"."test_model__dogsled_old" CASCADE;');
    });

    it('pgvector: view materialization uses CREATE OR REPLACE VIEW', () => {
      const spec = makeSpec({ materialization: 'view' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'pgvector');
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('CREATE OR REPLACE VIEW');
    });

    it('redshift: materialized_view uses DROP + CREATE (postgres path)', () => {
      const spec = makeSpec({ materialization: 'materialized_view' });
      const result = materializeSql(SELECT_SQL, spec, 'my_schema', 'redshift');
      // Postgres path: DROP + CREATE for materialized views
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('DROP MATERIALIZED VIEW IF EXISTS');
      expect(result[1]).toContain('CREATE MATERIALIZED VIEW');
    });
  });
});
