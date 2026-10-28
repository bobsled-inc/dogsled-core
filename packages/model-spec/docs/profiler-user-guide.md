# Model Profiler User Guide

The model profiler is a read-only diagnostic command for Dogsled/Model Spec projects. It samples warehouse data, infers likely column meaning, and returns confidence-scored evidence that agents and humans can review before changing specs.

## Command Surface

```bash
dogsled model profile <table> [options]
dogsled model profile suggest cleaning <table> [options]
```

Options:

| Option                      | Description                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--integration <handle>`    | Select one integration. Required when the project has multiple integrations.                                                   |
| `--runner <path>`           | Use a custom query-capable runner module instead of constructing one from the integration.                                     |
| `--secrets <path>`          | YAML secret overlay used when constructing the integration runner.                                                             |
| `--sample-size <rows>`      | Number of rows to sample. Defaults to `500`; maximum is `100000`.                                                              |
| `--confidence-min <number>` | Keep only inferences, candidates, and suggestions at or above this confidence. Accepts values from `0` to `1`, including `.5`. |
| `--json`                    | Emit one JSONL-compatible payload. Auto-activates in CI, non-TTY output, or `DOGSLED_OUTPUT_FORMAT=json`.                      |
| `--quiet`                   | Suppress human status logs. JSON mode also suppresses human logs.                                                              |

## What The Profiler Queries

For each profiled table, the command issues:

```sql
SELECT COUNT(*) AS row_count FROM <resolved_table>;
SELECT * FROM <resolved_table> LIMIT <sample_size>;
```

When profiling a Model Spec model that has `columns[].references`, the command also samples referenced target models so FK inference can compare observed values.

All table identifiers are quoted per dialect. Profiler v1 accepts simple one-, two-, or three-part identifiers. It rejects unsafe table identifier text instead of passing raw SQL through.

## Table Resolution

The `<table>` argument is resolved in this order:

1. Exact Model Spec source ref, such as `ecom.raw_customers`.
2. Model Spec model name, such as `fct_orders`.
3. Fuzzy source match by source name or physical table leaf, such as `raw_customers`.
4. Direct physical table ref, such as `RAW.RAW_CUSTOMERS`.

Prefer source refs or model names when they exist. They carry column metadata from YAML and let the profiler reuse model `references` for FK target sampling.

## Runner Requirements

The profiler needs a runner with:

```ts
query(sql: string): Promise<Array<Record<string, unknown>>>;
close?(): Promise<void> | void;
```

If `--runner` is omitted, the command resolves the active integration through `@bobsled-inc/connections`. Use `--secrets` when the integration uses env-var placeholders and you want a local YAML overlay.

Custom runner modules are useful for tests, demos, and adapter development:

```js
export async function query(sql) {
  if (/COUNT\(\*\)/i.test(sql)) return [{ row_count: 100 }];
  return [{ id: 'c1', email: 'ops@example.com' }];
}
```

## Output Shape

`model profile` JSON output:

```json
{
  "command": "model.profile",
  "ok": true,
  "report": {
    "table": "RAW.RAW_CUSTOMERS",
    "rowCount": 1000,
    "sampleSize": 500,
    "columns": [],
    "pkCandidates": [],
    "fkCandidates": [],
    "cleaningSuggestions": []
  }
}
```

`model profile suggest cleaning` JSON output:

```json
{
  "command": "model.profile.suggest.cleaning",
  "ok": true,
  "table": "RAW.RAW_CUSTOMERS",
  "suggestions": []
}
```

YAML output contains the same report or suggestion payload without the JSON wrapper.

## Column Inferences

Each column includes:

- `dataType`: declared type from YAML when available, otherwise inferred from sample values.
- `nullRate`, `distinctCount`, `distinctRate`: sample-derived shape signals.
- `valueDistribution`: top sampled values and rates.
- `typeInference`: scalar kind such as `string`, `integer`, `number`, `boolean`, `timestamp`, `date`, `array`, `object`, `null`, or `mixed`.
- `formatInference`: supported string format such as `email`, `phone`, `url`, `iso8601`, `uuid`, `mixed`, or `null`.
- `semanticRoleInference`: likely semantic role such as `entity_id`, `identifier`, `name`, `email`, `phone`, `url`, `measure`, `currency`, `count`, `rate`, or timestamp roles.
- `anomalies`: detected quality signals.

Every inference has `confidence` and `evidence`. Treat confidence as a review prioritization score, not an automatic truth label.

## Key Candidates

Primary-key candidates use sample uniqueness, non-nullness, and name signals.

Foreign-key candidates use two modes:

- **Name-only mode**: for `_id` columns when no target samples are available. This produces lower-confidence review candidates.
- **Target-backed mode**: for Model Spec model columns with `references`. The profiler samples the referenced model key column and reports hit rate, target uniqueness, and name-score evidence.

Empty or null-only target key samples are ignored so an empty target table cannot produce a false FK suggestion.

## Cleaning Suggestions

The profiler emits suggestions for columns whose sample data shows a high rate of improvable values. Each suggestion includes `column`, `transforms`, `model_expr`, `confidence`, `evidence`, and `rationale`.

Confidence for cleaning suggestions ranges from **0.50** (10 % trigger rate) to **0.95** (100 % trigger rate) — the formula is `clamp(0.45 + rate × 0.5)`. Use `--confidence-min 0.7` to require a 50 %+ trigger rate before a suggestion surfaces.

### Detection triggers

Column names are normalised before matching (lowercased, separators unified). The table below shows normalised forms.

| Pattern                           | Trigger column (normalised)                                                    | Trigger rate | Transforms emitted                                                     |
| --------------------------------- | ------------------------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------- |
| Empty strings                     | any                                                                            | ≥ 10 %       | `nullif_empty`                                                         |
| Leading/trailing whitespace       | any                                                                            | ≥ 10 %       | `trim`                                                                 |
| Repeated internal whitespace      | any                                                                            | ≥ 10 %       | `collapse_whitespace`                                                  |
| Mixed email casing                | contains `email`                                                               | ≥ 10 %       | `normalize_email`                                                      |
| Email address                     | contains `email`                                                               | ≥ 60 %       | `extract_email_domain`                                                 |
| Email plus-addressing             | contains `email`                                                               | ≥ 10 %       | `strip_email_subaddress`, `normalize_email`                            |
| Mixed casing                      | contains `domain` or `name`                                                    | ≥ 10 %       | `lowercase`                                                            |
| Lowercase short codes             | `state` or ends with `_state`, and values are ≤ 3 chars with lowercase letters | ≥ 10 %       | `uppercase`                                                            |
| Legal entity suffix               | contains `company` or `account`, or equals `name`                              | ≥ 10 %       | `normalize_company`                                                    |
| Trading-as marker                 | contains `company` or `account`, or equals `name`                              | ≥ 10 %       | `strip_trading_as`, `normalize_company`                                |
| Full URL with path/query/fragment | contains `domain`, `website`, or `url`                                         | ≥ 10 %       | `extract_domain`                                                       |
| URL/protocol prefix               | contains `domain`, `website`, or `url`                                         | ≥ 10 %       | `strip_protocol`, `strip_www`, `lowercase`                             |
| Non-digit phone                   | contains `phone` or `mobile`                                                   | ≥ 10 %       | `normalize_phone`; adds `strip_phone_extension` when extensions appear |
| Accented characters               | any                                                                            | ≥ 10 %       | `strip_accents`                                                        |
| Formatted number                  | any                                                                            | ≥ 60 %       | `parse_number`                                                         |
| ISO 8601-parseable string         | does not end with `_at` or `_date`                                             | ≥ 80 %       | `parse_dates`                                                          |
| US or EU slash date               | does not end with `_at` or `_date`                                             | ≥ 80 %       | `parse_date_us` or `parse_date_eu`                                     |
| US state name or code             | `state` or ends with `_state`                                                  | ≥ 60 %       | `normalize_state`                                                      |

These are proposals. The command does not mutate source data or apply transforms. Review suggestions before turning them into model expressions or entity graph standardize rules.

## Model Expressions (`model_expr`)

Each suggestion includes a `model_expr` field: a Model Spec column expression string ready to paste into a model's `columns[].expr`. All profiler-emitted transforms now have direct Model Spec SQL mappings.

| Transform                         | Model Spec function                               |
| --------------------------------- | ------------------------------------------------- |
| `trim`                            | `trim(col)`                                       |
| `lowercase`                       | `lower(col)`                                      |
| `uppercase`                       | `upper(col)`                                      |
| `collapse_whitespace`             | `collapse_whitespace(col)`                        |
| `nullif_empty`                    | `nullif_empty(col)`                               |
| `normalize_email`                 | `normalize_email(col)`                            |
| `extract_email_domain`            | `extract_email_domain(col)`                       |
| `strip_email_subaddress`          | `strip_email_subaddress(col)`                     |
| `strip_accents`                   | `strip_accents(col)`                              |
| `normalize_company`               | `normalize_company(col)`                          |
| `strip_trading_as`                | `strip_trading_as(col)`                           |
| `strip_www` / `strip_protocol`    | `strip_www(col)`                                  |
| `extract_domain`                  | `extract_domain(col)`                             |
| `normalize_phone`                 | `normalize_phone(col)`                            |
| `strip_phone_extension`           | `strip_phone_extension(col)`                      |
| `normalize_state`                 | `normalize_state(col)`                            |
| `parse_number`                    | `parse_number(col)`                               |
| `parse_dates`                     | `parse_date(col, 'iso8601')`                      |
| `parse_date_us` / `parse_date_eu` | `parse_date(col, 'us')` / `parse_date(col, 'eu')` |

### Using suggestions

Copy a non-null `model_expr` directly into a Model Spec staging model column:

```json
{
  "column": "company_name",
  "transforms": ["strip_legal_suffixes", "lowercase", "collapse_whitespace"],
  "model_expr": "collapse_whitespace(lower(strip_legal_suffixes(company_name)))",
  "confidence": 0.9,
  "rationale": "Remove legal suffix and normalize company names",
  "evidence": {
    "sampleSize": 500,
    "examples": ["Acme Inc.", "Example LLC", "Test Corp."],
    "legalSuffixRate": 0.72,
    "casingChangedRate": 0.33
  }
}
```

```yaml
# Model Spec staging model column
columns:
  - name: company_name_clean
    expr: 'collapse_whitespace(lower(strip_legal_suffixes(company_name)))'
