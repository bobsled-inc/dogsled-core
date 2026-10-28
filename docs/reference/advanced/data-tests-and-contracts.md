# Data Tests And Contracts

Dogsled's data quality surface is intentionally split into small contracts that agents can author, validate, and execute independently. Use this guide when adding new pipeline quality gates, migrating assertions from an existing ETL, or deciding which Dogsled command should own a data contract.

## Contract Layers

| Layer                         | Authoring surface                                                                            | Validation or execution                                                                        | What it protects                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Field metadata contract       | Extractor `output:` fields, Model Spec source/model columns, Entity Graph semantic overrides | Schema parsing plus semantic checks                                                            | Shared names, types, descriptions, semantic roles, PII, ownership, and quality notes |
| Extractor semantic metadata   | Integration resource YAML                                                                    | `dogsled extract validate --semantic-check` or `--semantic-check=strict`                       | Source fields are understandable before protocol records are emitted                 |
| Model semantic metadata       | Model Spec model and source YAML                                                             | `dogsled model validate --semantic-check` or `--semantic-check=strict`                         | Model columns preserve or intentionally change source semantics                      |
| Model test SQL                | Model `tests:` blocks and column constraints                                                 | `dogsled model test --integration <handle>`                                                    | Generates row-returning SQL checks for established model tests                       |
| Model expectations            | Model `expect:` blocks                                                                       | `dogsled model expect run --integration <handle>` and optionally `--runner ./runner.js --json` | Compiles or executes sentinel SQL with pass, warn, and fail statuses                 |
| Entity Graph metadata catalog | Resolution specs plus inherited Model Spec metadata and `semantic_overrides`                 | Entity Graph compile tests and dialect-aware SQL rendering                                     | Downstream identity artifacts carry machine-readable semantic context                |

For an ETL migration, preserve the old quality gate first, then map it to the nearest Dogsled layer. A dbt `not_null` or `unique` test usually maps to model `tests:` or `expect:`. A row-count threshold maps to `expect: { kind: row_count_between }`. A schema assertion maps to `schema_contains`. Cleaning transforms map to model column expressions using the built-in cleaning primitives (see the Cleaning via Models section below).

## Field Metadata Contract

Field metadata is the shared vocabulary carried through protocol, extraction, modeling, and Entity Graph surfaces. It is defined by `FieldMetadataSchema` in `@bobsled-inc/protocol`.

Required fields:

| Field  | Meaning                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| `name` | Field or column name. Extractor output and Model Spec column schemas derive this from the YAML key or column entry. |
| `type` | Canonical type: `string`, `integer`, `number`, `boolean`, `timestamp`, `date`, `array`, or `object`.                |

Optional fields:

| Field                 | Meaning                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`         | Human and agent-readable field definition. Semantic checks expect this to be present.                                                                                                                         |
| `semantic_role`       | Canonical role: `entity_id`, `measure`, `event_timestamp`, `extraction_timestamp`, `time_dimension`, `categorical`, `identifier`, `name`, `address`, `email`, `phone`, `url`, `currency`, `count`, or `rate`. |
| `tags`                | Free-form metadata tags.                                                                                                                                                                                      |
| `unit`                | Unit for measures, counts, rates, currency, or duration values.                                                                                                                                               |
| `format`              | Expected field format, such as an external ID pattern or timestamp format.                                                                                                                                    |
| `pii`                 | Whether the field contains personally identifiable information.                                                                                                                                               |
| `enum_values`         | Known categorical values.                                                                                                                                                                                     |
| `examples`            | Representative example values.                                                                                                                                                                                |
| `references`          | Human-readable pointer to a source system, table, or business definition.                                                                                                                                     |
| `business_rule`       | Business logic that defines or constrains the field.                                                                                                                                                          |
| `quality_notes`       | Known data quality caveats.                                                                                                                                                                                   |
| `owner`               | Owning team or role.                                                                                                                                                                                          |
| `deprecated`          | Whether the field should be avoided in new work.                                                                                                                                                              |
| `embedding_candidate` | Whether the field is a good candidate for vector embedding.                                                                                                                                                   |

Entity Graph semantic overrides intentionally cannot change `name` or `type`; they can only refine optional metadata fields. That keeps source and model contracts stable while allowing entity-specific descriptions, roles, ownership, or quality notes.

## Semantic Checks

Semantic checks are lightweight contract checks for metadata completeness and drift. They do not query live data.

Extractor validation:

```bash
dogsled extract validate <integration> --semantic-check
dogsled extract validate <integration> --semantic-check=strict --format json
```

Extractor semantic checks inspect every resource `output:` field. They warn when `description` or `semantic_role` is missing, and role warnings include an inferred candidate when Dogsled can infer one from the field name and type. In strict mode, semantic findings fail validation with exit code `2`.

Model validation:

```bash
dogsled model validate --integration <handle> --semantic-check
dogsled model validate --integration <handle> --semantic-check=strict
```

Model semantic checks inspect source and model columns. They report missing descriptions, missing semantic roles, and direct-projection divergence where a model column's description or semantic role differs from the source column it selects. In warn mode these are warnings; in strict mode they become validation errors.

Use strict mode for CI or pre-cutover gates. Use warn mode during early profiling when agents are still filling in metadata.

## Model `tests:` SQL

Model `tests:` blocks generate SQL that returns failing rows. A passing test returns zero rows. The command prints SQL only; execution is left to the caller or orchestration layer.

```bash
dogsled model test --integration duckdb
dogsled model test stg_orders --integration duckdb
```

Supported explicit test types:

| Type              | Required fields    | Generated behavior                                                    |
| ----------------- | ------------------ | --------------------------------------------------------------------- |
| `not_null`        | `column`           | Rows where the column is null.                                        |
| `unique`          | `column`           | Duplicate column values with counts greater than one.                 |
| `accepted_values` | `column`, `values` | Rows where the column is outside the accepted set.                    |
| `custom`          | `sql`              | User SQL with `{name}` replaced by the dialect-qualified model table. |

Column constraints also generate tests: `primary_key: true` emits `not_null` and `unique`, while `not_null: true` emits `not_null`.

```yaml
columns:
  - name: order_id
    type: string
    primary_key: true
    description: Stable source order ID.
    semantic_role: entity_id

