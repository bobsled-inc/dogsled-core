---
name: bobsled-author-model-spec-vq
description: Author a Model Spec verified query (VQ) — a
  natural-language-question-to-SQL pairing the query planner treats as ground
  truth for NL retrieval. Covers `{ref}` tokens, optional parameters, and
  connection pinning.
---

# Author a Model Spec verified query (VQ)

Use this skill when a user wants to record a canonical SQL answer to
a natural-language question — typically because the query planner
keeps producing inconsistent or wrong SQL for that question and the
team wants to pin a verified version as ground truth.

VQs are **metadata entities**: they don't produce DDL. The compiler
parses them, validates their `{ref}` tokens, and emits them as JSON
alongside SQL when `--include-metadata` is set. The host application reads them
out of the `verified_queries` table for NL → SQL retrieval.

## Where the file goes

Place each VQ in its own file under the project's `vqs/` directory
(configurable via `vqs_dir` in `model-spec.yml`, defaults to `vqs/`). One VQ
per file.

## Schema (canonical)

```yaml
spec_version: '0.2'
type: vq
name: <identifier> # must match identifierRegex; required
description: Optional longer explanation

nlq: What was the natural-language question? # required; short (~one sentence)

sql: | # required; SQL with {ref} tokens
  SELECT customer_id, SUM(order_total) AS revenue
  FROM {fct_orders}
  GROUP BY customer_id

parameters: # optional; runtime-bound parameters
  - name: start_date
    type: date
    required: true # default true
    description: Inclusive lower bound on order_date
  - name: limit
    type: integer
    required: false
    default: 10

connection: <integration_handle> # optional; pin VQ to one warehouse
tags: # optional
  - revenue
  - shop-demo
```

**Required:** `spec_version`, `type`, `name`, `nlq`, `sql`.

## `{ref}` token rules

VQ SQL uses `{ref}` tokens that the compiler resolves to qualified
identifiers. Two forms:

| Token                      | Resolves to                                               |
| -------------------------- | --------------------------------------------------------- |
| `{model_name}`             | The Model Spec model identifier (e.g. `{fct_orders}`)     |
| `{connection.source_name}` | A Model Spec source identifier (e.g. `{ecom.raw_orders}`) |

`validateMetadataReferences` (run as part of `dogsled model validate`)
asserts every token resolves. Tokens inside single-quoted strings,
double-quoted identifiers, `--` line comments, and `/* ... */` block
comments are correctly ignored by the tokenizer.

Parameter types: `string`, `integer`, `number`, `boolean`,
`timestamp`, `date`. `type` is advisory — the caller binds parameters
at query time and decides coercion.

## Workflow

1. **Phrase the NL question.** Write `nlq:` as a short user-facing
   sentence (≤ ~10 words is typical). The agent matches against this
   when retrieving.
2. **Write the canonical SQL.** Replace every hardcoded table name
   with a `{ref}` token. Prefer model refs (`{fct_orders}`) over
   source refs (`{ecom.raw_orders}`) so the VQ travels with the
   curated layer.
3. **Add parameters if the SQL needs runtime values.** Don't inline
   the values; parameterize them. The runtime binder handles
   substitution.
4. **Pin a connection if the SQL is dialect-specific.** Most VQs
   should be portable, but if the SQL uses warehouse-specific syntax
   (e.g. Snowflake `QUALIFY`, BigQuery `FOR SYSTEM_TIME`), set
   `connection: <handle>` so the agent doesn't try to run it
   elsewhere.
5. **Tag for retrieval.** Tags help the agent narrow candidates
   during retrieval (`revenue`, `customer-360`, `finance`).
6. **Validate.** `dogsled model validate --integration <handle>` —
   surfaces unresolved `{ref}` tokens and connection-handle
   mismatches.

## Concrete example

```yaml
spec_version: '0.2'
type: vq
name: top_customers_by_revenue
description: Canonical top-N customers query for the shop demo.

nlq: Who are our top customers by revenue?

sql: |
  SELECT
    customer_id,
    customer_email,
    SUM(order_total) AS revenue
  FROM {fct_orders}
  WHERE order_date >= {start_date}
  GROUP BY customer_id, customer_email
  ORDER BY revenue DESC
  LIMIT {limit}

parameters:
  - name: start_date
    type: date
    description: Inclusive lower bound on order_date
    required: true
  - name: limit
    type: integer
    description: How many customers to return
    required: false
    default: 10

tags:
  - revenue
  - shop-demo
```

## Validation caveats

- `vq.sql` is tokenized for `{ref}` extraction only — the SQL itself
  is not parsed. Syntax errors, unknown columns, and cross-dialect
  incompatibility slip through and surface at query time.
- `connection: <handle>` pinning constrains which warehouse the VQ
  runs against, but does **not** cross-check that `{ref}` tokens
  belong to that connection. A VQ pinned to `bigquery` can reference
  a Snowflake-rooted model and still pass validation.
- Parameter `default` values are typed as `string | number | boolean
| null`. Complex defaults (arrays, objects) are not supported.

## Related skills

- `bobsled-author-model-spec-model` — author the underlying model the VQ queries.
- `bobsled-author-model-spec-metric` — when the answer is a single named measure
  rather than a row set, a metric may be more reusable than a VQ.
- `bobsled-author-model-spec-relationship` — VQs that hand-write joins should
  match the cardinality declared in the relationship spec.

For programmatic edits to an existing VQ, see `bobsled-model-spec-edit` —
`updateVq()` is the validated entry point.
