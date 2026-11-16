/**
 * Regression: `incremental_filter` must go through the same ref → alias
 * substitution as `expr`, `on`, `where`, `having`, `qualify`, etc.
 *
 * Before this fix, a filter like `stg_customers.signup_date > self.signup_date`
 * compiled to `STG_CUSTOMERS.SIGNUP_DATE > ...` and every dialect errored out
 * because the SELECT renamed `stg_customers` to `t0` in the FROM clause —
 * `STG_CUSTOMERS.SIGNUP_DATE` was an unknown identifier. The host application's
 * `customer_summary` and `ecom_orders_enriched` models hit this in production
 * dev runs (see PR thread, 2026-05-27).
 *
 * `cursor_field` gets the same substitute() routing for consistency, but the
 * spec schema already constrains it to a bare identifier — the broken dotted
 * form can't reach the parser in the first place. The companion test pins
 * the defensive no-op so future schema relaxation doesn't silently regress.
 */
import { describe, expect, it } from 'vitest';

import { generateSelectSql, generateSql } from '../../../src/compiler/codegen.js';
import { buildModelRegistry, parseTransformSpecFromParsed } from '../../../src/compiler/parser.js';
import { TransformSpecSchema } from '../../../src/compiler/schemas.js';

import type { ModelRegistry, SourceRegistry } from '../../../src/compiler/parser.js';

const SOURCE_REGISTRY: SourceRegistry = new Map([
  ['ecom.raw_customers', 'RAW.RAW_CUSTOMERS'],
  ['ecom.raw_orders', 'RAW.RAW_ORDERS'],
]);

const MODEL_REGISTRY: ModelRegistry = buildModelRegistry(
  ['stg_customers', 'stg_orders'],
  'ANALYTICS'
);

/**
 * Build a spec like the failing AI-app `customer_summary` — incremental,
 * sourced from `stg_customers`, left-joined with `stg_orders`, and filtering
 * via a `<sourceref>.<col>` identifier inside `incremental_filter`.
 */
function buildIncrementalSpec(overrides?: { incrementalFilter?: string }) {
  const incrementalFilter =
    overrides?.incrementalFilter ??
    "stg_customers.signup_date > (SELECT COALESCE(MAX(signup_date), DATE '1970-01-01') FROM self)";

  return TransformSpecSchema.parse({
    spec_version: '0.2',
    name: 'customer_summary',
    type: 'model',
    description: 'Test fixture.',
    grain: 'customer_id',
    source: { ref: 'stg_customers' },
    joins: [
      {
        ref: 'stg_orders',
        type: 'left',
        on: 'stg_customers.customer_id = stg_orders.customer_id',
      },
    ],
    columns: [
      {
        name: 'customer_id',
        expr: 'stg_customers.customer_id',
        primary_key: true,
        type: 'integer',
      },
      { name: 'signup_date', expr: 'stg_customers.signup_date', type: 'timestamp' },
      { name: 'last_order_at', expr: 'stg_orders.order_date', type: 'timestamp' },
    ],
    materialization: {
      type: 'incremental',
      strategy: 'merge',
      unique_key: 'customer_id',
      incremental_filter: incrementalFilter,
      on_schema_change: 'fail',
    },
  });
}

