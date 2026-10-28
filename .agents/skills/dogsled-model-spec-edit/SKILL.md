---
name: dogsled-model-spec-edit
description: Use @bobsled-inc/model-spec/edit for granular, validation-backed
  edits to Model Spec YAML sources, models, metrics, relationships, and verified
  queries.
exposed: true
triggers:
  - programmatically edit a model spec spec
  - granular yaml edit
  - update a single model spec field
  - model-spec edit api
  - patch a model spec model
  - validation-backed yaml edits
  - preserve comments when editing yaml
---

# Model Spec Programmatic Edit API

Use `@bobsled-inc/model-spec/edit` when an agent, UI, or service needs to update a small part of a Model Spec YAML spec without rewriting the full file.

The YAML files remain the source of truth. The edit API preserves comments where possible, validates with the compiler schemas before writing, and writes atomically.

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

Every function returns `{ ok: true, data }` or `{ ok: false, error }`. Always branch on `result.ok`.

## Source Metadata

```ts
updateSourceColumn({
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

Set a patch value to `undefined` to delete that field.

## Model Columns

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
```

```ts
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

## Metadata Specs

```ts
updateMetric({
  projectDir,
  metricName: 'gross_revenue',
  patch: { expression: 'SUM({fct_orders.NET_REVENUE})' },
});

updateRelationship({
  projectDir,
  relationshipName: 'orders_customers',
  patch: { join_type: 'left' },
});

updateVq({
  projectDir,
  vqName: 'orders_by_month',
  patch: { sql: 'SELECT COUNT(*) FROM {fct_orders}' },
});
```

## Guardrails

- Use `dryRun: true` for previews and diffs.
- Leave `skipValidation` unset for normal edits.
- Run `dogsled model validate` after substantial edits.
- Use lineage before removing source or model columns.
- Use the returned `{ filePath, content }` instead of re-reading after a successful edit.

## Quality Gate

After changing code that calls the edit API, run focused validation first:

```bash
pnpm --filter @bobsled-inc/model-spec typecheck
pnpm --filter @bobsled-inc/model-spec test -- tests/unit/edit
```

After using the API to edit a real Model Spec project, run project validation:

```bash
dogsled model validate --integration <handle>
```

If the edit changes model expressions or removes columns, also run lineage:

```bash
dogsled model lineage --integration <handle> --json
```

Full docs: `packages/model-spec/docs/programmatic-edit-api.md`.

## Detailed Model-Spec Reference

Read the compiler and editing reference when the task needs the full API or schema:

{{include: .agents/skills/dogsled-model-spec-edit/references/model-spec.md}}
