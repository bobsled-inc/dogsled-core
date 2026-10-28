# Model Profiler Quick Start

Use `dogsled model profile` when you want a fast, read-only scan of a warehouse table or Model Spec model before authoring model specs, cleaning rules, or entity graph configs.

The profiler runs two SQL queries through the active integration or a custom runner:

1. `SELECT COUNT(*) ...`
2. `SELECT * ... LIMIT <sample-size>`

It then emits a confidence-scored report with column inferences, key candidates, anomalies, and cleaning suggestions.

## Prerequisites

- A Dogsled/Model Spec project with `integrations/`, `sources/`, and optionally `models/`.
- An integration that can run warehouse SQL, or a custom runner module with `query(sql)`.
- The unified CLI (`dogsled model ...` or `dogsled model ...`) or the standalone `model` binary.

## 1. Validate the project

```bash
dogsled model validate --integration <handle>
```

Fix validation errors before profiling. The profiler can resolve Model Spec source refs and model refs only when the project loads cleanly.

## 2. Profile a source table

Use the source ref from `sources/<connection>/<name>.yml`:

```bash
dogsled model profile ecom.raw_customers --integration ecom --json
```

Useful flags:

```bash
dogsled model profile ecom.raw_customers \
  --integration ecom \
  --sample-size 1000 \
  --confidence-min 0.8 \
  --json
```

- `--sample-size` defaults to `500` and is capped at `100000`.
- `--confidence-min` filters nested inferences, key candidates, and cleaning suggestions without changing the scan.
- `--json` emits one machine-readable JSON line. YAML is used for human output.

## 3. Profile a Model Spec model

Use the model name from `models/<name>.yml`:

```bash
dogsled model profile fct_orders --integration ecom --json
```

When the model has column `references`, the CLI samples the referenced target model and passes those values into FK inference. For example:

```yaml
columns:
  - name: CUSTOMER_ID
    expr: stg_orders.CUSTOMER_ID
    references: stg_customers.CUSTOMER_ID
```

Profiling `fct_orders` can then emit an evidence-backed FK candidate from `CUSTOMER_ID` to `stg_customers.CUSTOMER_ID` with a sampled `hitRate`.

## 4. Ask only for cleaning suggestions

```bash
dogsled model profile suggest cleaning ecom.raw_customers \
  --integration ecom \
  --confidence-min 0.9 \
  --json
```

Cleaning suggestions are proposals only. They do not rewrite data or apply a clean spec. Use them to guide model authoring, entity graph onboarding, or a reviewed follow-up cleaning layer.

## 5. Smoke-test with a custom runner

For local demos or tests, pass a runner file with `query(sql)`:

```js
// profile-runner.mjs
export async function query(sql) {
  if (/COUNT\(\*\)/i.test(sql)) return [{ row_count: 3 }];
  return [
    { ID: 1, NAME: 'Acme Inc.', EMAIL: 'FOUNDER@ACME.COM.example.com ' },
    { ID: 2, NAME: 'Example LLC', EMAIL: 'ops@example.com' },
    { ID: 3, NAME: 'Test Corporation', EMAIL: 'bad-email' },
  ];
}
```

```bash
dogsled model profile raw_customers \
  --runner ./profile-runner.mjs \
  --integration ecom \
  --json
```

## Read The Report

Top-level fields:

- `table`: resolved table that was sampled.
- `rowCount`: exact row count returned by the runner.
- `sampleSize`: number of sampled rows actually returned.
- `columns`: per-column summaries and inferences.
- `pkCandidates`: possible primary keys.
- `fkCandidates`: possible foreign keys.
- `cleaningSuggestions`: deterministic v1 cleaning proposals.

Each inference includes:

- `kind`: inferred type, format, or semantic role.
- `confidence`: number from `0` to `1`.
- `evidence`: sample counts, match rates, examples, and explanatory signals.

### Cleaning suggestion output

Each `cleaningSuggestions` entry has this shape:

```json
{
  "column": "company_name",
  "transforms": ["strip_legal_suffixes", "lowercase", "collapse_whitespace"],
  "model_expr": "collapse_whitespace(lower(strip_legal_suffixes(company_name)))",
  "confidence": 0.9,
  "rationale": "Remove legal suffix and normalize company names",
  "evidence": {
    "sampleSize": 500,
    "examples": ["Acme Inc.", "Example LLC", "Test  Corp."],
    "legalSuffixRate": 0.72,
    "casingChangedRate": 0.33
  }
}
```

`model_expr` is a ready-to-use Model Spec column expression. It is `null` when the transform set has no direct SQL mapping — for example, `normalize_state` (requires a 51-entry state lookup):

```json
{
  "column": "billing_state",
  "transforms": ["normalize_state"],
  "model_expr": null,
  "confidence": 0.72,
  "rationale": "Normalize US state names and abbreviations",
  "evidence": { "sampleSize": 500, "stateRate": 0.95 }
}
```

When `model_expr` is `null`: skip it, hand-author a `raw_sql()` expression, or use the `transforms` list directly in an entity graph `standardize` block. See the [Profiler User Guide](profiler-user-guide.md#model-expressions-model_expr) for the full transform coverage table.

To promote a non-null suggestion into a Model Spec model column:

```yaml
columns:
  - name: company_name_clean
    expr: 'collapse_whitespace(lower(strip_legal_suffixes(company_name)))'
```

To promote into an entity graph `standardize` rule (note: drop `parse_dates` — it is not valid in the standardize enum):

```yaml
standardize:
  - field: company_name
    transforms: [strip_legal_suffixes, lowercase, collapse_whitespace]
```

## Next Steps

- For full behavior and limitations, read [Profiler User Guide](profiler-user-guide.md).
- For agents, use the repo skill `.agents/skills/model-profiler/SKILL.md`.
- For entity graph onboarding, run profiler suggestions before drafting resolution fields so cleaning candidates are visible early.