tests:
  - type: accepted_values
    column: status
    values: [pending, shipped, delivered]
  - type: custom
    sql: 'SELECT * FROM {name} WHERE amount < 0'
```

Use `tests:` when you want generated SQL that another runner, warehouse worksheet, or external orchestrator will execute.

## Model `expect:` Sentinels

Model expectations compile to sentinel SQL that returns exactly one `violation_count`. They can also execute through a small query runner module. This makes them the best fit for agent-readable pass, warn, and fail quality gates.

Compile without executing:

```bash
dogsled model expect run --integration duckdb
dogsled model expect run --integration duckdb --model stg_customers
```

Execute with a runner:

```bash
dogsled model expect run --integration duckdb --runner ./runner.js --json
```

Runner module contract:

```js
export async function query(sql) {
  // Return an array of rows. The first row must expose violation_count.
  return [{ violation_count: 0 }];
}
```

Expectation statuses:

| Status   | Meaning                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passed` | Query executed and `violation_count` was `0`.                                                                                                      |
| `warned` | Query executed, `violation_count` was nonzero, and `severity: warn` was set. The command remains `ok: true`.                                       |
| `failed` | Query execution failed, did not return `violation_count`, or returned nonzero violations for an error-severity expectation. The command exits `2`. |

Default severity is `error`. Set `severity: warn` only for soft thresholds that should be visible but not block a pipeline.

Supported expectation kinds:

| Kind                | Required fields              | Notes                                                                                                                          |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `primary_key`       | `columns`                    | Checks nulls across every key column and duplicate grouped key rows.                                                           |
| `non_null`          | `column`                     | Counts null values.                                                                                                            |
| `unique`            | `columns`                    | Counts duplicate grouped values.                                                                                               |
| `in_range`          | `column`, `min` and/or `max` | Counts values below `min` or above `max`.                                                                                      |
| `regex`             | `column`, `pattern`          | Emits dialect-specific regex SQL for Snowflake, BigQuery, Postgres, DuckDB, Databricks, and MySQL-family targets.              |
| `schema_contains`   | `columns`                    | Compile-time expectation over the resolved model output schema, including inherited, excluded, projected, and derived columns. |
| `row_count_between` | `min` and/or `max`           | Counts whether table row count is outside the allowed range.                                                                   |
| `accepted_values`   | `column`, `values`           | Counts non-null values outside the accepted set.                                                                               |
| `expression`        | `expression`                 | Counts rows where `NOT (<expression>)`; dangerous SQL constructs are rejected during schema validation.                        |
| `custom`            | `sql`                        | SQL must select a column aliased as `violation_count`; `{model}` expands to the dialect-qualified model table.                 |

Example:

```yaml
expect:
  - kind: primary_key
    columns: [customer_id]
  - kind: non_null
    column: email
  - kind: regex
    column: email
    pattern: '^[^@]+@[^@]+\\.[^@]+$'
    severity: warn
  - kind: row_count_between
    min: 1
  - kind: schema_contains
    columns: [customer_id, email, status]
  - kind: custom
    sql: |
      SELECT COUNT(*) AS violation_count
      FROM {model}
      WHERE lifetime_value < 0
```

JSON output includes `command`, `ok`, `executed`, `warnings`, `skipped`, and one entry per expectation with `handle`, `dialect`, `model_name`, `kind`, `target`, `severity`, `executed`, `status`, `violation_count`, `sql`, and `error` when applicable.

## Cleaning via Models

Cleaning transforms are expressed as regular Model Spec models using built-in cleaning expression functions. This keeps cleaning within the modeling layer — a staging model is the right abstraction for messy source data.

