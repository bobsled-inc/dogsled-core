/**
 * BigQuery SQL validity regression test (pure compile — no warehouse).
 *
 * Compiles the asymmetric two-input resolution project for BigQuery and
 * validates the emitted SQL against three production-bug regression invariants:
 *
 *  1. No raw control chars inside single-quoted string literals (BigQuery
 *     "Unclosed string literal").
 *  2. The Jaro-Winkler UDF is inlined into every statement that calls it — there
 *     is no standalone `CREATE TEMP FUNCTION` preamble (BigQuery rejects a job
 *     containing only a temp-function DDL with no consuming query).
 *  3. The `standardize` UNION ALL branches share an identical alias sequence and
 *     NULL-pad asymmetric columns — no branch references a column its input
 *     lacks.
 *
 * Invariants 1 + 3 also run across DuckDB / Snowflake / Postgres output, except
 * invariant 1 is BigQuery-only: raw control chars inside literals are *legal*
 * on DuckDB / Snowflake / Postgres, where `escapeSqlString` deliberately uses a
 * raw control char as the search argument of a REPLACE() call.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compileResolveProject } from '../../src/api/index.js';
import {
  BIGQUERY_JARO_WINKLER_UDF,
  BIGQUERY_TOKEN_COSINE_UDF,
} from '../../src/compiler/core/dialect-similarity.js';
import type { SqlStatement } from '../../src/compiler/identity/types.js';
import { generateApplySql } from '../../src/compiler/identity/review-apply.js';
import type { ReviewDecisionRow } from '../../src/compiler/identity/types.js';
import {
  writeAsymmetricFixture,
  writeNoColumnsFixture,
  RESOLUTION_TARGET_SCHEMA,
} from './asymmetric-fixture.js';
import {
  extractUnionBranchAliases,
  findBareUnions,
  findRawControlCharsInLiterals,
} from './sql-invariants.js';

async function compileForDialect(
  dir: string,
  dialect: SupportedDialect
): Promise<{ statements: SqlStatement[]; preamble?: string }> {
  const result = await compileResolveProject({
    cwd: dir,
    dialect,
    schema: RESOLUTION_TARGET_SCHEMA,
  });
  expect(result.entities).toHaveLength(1);
  const entity = result.entities[0];
  if (!entity) {
    throw new Error('expected one compiled entity');
  }
  return {
    statements: entity.result.statements,
    ...(entity.result.preamble !== undefined ? { preamble: entity.result.preamble } : {}),
  };
}

function findStandardize(statements: SqlStatement[]): SqlStatement {
  const stmt = statements.find((s) => s.name === 'standardize');
  if (!stmt) {
    throw new Error('expected a standardize statement');
  }
  return stmt;
}

describe('entity-graph BigQuery SQL validity (asymmetric inputs)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eg-bq-validity-'));
    await writeAsymmetricFixture(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('emits no raw control chars inside string literals (invariant 1)', async () => {
    const { statements, preamble } = await compileForDialect(dir, 'bigquery');
    for (const stmt of statements) {
      expect(
        findRawControlCharsInLiterals(stmt.sql),
        `raw control char inside a literal in statement "${stmt.name}"`
      ).toEqual([]);
    }
    if (preamble !== undefined) {
      expect(findRawControlCharsInLiterals(preamble)).toEqual([]);
    }
  });

  it('inlines BigQuery fuzzy UDFs into each consuming statement, no standalone preamble (invariant 2)', async () => {
    const { statements, preamble } = await compileForDialect(dir, 'bigquery');

    // BigQuery's fuzzy preamble must be empty/undefined — the temp function is
    // job-scoped, so a standalone preamble job is both unexecutable and useless.
    if (preamble !== undefined) {
      expect(preamble).not.toContain('CREATE TEMP FUNCTION bms_jaro_winkler');
      expect(preamble).not.toContain('CREATE TEMP FUNCTION bms_token_cosine');
    }

    // Every statement that calls the UDF must carry its own DDL, and that DDL
    // must be the native SQL UDF — a LANGUAGE js UDF routes every row through
    // a sandboxed V8 process and is untenably slow at scale.
    const callers = statements.filter((s) => s.sql.includes('bms_jaro_winkler('));
    expect(callers.length).toBeGreaterThan(0);
    for (const stmt of callers) {
      expect(
        stmt.sql,
        `statement "${stmt.name}" calls bms_jaro_winkler but does not inline its DDL`
      ).toContain('CREATE TEMP FUNCTION bms_jaro_winkler');
      expect(stmt.sql, `statement "${stmt.name}" uses a LANGUAGE js UDF`).not.toContain(
        'LANGUAGE js'
      );
    }

    const tokenCallers = statements.filter((s) => s.sql.includes('bms_token_cosine('));
    expect(tokenCallers.length).toBeGreaterThan(0);
    for (const stmt of tokenCallers) {
      expect(
        stmt.sql,
        `statement "${stmt.name}" calls bms_token_cosine but does not inline its DDL`
      ).toContain('CREATE TEMP FUNCTION bms_token_cosine');
      expect(stmt.sql, `statement "${stmt.name}" uses a LANGUAGE js UDF`).not.toContain(
        'LANGUAGE js'
      );
    }

    // No statement may consist *solely* of the temp-function DDL with no
    // consuming query after it (the rejected standalone-preamble shape).
    for (const stmt of statements) {
      if (stmt.sql.startsWith('CREATE TEMP FUNCTION bms_jaro_winkler')) {
        const afterUdf = stmt.sql.slice(BIGQUERY_JARO_WINKLER_UDF.length).trim();
        expect(
          afterUdf.length,
          `statement "${stmt.name}" is a standalone temp-function DDL with no consuming query`
        ).toBeGreaterThan(0);
        expect(afterUdf.toUpperCase()).toContain('SELECT');
      }
      if (stmt.sql.startsWith('CREATE TEMP FUNCTION bms_token_cosine')) {
        const afterUdf = stmt.sql.slice(BIGQUERY_TOKEN_COSINE_UDF.length).trim();
        expect(
          afterUdf.length,
          `statement "${stmt.name}" is a standalone token-cosine temp-function DDL with no consuming query`
        ).toBeGreaterThan(0);
        expect(afterUdf.toUpperCase()).toContain('SELECT');
      }
    }
  });

  it('standardize UNION ALL branches are symmetric and NULL-pad asymmetric columns (invariant 3)', async () => {
    const { statements } = await compileForDialect(dir, 'bigquery');
    const standardize = findStandardize(statements);
    const branches = extractUnionBranchAliases(standardize.sql);

    // Two inputs → two branches, with identical alias sequences.
    expect(branches.length).toBe(2);
    const [branchA, branchB] = branches;
    expect(branchA).toBeDefined();
    expect(branchB).toBeDefined();
    expect(branchA).toEqual(branchB);

    // Both standardized columns appear in both branches.
    expect(branchA).toContain('standardized_slug');
    expect(branchA).toContain('standardized_domain');
    expect(branchA).toContain('slug');
    expect(branchA).toContain('domain');

    // Split the SQL into branch bodies (not just aliases) to check NULL-padding
    // and that no branch references a column its input lacks.
    const branchBodies = standardize.sql.split('\nUNION ALL\n');
    expect(branchBodies).toHaveLength(2);
    const [bodyA, bodyB] = branchBodies;
    if (bodyA === undefined || bodyB === undefined) {
      throw new Error('expected two standardize branch bodies');
    }

    // accounts_a (branch 0) lacks `domain` → standardized_domain + domain are NULL-padded.
    expect(bodyA).toContain('CAST(NULL AS STRING) AS `standardized_domain`');
    expect(bodyA).toContain('CAST(NULL AS STRING) AS `domain`');
    // accounts_b (branch 1) lacks `slug` → standardized_slug + slug are NULL-padded.
    expect(bodyB).toContain('CAST(NULL AS STRING) AS `standardized_slug`');
    expect(bodyB).toContain('CAST(NULL AS STRING) AS `slug`');

    // No branch may *read* a column absent from its own input: accounts_a never
    // reads `src`.`domain`; accounts_b never reads `src`.`slug`.
    expect(bodyA).not.toContain('`src`.`domain`');
    expect(bodyB).not.toContain('`src`.`slug`');
  });

  const otherDialects: SupportedDialect[] = ['duckdb', 'snowflake', 'postgres'];
  for (const dialect of otherDialects) {
    it(`compiles symmetric standardize branches for ${dialect} (invariant 3)`, async () => {
      const { statements } = await compileForDialect(dir, dialect);
      const standardize = findStandardize(statements);
      const branches = extractUnionBranchAliases(standardize.sql);
      expect(branches.length).toBe(2);
      const [branchA, branchB] = branches;
      expect(branchA).toEqual(branchB);
      // Snowflake uppercases identifiers, so compare case-insensitively.
      const lowered = (branchA ?? []).map((a) => a.toLowerCase());
      expect(lowered).toContain('standardized_slug');
      expect(lowered).toContain('standardized_domain');
    });
  }
});

describe('entity-graph BigQuery SQL validity (dialect bugs — cluster + review-apply)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eg-bq-dialect-'));
    await writeAsymmetricFixture(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('emits no bare UNION in any BigQuery statement (invariant 4)', async () => {
    const { statements, preamble } = await compileForDialect(dir, 'bigquery');
    for (const stmt of statements) {
      expect(
        findBareUnions(stmt.sql),
        `bare UNION (BigQuery requires ALL/DISTINCT) in statement "${stmt.name}"`
      ).toEqual([]);
    }
    if (preamble !== undefined) {
      expect(findBareUnions(preamble)).toEqual([]);
    }
  });

  it('components uses a scripting loop on BigQuery and WITH RECURSIVE elsewhere (invariant 5)', async () => {
    const bigquery = await compileForDialect(dir, 'bigquery');
    const bqComponents = bigquery.statements.find((s) => s.name === 'components');
    expect(bqComponents).toBeDefined();
    // BigQuery only allows UNION ALL in a recursive CTE's recursive term,
    // which never terminates for min-label propagation — the components
    // statement must be a multi-statement script instead.
    expect(bqComponents?.sql).not.toContain('WITH RECURSIVE');
    expect(bqComponents?.sql).toContain('DECLARE _eg_changed INT64');
    expect(bqComponents?.sql).toContain('LOOP');
    // Non-convergence past the node-count bound fails loud instead of
    // silently persisting incomplete clusters.
    expect(bqComponents?.sql).toContain('SET _eg_max_iterations = (SELECT COUNT(*) + 1');
    expect(bqComponents?.sql).toContain('RAISE USING MESSAGE');
    expect(bqComponents?.tableCreated).toContain('__components');

    for (const dialect of ['duckdb', 'postgres', 'snowflake'] as SupportedDialect[]) {
      const { statements } = await compileForDialect(dir, dialect);
      const components = statements.find((s) => s.name === 'components');
      expect(components?.sql, `components on ${dialect} keeps the recursive CTE`).toContain(
        'WITH RECURSIVE'
      );
      expect(components?.sql).not.toContain('LOOP');
    }
  });

  const applyDecisions: ReviewDecisionRow[] = [
    {
      pair_id: 'pair-1',
      decision: 'merge',
      reviewer: 'agent',
      confidence: 0.9,
      status: 'applied',
      decided_at: '2026-06-01T00:00:00Z',
    },
    // reason/confidence/proposed_* left null on this row → typed-null coverage.
    { pair_id: 'pair-2', decision: 'not_match', status: 'applied' },
    { pair_id: 'pair-3', decision: 'defer', status: 'deferred' },
  ];

  it('review-apply DML never leads with WITH and types its literals (invariant 6)', async () => {
    for (const dialect of ['bigquery', 'duckdb', 'postgres', 'snowflake'] as SupportedDialect[]) {
      const statements = generateApplySql(applyDecisions, 'account', dialect, 'entity_graph', {
        defaultBatchId: 'batch-1',
        defaultDecisionSource: 'agent_auto',
      });
      expect(statements.length).toBeGreaterThan(0);
      for (const stmt of statements) {
        const firstKeyword = stmt.sql.trimStart().split(/\s+/)[0]?.toUpperCase();
        // BigQuery rejects `WITH ... INSERT/DELETE` — the CTE chain must live
        // inside the query expression on every dialect.
        expect(
          ['INSERT', 'DELETE'],
          `statement "${stmt.name}" on ${dialect} must start with DML, got "${firstKeyword}"`
        ).toContain(firstKeyword);
        expect(findBareUnions(stmt.sql), `bare UNION in "${stmt.name}" on ${dialect}`).toEqual([]);
      }
    }

    // BigQuery: bare NULL infers INT64 and string literals don't coerce to
    // TIMESTAMP in INSERT ... SELECT — both must be cast.
    const bigquery = generateApplySql(applyDecisions, 'account', 'bigquery', 'entity_graph', {
      defaultBatchId: 'batch-1',
      defaultDecisionSource: 'agent_auto',
    });
    const insert = bigquery.find((s) => s.name === 'apply_review_decisions');
    expect(insert).toBeDefined();
    expect(insert?.sql).toContain('CAST(NULL AS STRING)');
    expect(insert?.sql).toContain('CAST(NULL AS FLOAT64)');
    expect(insert?.sql).toContain("CAST('2026-06-01T00:00:00Z' AS TIMESTAMP)");
    expect(insert?.sql).not.toMatch(/(?<!CAST\()\bNULL AS\b/);
  });
});

describe('entity-graph BigQuery SQL validity (no schema.columns — live repro)', () => {
  // Mirrors account_resolution_poc: both lakehouse inputs carry no schema.columns.
  // Input A (neon_accounts) has 5 raw cols; input B (pylon_accounts) has 3 raw cols.
  // Before the fix, generateStandardizeSql emitted `src.*` per branch — UNION ALL
  // branch column counts differ → "Queries in UNION ALL have mismatched column count".
  // After the fix, raw passthrough is dropped in mixed mode so both branches are
  // uniform (bookkeeping + standardized only).

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eg-bq-nocols-'));
    await writeNoColumnsFixture(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('standardize UNION ALL branches have equal alias count when no schema.columns declared', async () => {
    const { statements } = await compileForDialect(dir, 'bigquery');
    const standardize = findStandardize(statements);
    const branches = extractUnionBranchAliases(standardize.sql);

    expect(branches.length).toBe(2);
    const [branchA, branchB] = branches;
    expect(branchA).toBeDefined();
    expect(branchB).toBeDefined();
    // Both branches must project the same columns — standardized + bookkeeping only.
    expect(branchA).toEqual(branchB);
    // No raw passthrough (no wildcard expansion in the SQL text).
    expect(standardize.sql).not.toContain('`src`.*');
  });

  it('emits no raw control chars inside string literals (no schema.columns)', async () => {
    const { statements } = await compileForDialect(dir, 'bigquery');
    for (const stmt of statements) {
      expect(
        findRawControlCharsInLiterals(stmt.sql),
        `raw control char in statement "${stmt.name}"`
      ).toEqual([]);
    }
  });
});
