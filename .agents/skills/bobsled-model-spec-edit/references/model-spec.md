# Model Spec Programmatic Edit API

Use `@bobsled-inc/model-spec/edit` when an agent, web UI, or service needs to update a small part of a Model Spec YAML spec without rewriting the whole file.

The YAML files remain the source of truth. The edit API preserves comments where possible, validates with the same schemas as the compiler, and writes atomically.

## Import

```ts
import {
  addModelColumn,
  addSourceColumn,
  removeModelColumn,
  removeSourceColumn,
  updateMetric,
  updateModel,
  updateModelColumn,
  updateRelationship,
  updateSource,
  updateSourceColumn,
  updateVq,
} from '@bobsled-inc/model-spec/edit';
```

Every function returns:

```ts
type EditResult<T> = { ok: true; data: T } | { ok: false; error: string };
```

Always branch on `result.ok`. Do not assume the edit wrote to disk.

## Common Workflow

1. Pass the project root as `projectDir`.
2. Use the most specific edit function available.
3. Use `dryRun: true` first when showing a preview or diff.
4. Check `result.ok`.
5. Run `bobsled model validate` or package tests after substantial edits.

## Source Column Metadata

Use source edits for `sources/<connection>/*.yml`.

```ts
const result = updateSourceColumn({
  projectDir,
  sourceName: 'raw_customers',
  connection: 'ecom',
  columnName: 'EMAIL',
  patch: {
    description: 'Primary email address for customer communications',
    pii: true,
    semantic_role: 'email',
  },
});
```

Set a patch value to `undefined` to delete the field:

```ts
updateSourceColumn({
  projectDir,
  sourceName: 'raw_customers',
  connection: 'ecom',
  columnName: 'EMAIL',
  patch: { deprecated: undefined },
});
```

Use `addSourceColumn` only when the source table schema actually changed. Use `removeSourceColumn` only after checking downstream lineage and models that reference the column.

## Model Columns

Use model edits for `models/*.yml`.

```ts
updateModelColumn({
  projectDir,
  modelName: 'stg_orders',
  columnName: 'ORDER_DATE',
  patch: {
    expr: "DATE_TRUNC('day', ORDERED_AT)",
    type: 'DATE',
    description: 'Order date at day grain',
  },
});

addModelColumn({
  projectDir,
  modelName: 'stg_orders',
  column: {
    name: 'ORDER_YEAR',
    expr: "DATE_PART('year', ORDER_DATE)",
    description: 'Year the order was placed',
  },
});
```

When changing `expr`, prefer running lineage and compile validation because expression changes can affect downstream SQL even when the YAML schema is valid.

## Model and Metadata Specs

```ts
updateModel({
  projectDir,
  modelName: 'fct_orders',
  patch: {
    description: 'Completed orders with revenue metrics',
    owner: 'data-eng',
    tags: ['finance'],
  },
});

updateMetric({
  projectDir,
  metricName: 'gross_revenue',
  patch: {
    expression: 'SUM({fct_orders.NET_REVENUE})',
    synonyms: ['sales', 'revenue'],
  },
});

updateRelationship({
  projectDir,
  relationshipName: 'orders_customers',
  patch: { join_type: 'left' },
});

updateVq({
  projectDir,
  vqName: 'orders_by_month',
  patch: {
    sql: "SELECT DATE_TRUNC('month', ORDER_DATE), COUNT(*) FROM {fct_orders} GROUP BY 1",
  },
});
```

## Directory Overrides

The API finds each spec by its declared `type` and `name` anywhere in the project, so it works with any folder layout. Pass a folder override only to limit the search to one folder:

```ts
updateSourceColumn({
  projectDir,
  sourcesDir: 'warehouse-sources',
  sourceName: 'raw_customers',
  connection: 'ecom',
  columnName: 'EMAIL',
  patch: { description: 'Primary email address' },
});
```

## Guardrails

- Prefer `dryRun: true` for UI previews.
- Leave `skipValidation` unset for normal use.
- Do not use this API for multi-file transactions; serialize those in the caller.
- Do not edit source schema fields casually. Use lineage before removing or renaming referenced columns.
- Use the returned `content` for previews and diffs instead of re-reading the file.

## Quality Gate

When changing the edit API itself, run:

```bash
pnpm --filter @bobsled-inc/model-spec typecheck
pnpm --filter @bobsled-inc/model-spec test -- tests/unit/edit
```

When using the API to modify a project, run:

```bash
bobsled model validate --integration <handle>
```

For model expression edits, column removals, or schema metadata changes with downstream risk, run lineage as well:

```bash
bobsled model lineage --integration <handle> --json
```

Full docs: `packages/model-spec/docs/programmatic-edit-api.md`.