describe('incremental_filter authored vs substituted forms', () => {
  // Regression: persisting the substituted form to `ModelRunState` made
  // drift detection a false positive every time the user added/reordered
  // joins (which shifts `t{n}` indices) and a one-time false positive
  // every time the alias-resolution wiring changed across Bobsled Core versions.
  // The fix keeps `incremental_filter` substituted for codegen and adds
  // `authored_incremental_filter` (raw YAML form) for state persistence.

  it('exposes both authored and substituted forms on the resolved spec', () => {
    const result = parseTransformSpecFromParsed(
      buildIncrementalSpec(),
      SOURCE_REGISTRY,
      MODEL_REGISTRY
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Codegen consumer reads `incremental_filter` (alias-resolved).
    expect(result.spec.materializationConfig?.incremental_filter).toContain('t0.signup_date');
    // State-persistence consumer reads `authored_incremental_filter`
    // (untouched authored form).
    expect(result.spec.materializationConfig?.authored_incremental_filter).toContain(
      'stg_customers.signup_date'
    );
    expect(result.spec.materializationConfig?.authored_incremental_filter).not.toContain(
      't0.signup_date'
    );
  });

  it('produces a stable authored form across parse cycles for the same YAML', () => {
    // The round-trip property the user called out: two parses of the
    // same authored spec must produce byte-identical authored_*
    // strings. The substituted form would also be equal here (since
    // alias mapping is deterministic on the same source/joins shape),
    // but the authored form is what matters for cross-version stability.
    const r1 = parseTransformSpecFromParsed(
      buildIncrementalSpec(),
      SOURCE_REGISTRY,
      MODEL_REGISTRY
    );
    const r2 = parseTransformSpecFromParsed(
      buildIncrementalSpec(),
      SOURCE_REGISTRY,
      MODEL_REGISTRY
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    expect(r1.spec.materializationConfig?.authored_incremental_filter).toBe(
      r2.spec.materializationConfig?.authored_incremental_filter
    );
  });
});

describe('incremental_filter ref-to-alias substitution', () => {
  it('rewrites <sourceref>.<col> to t0.<col> in the resolved spec', () => {
    const result = parseTransformSpecFromParsed(
      buildIncrementalSpec(),
      SOURCE_REGISTRY,
      MODEL_REGISTRY
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const filter = result.spec.materializationConfig?.incremental_filter ?? '';
    expect(filter).toContain('t0.signup_date');
    expect(filter).not.toContain('stg_customers.signup_date');
  });

  it('rewrites <joinref>.<col> to t1.<col>', () => {
    const result = parseTransformSpecFromParsed(
      buildIncrementalSpec({
        incrementalFilter:
          "stg_orders.order_date > (SELECT COALESCE(MAX(order_date), DATE '1970-01-01') FROM self)",
      }),
      SOURCE_REGISTRY,
      MODEL_REGISTRY
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const filter = result.spec.materializationConfig?.incremental_filter ?? '';
    expect(filter).toContain('t1.order_date');
    expect(filter).not.toContain('stg_orders.order_date');
  });

  it('leaves identifiers inside the `self` subquery untouched', () => {
    // The bare `MAX(signup_date)` inside the SELECT subquery references the
    // destination table's columns, not the source CTE. Ref substitution must
    // not touch it. (Word-boundary-anchored regex on `<refname>.` already
    // guarantees this for bare columns, but the test pins the contract.)
    const result = parseTransformSpecFromParsed(
      buildIncrementalSpec(),
      SOURCE_REGISTRY,
      MODEL_REGISTRY
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const filter = result.spec.materializationConfig?.incremental_filter ?? '';
    expect(filter).toContain('MAX(signup_date)');
    expect(filter).toContain('FROM self');
  });

  it('end-to-end SELECT WHERE clause uses the dialect-cased alias', () => {
    const result = parseTransformSpecFromParsed(
      buildIncrementalSpec(),
      SOURCE_REGISTRY,
      MODEL_REGISTRY
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // `self` substitution happens in codegen, gated on `targetSchema`.
    const select = generateSelectSql(result.spec, 'snowflake', undefined, {
      targetSchema: 'PUBLIC',
    });
    // T0 (the source alias) — uppercased per Snowflake casing.
    expect(select).toMatch(/\bT0\.SIGNUP_DATE\b/);
    // The bug surface: the bare ref must NOT appear in the rendered SQL.
    expect(select).not.toMatch(/\bSTG_CUSTOMERS\.SIGNUP_DATE\b/);
    // `self` resolved to the destination FQN.
    expect(select).toContain('"PUBLIC"."CUSTOMER_SUMMARY"');
  });

  it('full MERGE DDL keeps the WHERE clause aliased on the second run', () => {
    // The user's bug report shows the failure occurring during the
    // second-run MERGE path. Compile the full DDL with isFirstRun=false to
    // mirror that — `incremental_filter` lands inside the merge USING
    // subquery and must already be alias-substituted by the time we get
    // here.
    const result = parseTransformSpecFromParsed(
      buildIncrementalSpec(),
      SOURCE_REGISTRY,
      MODEL_REGISTRY
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sql = generateSql(result.spec, 'PUBLIC', 'snowflake', undefined, {
      isFirstRun: false,
    });
    expect(sql).toContain('MERGE INTO');
    expect(sql).toMatch(/\bT0\.SIGNUP_DATE\b/);
    expect(sql).not.toMatch(/\bSTG_CUSTOMERS\.SIGNUP_DATE\b/);
  });

  // ---------------------------------------------------------------------
  // Cross-dialect verification.
  //
  // The substitution itself is dialect-agnostic (a regex string rewrite in
  // the parser, before codegen), but the substituted `t0`/`t1` alias then
  // flows through each dialect's AST emitter. This matrix proves the
  // round-trip end-to-end on every dialect Bobsled Core ships, against all three
  // incremental strategies. The pre-fix behavior would have leaked the
  // bare `stg_customers.signup_date` into every WHERE clause regardless
  // of dialect — we negate that.
  // ---------------------------------------------------------------------
  // Bobsled Core's AST emitter doesn't quote identifiers inside WHERE clauses on
  // any dialect (column quoting is only applied in the SELECT projection
  // and FROM-clause table refs). What changes per-dialect is identifier
  // *casing*: Snowflake uppercases, every other dialect lowercases. The
  // pre-fix behavior would leak the original `stg_customers.signup_date`
  // (uppercased on Snowflake) into the WHERE — we negate that and assert
  // the substituted alias instead.
  const DIALECT_CASES = [
    {
      dialect: 'snowflake' as const,
      expectedAlias: /\bT0\.SIGNUP_DATE\b/,
      forbiddenRef: /\bSTG_CUSTOMERS\.SIGNUP_DATE\b/,
    },
    {
      dialect: 'bigquery' as const,
      expectedAlias: /\bt0\.signup_date\b/,
      forbiddenRef: /\bstg_customers\.signup_date\b/,
    },
    {
      dialect: 'postgres' as const,
      expectedAlias: /\bt0\.signup_date\b/,
      forbiddenRef: /\bstg_customers\.signup_date\b/,
    },
    {
      dialect: 'duckdb' as const,
      expectedAlias: /\bt0\.signup_date\b/,
      forbiddenRef: /\bstg_customers\.signup_date\b/,
    },
    {
      dialect: 'databricks' as const,
      expectedAlias: /\bt0\.signup_date\b/,
      forbiddenRef: /\bstg_customers\.signup_date\b/,
    },
    {
      dialect: 'mysql' as const,
      expectedAlias: /\bt0\.signup_date\b/,
      forbiddenRef: /\bstg_customers\.signup_date\b/,
    },
  ];

  const STRATEGIES = ['merge', 'delete_insert', 'append'] as const;

  for (const { dialect, expectedAlias, forbiddenRef } of DIALECT_CASES) {
    for (const strategy of STRATEGIES) {
      it(`${dialect} + ${strategy}: WHERE clause uses the alias on the second run`, () => {
        const incrementalFilter =
          strategy === 'append'
            ? "stg_customers.signup_date > '2026-01-01'" // simple form; append doesn't tolerate `self`-subqueries on every dialect
            : "stg_customers.signup_date > (SELECT COALESCE(MAX(signup_date), DATE '1970-01-01') FROM self)";

        const spec = TransformSpecSchema.parse({
          spec_version: '0.2',
          name: 'customer_summary',
          type: 'model',
          description: `dialect-matrix fixture (${dialect}, ${strategy})`,
          grain: 'customer_id',
          source: { ref: 'stg_customers' },
          joins: [],
          columns: [
            {
              name: 'customer_id',
              expr: 'stg_customers.customer_id',
              primary_key: true,
              type: 'integer',
            },
            {
              name: 'signup_date',
              expr: 'stg_customers.signup_date',
              type: 'timestamp',
            },
          ],
          materialization: {
            type: 'incremental',
            strategy,
            unique_key: 'customer_id',
            incremental_filter: incrementalFilter,
            on_schema_change: 'fail',
          },
        });

        const result = parseTransformSpecFromParsed(spec, SOURCE_REGISTRY, MODEL_REGISTRY);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const sql = generateSql(result.spec, 'analytics', dialect, undefined, {
          isFirstRun: false,
        });

        // The alias rewrite is what we're verifying — pre-fix, the bare
        // ref would leak through to every dialect.
        expect(sql).toMatch(expectedAlias);
        expect(sql).not.toMatch(forbiddenRef);
      });
    }
  }

  it('round-trips a bare cursor_field unchanged through substitute()', () => {
    // The schema explicitly constrains `cursor_field` to a bare identifier
    // (regex `/^[a-zA-Z_]\w*$/`), so the dotted form that breaks
    // `incremental_filter` never reaches the parser here. The substitution is
    // still routed through `substitute()` for consistency with
    // `incremental_filter` and as a defensive no-op if the schema is ever
    // relaxed to accept dotted refs — this test pins that the no-op stays
    // a no-op for bare identifiers.
    const spec = TransformSpecSchema.parse({
      spec_version: '0.2',
      name: 'customer_summary',
      type: 'model',
      description: 'cursor_field substitution test.',
      grain: 'customer_id',
      source: { ref: 'stg_customers' },
      joins: [],
      columns: [
        {
          name: 'customer_id',
          expr: 'stg_customers.customer_id',
          primary_key: true,
          type: 'integer',
        },
        { name: 'signup_date', expr: 'stg_customers.signup_date', type: 'timestamp' },
      ],
      materialization: {
        type: 'incremental',
        strategy: 'append',
        unique_key: 'customer_id',
        cursor_field: 'signup_date',
        incremental_filter: 'signup_date > self',
        on_schema_change: 'fail',
      },
    });
    const result = parseTransformSpecFromParsed(spec, SOURCE_REGISTRY, MODEL_REGISTRY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.spec.materializationConfig?.cursor_field).toBe('signup_date');
  });
});
