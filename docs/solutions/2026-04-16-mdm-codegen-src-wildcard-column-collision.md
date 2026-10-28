# MDM Standardize Codegen: `src.*` Wildcard Causes Duplicate Column Names

## Problem

The entity resolution standardize step generates a `SELECT` that adds MDM metadata columns (`record_id`, `source_ref`, `source_pk_json`, `_source_system`, `_source_entity_id`, `_standardized_at`, `standardized_*`) and then appends `src.*` to carry all source table columns through.

If the source table contains a column named `record_id` (common for CRM/ERP sources), the resulting SELECT produces two columns with the same name. DuckDB and Postgres throw an error; Snowflake and BigQuery silently produce ambiguous output, and downstream `JOIN ... ON a.record_id = b.record_id` becomes non-deterministic.

```sql
-- Generated before fix (dangerous):
SELECT
  MD5(...) AS record_id,       -- MDM metadata column
  'crm' AS _source_system,
  ...
  src.*                        -- may include src.record_id → duplicate!
FROM crm_contacts src
```

## Solution

When the source column list is known at codegen time (available from the resolver's `sourceColumns`), emit explicit `src."col" AS "col"` for each non-colliding column instead of `src.*`. Colliding columns (those whose name matches a metadata column) are silently excluded from the `src.*` expansion — they are already represented by the MDM-generated version.

```sql
-- Generated after fix (safe):
SELECT
  MD5(...) AS record_id,       -- MDM metadata column
  'crm' AS _source_system,
  ...
  src."email" AS "email",      -- safe: not a metadata column name
  src."company" AS "company"   -- safe: not a metadata column name
  -- src."record_id" excluded: would duplicate MDM's record_id
FROM crm_contacts src
```

When `sourceColumns` is unavailable (backward compatibility / unknown schema), the codegen falls back to `src.*` with a code comment warning.

The column list flows through:

1. `buildSourceRegistry` in `parser.ts` → populates `SourceColumnRegistry` from spec schema
2. `resolveResolutionSpec` → propagates `sourceColumns` to each `ResolvedInput`
3. `generateStandardizeSql` → uses `input.sourceColumns` to emit explicit column list

## Why This Matters

`src.*` in a SELECT is convenient but fragile whenever computed columns are added before the wildcard. MDM resolution adds a fixed set of well-known metadata column names (`record_id`, `source_ref`, etc.) that are very likely to exist in real source schemas. Any new MDM metadata column added to the standardize output is a potential future collision.

The general pattern: when a codegen function adds named columns before a wildcard SELECT, enumerate the wildcard columns explicitly and exclude any that collide with the named columns. This is especially important for SQL targets (DuckDB, Postgres) that enforce column name uniqueness at the statement level.
