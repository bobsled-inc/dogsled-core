# Programmatic Edit API

`@bobsled-inc/model-spec/edit` provides small, ORM-style functions for editing Model Spec YAML specs without reconstructing whole files. It is intended for agents, web UIs, and services that need granular edits such as updating a column description, marking a field as PII, or adjusting a verified query.

The YAML files remain the source of truth. The edit API reads the existing document, applies one targeted mutation with the `yaml` package's comment-preserving document API, validates the result with the same Zod schemas used by the compiler, then writes the file atomically.

## Install and Import

```ts
import {
  addModelColumn,
  updateMetric,
  updateModel,
  updateSourceColumn,
} from '@bobsled-inc/model-spec/edit';
```

Every function returns an `EditResult`:

```ts
type EditResult<T> = { ok: true; data: T } | { ok: false; error: string };
```

Successful edits return the edited file path and serialized YAML content:

```ts
type EditFileResult = {
  filePath: string;
  content: string;
};
```

## Directory Resolution

Pass `projectDir` for every edit. The API reads `model-spec.yml` when present and honors directory overrides such as `sources_dir`, `models_dir`, `metrics_dir`, `relationships_dir`, and `vqs_dir`.

You can override directories per call:

```ts
updateSourceColumn({
  projectDir: '/repo/analytics',
  sourcesDir: 'warehouse-sources',
  sourceName: 'raw_customers',
  connection: 'ecom',
  columnName: 'EMAIL',
  patch: { description: 'Primary email address' },
});
```

## Source Edits

Use source edits for files under `sources/`. Source lookup uses both `sourceName` and `connection` so the same source name can exist under multiple warehouse handles.

```ts
const result = updateSourceColumn({
  projectDir: '/repo/analytics',
  sourceName: 'raw_customers',
  connection: 'ecom',
  columnName: 'EMAIL',
  patch: {
    description: 'Primary email address for customer communications',
    pii: true,
    semantic_role: 'email',
  },
});

if (!result.ok) throw new Error(result.error);
```

Available functions:

```ts
updateSourceColumn(opts);
addSourceColumn(opts);
removeSourceColumn(opts);
updateSource(opts);
```

Set a patch field to `undefined` to remove it:

```ts
updateSourceColumn({
  projectDir,
  sourceName: 'raw_customers',
  connection: 'ecom',
  columnName: 'EMAIL',
  patch: { deprecated: undefined },
});
```

`removeSourceColumn` refuses to remove the last remaining column because source specs require at least one column.

### Source API Reference

```ts
updateSourceColumn({
  projectDir,
  sourceName,
  connection,
  columnName,
  patch,
  dryRun,
});

addSourceColumn({
  projectDir,
  sourceName,
  connection,
  column: { name, type, ...metadata },
});

removeSourceColumn({ projectDir, sourceName, connection, columnName });

updateSource({
  projectDir,
  sourceName,
  connection,
  patch: { description, trust_tier },
});
```

## Model Edits

Use model edits for files under `models/`.

```ts
addModelColumn({
  projectDir,
  modelName: 'stg_orders',
  column: {
    name: 'ORDER_YEAR',
    expr: "DATE_PART('year', ORDER_DATE)",
    description: 'Year the order was placed',
    semantic_role: 'time_dimension',
  },
});
```

Available functions:

```ts
updateModelColumn(opts);
addModelColumn(opts);
removeModelColumn(opts);
updateModel(opts);
```

`updateModelColumn` supports field metadata plus model-column fields:

```ts
updateModelColumn({
  projectDir,
  modelName: 'stg_orders',
  columnName: 'ORDER_DATE',
  patch: {
    expr: "DATE_TRUNC('day', ORDERED_AT)",
    type: 'DATE',
    not_null: true,
    description: 'Order date at day grain',
  },
});
```

`updateModel` supports model-level metadata:

```ts
updateModel({
  projectDir,
  modelName: 'fct_orders',
  patch: {
    description: 'Completed orders with revenue metrics',
    grain: ['ORDER_ID', 'ORDER_DATE'],
    tags: ['finance'],
    owner: 'data-eng',
  },
});
```

### Model API Reference

```ts
updateModelColumn({
  projectDir,
  modelName,
  columnName,
  patch: { expr, type, primary_key, not_null, ...metadata },
});

addModelColumn({
  projectDir,
  modelName,
  column: { name, expr, ...metadata },
});

removeModelColumn({ projectDir, modelName, columnName });

updateModel({
  projectDir,
  modelName,
  patch: { description, grain, tags, owner, trust_tier },
});
```

## Metadata Edits

Use metadata edits for first-class metric, relationship, and verified query specs.

```ts
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

### Metadata API Reference

```ts
updateMetric({
  projectDir,
  metricName,
  patch: { description, expression, model, models, synonyms, tags },
});

updateRelationship({
  projectDir,
  relationshipName,
  patch: { description, join_type, relationship_type, tags },
});

updateVq({
  projectDir,
  vqName,
  patch: { description, nlq, sql, tags },
});
```

Metadata edit functions validate the edited file shape only. Cross-file checks such as "does this metric model exist?" still belong to `bobsled model validate`.

## Dry Runs and Validation

Use `dryRun: true` to validate and get the edited YAML content without writing to disk:

```ts
const preview = updateSourceColumn({
  projectDir,
  sourceName: 'raw_orders',
  connection: 'ecom',
  columnName: 'STATUS',
  patch: { enum_values: ['pending', 'shipped', 'delivered', 'cancelled'] },
  dryRun: true,
});
```

By default, every edit validates the serialized YAML before writing. Validation failures return `{ ok: false, error }` and leave the file untouched.

`skipValidation: true` exists for migration tools that intentionally need an intermediate invalid state. Do not use it for normal agents or UI edits.

## File Safety

Writes are atomic: content is written to a temporary file in the same directory and then renamed into place. Callers that need to show a diff can use the returned `content` instead of re-reading the file.

Each edit call reads the latest file from disk, so sequential calls naturally build on earlier writes:

```ts
const base = { projectDir, sourceName: 'raw_customers', connection: 'ecom' };

updateSourceColumn({ ...base, columnName: 'EMAIL', patch: { pii: true } });
updateSourceColumn({ ...base, columnName: 'PHONE', patch: { pii: true } });
updateSourceColumn({ ...base, columnName: 'NAME', patch: { pii: true } });
```

For concurrent editors, serialize writes at the application layer. The edit API intentionally keeps the package small and does not implement file locks or multi-file transactions.

## Operational Guidance

For UI workflows:

- Use `dryRun: true` on every form preview.
- Show `result.error` directly only to technical users; for end users, map validation errors into form fields when possible.
- Save by calling the same function without `dryRun`.
- Run `bobsled model validate` after a batch of edits if the UI allows several files to change.

For agent workflows:

- Prefer one edit call per user intent, such as one column description update or one metric expression update.
- Read lineage before removing columns or changing model expressions used downstream.
- Do not use `skipValidation` unless you are writing a migration that immediately performs a second edit to restore validity.
- Commit YAML changes after validation so reviewers can inspect the exact source-of-truth diff.
