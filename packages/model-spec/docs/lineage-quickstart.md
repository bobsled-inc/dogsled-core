# Model Spec Lineage Quick Start

Model Spec lineage shows both model dependencies and column-level upstream references from YAML model specs. It is static analysis: no warehouse connection is required.

## Commands

Show the model DAG:

```bash
bobsled model lineage --integration duckdb
```

Show one model subgraph:

```bash
bobsled model lineage fct_orders --integration duckdb
```

Emit structured output for agents and automation:

```bash
bobsled model lineage --integration duckdb --json
bobsled model lineage --integration duckdb --yaml
```

Filter to one output column:

```bash
bobsled model lineage --integration duckdb --column fct_orders.ORDER_ID --json
bobsled model lineage --integration duckdb --column fct_orders.ORDER_ID --yaml
```

## Output Shape

JSON and YAML output use the same single envelope. Use JSON for strict automation and YAML when the payload will be read or summarized directly by agents:

```json
{
  "command": "model.lineage",
  "executed": "2026-05-01T00:00:00.000Z",
  "warnings": [],
  "skipped": [],
  "integrations": [
    {
      "handle": "duckdb",
      "dialect": "duckdb",
      "models": [
        {
          "name": "fct_orders",
          "refs": ["stg_orders"],
          "source_refs": [],
          "materialization": "view",
          "trust_tier": "silver",
          "effective_trust_tier": "bronze"
        }
      ],
      "column_lineage": [
        {
          "model": "fct_orders",
          "column": "ORDER_ID",
          "upstream": [{ "alias": "t0", "source": "stg_orders", "column": "ORDER_ID" }],
          "isComplete": true
        }
      ]
    }
  ]
}
```

`effective_trust_tier` may be lower than the declared tier when an upstream dependency has a lower tier. It is `null` when no tier override applies.

## What Counts as Complete

`isComplete=true` means Model Spec could trace the column through parsed YAML expressions and known source schemas.

`isComplete=false` means Model Spec found an opaque boundary. Common examples:

- Explicit `raw_sql(...)`
- Subqueries
- `flatten_json`
- `pivot`
- `unpivot`
- `include_all_columns` when the upstream schema is not available

Incomplete lineage is still useful. It tells reviewers exactly where Bobsled Core refuses to infer provenance.

## How Dependencies Are Counted

Column lineage includes more than direct expression inputs:

- `include_all_columns` emits identity edges for passthrough source columns when source schemas are known.
- Join `ON` clause refs are included for output columns that use the joined table.
- `source.filter`, `where`, `having`, and `qualify` refs are included for every output column because they constrain row membership.

## Review Workflow

Before changing a source field or model column:

1. Query the model column.

   ```bash
   bobsled model lineage --integration duckdb --column stg_orders.ORDER_ID --json
   ```

2. Use `--yaml` instead when pasting the result into an agent review note or PR risk summary.
3. Check every upstream entry in `column_lineage[].upstream`.
4. If `isComplete=false`, inspect the model YAML manually before approving.
5. If Entity Graph specs consume this model, also run entity lineage. See [Bobsled Core Lineage Guide](../../../docs/reference/advanced/lineage-guide.md).

## Programmatic API

`lineageProject()` returns the same per-integration model data and attaches `columnLineage` for host applications:

```ts
import { lineageProject } from '@bobsled-inc/model-spec/project';

const result = await lineageProject(process.cwd(), {
  integration: 'duckdb',
  models: ['fct_orders'],
});

const columns = result.byIntegration[0]?.columnLineage ?? [];
```