```

```yaml
# Entity graph standardize rule (drop parse_dates — not valid in standardize)
standardize:
  - field: company_name
    transforms: [strip_legal_suffixes, lowercase, collapse_whitespace]
```

> **`parse_dates` in entity graph specs**: `parse_dates` is a profiler-only name and is **not** a valid value in the entity graph `standardize.transforms` enum. Drop it when writing standardize rules; handle date parsing in a Model Spec staging model instead using `parse_date(col, 'iso8601')`.

## Anomalies

The profiler detects:

- `mixed_types`: incompatible scalar kinds in one column.
- `inconsistent_casing`: alphabetic strings with mixed lower/upper/title-like casing.
- `parseable_subfields`: valid JSON objects or arrays stored as strings.

The JSON subfield detector performs real `JSON.parse`; strings that merely look bracketed are ignored when invalid.

## Confidence Filtering

Use `--confidence-min` to reduce noise:

```bash
dogsled model profile fct_orders --integration ecom --confidence-min 0.9 --json
```

Filtering happens after the scan. It removes low-confidence nested inferences, candidates, and suggestions without changing `rowCount`, `sampleSize`, or the underlying sampled evidence.

## Agent Workflow

For agent-authored modeling or entity graph onboarding:

1. Run `dogsled model validate --integration <handle>`.
2. Profile candidate sources or models with `--json`.
3. Inspect high-confidence `cleaningSuggestions` before drafting standardization or model expressions.
4. Inspect `pkCandidates` and `fkCandidates` before setting `primary_key`, `grain`, or `references`.
5. Keep profiler output as evidence in the PR summary when it drove spec changes.

The dedicated skill is `.agents/skills/model-profiler/SKILL.md`.

## Limitations

- V1 is sample-based; distinctness, distributions, anomalies, and hit rates describe the sample.
- `COUNT(*)` is exact and can be expensive on very large tables.
- Direct physical table refs are limited to simple identifiers.
- Source/direct table profiling has no CLI flag to provide arbitrary FK targets; target-backed FK scoring currently comes from Model Spec model `references`.
- Cleaning proposals are not executable specs yet. Applying and auditing cleaning is Drop 3 scope.