```yaml
spec_version: '0.2'
name: stg_customers
type: model
description: Staged and cleaned customer records.
grain: customer_id
source:
  ref: shopify.raw_customers
  # rename raw column names using column expr
columns:
  - name: customer_id
    expr: Customer_ID
  - name: email
    expr: 'normalize_email(Email)'
  - name: company_name
    expr: 'normalize_company(Name)'
  - name: created_at
    expr: "parse_date(created_at_raw, 'iso8601')"
  - name: email_domain
    expr: 'extract_email_domain(normalize_email(Email))'
where: 'lower(trim(Email)) is not null'
dedupe:
  keys: [customer_id]
  strategy: keep_first
  order_by:
    - column: created_at
      direction: desc
materialization:
  type: table
```

Built-in cleaning functions available in column `expr` fields:

| Function                      | Effect                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `collapse_whitespace(col)`    | Collapse runs of whitespace into one space.                                                                     |
| `nullif_empty(col)`           | Trim and convert empty strings to `NULL`.                                                                       |
| `normalize_email(col)`        | Lowercase and trim email values.                                                                                |
| `extract_email_domain(col)`   | Extract the domain from an email address.                                                                       |
| `strip_email_subaddress(col)` | Remove plus-addressing before `@`.                                                                              |
| `strip_accents(col)`          | Remove common accents/diacritics.                                                                               |
| `strip_legal_suffixes(col)`   | Remove terminal Inc., LLC, Ltd., Corp., Co., etc.                                                               |
| `strip_trading_as(col)`       | Remove d/b/a, dba, trading as, and t/a aliases.                                                                 |
| `normalize_company(col)`      | Trim, strip legal suffix, lowercase, and collapse whitespace.                                                   |
| `strip_www(col)`              | Remove `http://`, `https://`, and `www.` prefixes.                                                              |
| `extract_domain(col)`         | Extract host/domain from a full URL.                                                                            |
| `digits_only(col)`            | Keep only `0–9` digits.                                                                                         |
| `strip_country_code(col)`     | Remove leading US/Canada `1` from 11-digit phone strings.                                                       |
| `strip_phone_extension(col)`  | Remove phone extension suffixes.                                                                                |
| `normalize_phone(col)`        | Apply `digits_only` and `strip_country_code`.                                                                   |
| `normalize_state(col)`        | Normalize US state names/codes to two-letter codes.                                                             |
| `remove_punctuation(col)`     | Remove punctuation, leaving letters, digits, and spaces.                                                        |
| `fingerprint(col)`            | Build an OpenRefine-style sorted/deduped token key.                                                             |
| `parse_number(col)`           | Parse formatted numeric strings such as `$1,234.56`.                                                            |
| `parse_date(col, 'format')`   | Parse dates/timestamps; supports `iso8601`, `timestamp`, `date`, `unix_seconds`, `unix_millis`, `us`, and `eu`. |

All cleaning functions are compiled to dialect-specific SQL and work across all Model Spec compiler targets (Snowflake, BigQuery, Databricks, Postgres, DuckDB, MySQL).

Model `where:` handles row filtering and `dedupe:` handles deduplication (compiled to `QUALIFY ROW_NUMBER() OVER (...)` on dialects that support it). Column renaming is standard Model Spec column `name` + `expr` mapping.

The profiler's suggest cleaning command outputs `model_expr` for each suggestion — a ready-to-use Model Spec column expression that agents can drop directly into a staging model:

```bash
dogsled model profile suggest cleaning raw.customers --integration duckdb --json
```

## Entity Graph Metadata Catalog

Entity Graph resolution specs consume the same field metadata contract. When Model Spec source metadata is available, Entity Graph inherits metadata for profile and attribute fields. Resolution specs can add `semantic_overrides` for entity-specific descriptions, roles, tags, owners, and quality notes.

The compiler emits metadata catalog SQL with dialect-appropriate JSON storage:

| Dialect family          | Metadata type |
| ----------------------- | ------------- |
| Snowflake               | `VARIANT`     |
| BigQuery, DuckDB, MySQL | `JSON`        |
| Postgres and pgvector   | `JSONB`       |
| Redshift                | `SUPER`       |
| Databricks              | `STRING`      |

Use this catalog as a downstream contract for review queues, survivorship, and agent task profiles: agents should be able to discover what each entity attribute means without reading the original source YAML.

## Recommended Agent Workflow

1. Author or import field metadata at the earliest source boundary.
2. Run extractor validation with `--semantic-check=strict` before relying on resource output in downstream specs.
3. Preserve existing ETL quality gates by mapping them to `tests:`, `expect:`, or staging model cleaning expressions.
4. Run `dogsled model validate --semantic-check=strict` before compiling or executing models.
5. Use `dogsled model test` for generated SQL review and `dogsled model expect run --runner ./runner.js --json` for executable quality gates.
6. Use `dogsled model profile suggest cleaning <table> --integration <handle> --json` to get `model_expr` suggestions for noisy source columns — drop these into a staging model.
7. Keep non-Dogsled assertions external until they have an equivalent Dogsled contract; document that gap in the handoff or PR.
