# Dogsled Lineage Guide

Lineage in Dogsled has two complementary layers:

- **Model Spec model lineage**: static model and column lineage from YAML model specs. Use it before changing model expressions, source schemas, joins, or filters.
- **Entity Graph lineage**: persisted attribute provenance for mastered entity profiles. Use it before changing survivorship rules, resolution inputs, or upstream columns that feed golden records.

Together they answer two different questions:

| Question                                            | Command family                 |
| --------------------------------------------------- | ------------------------------ |
| What models depend on this model or source?         | `dogsled model lineage`        |
| What columns feed this model column?                | `dogsled model lineage`        |
| What entity attributes depend on this source field? | `dogsled entity-graph lineage` |
| Which attributes have incomplete provenance?        | `dogsled entity-graph lineage` |

## Quick Start: Model Lineage

Show the dependency DAG for one integration:

```bash
dogsled model lineage --integration duckdb
```

Emit machine-readable model and column lineage:

```bash
dogsled model lineage --integration duckdb --json
dogsled model lineage --integration duckdb --yaml
```

Focus on one model column:

```bash
dogsled model lineage --integration duckdb --column fct_orders.ORDER_ID --json
dogsled model lineage --integration duckdb --column fct_orders.ORDER_ID --yaml
```

The JSON and YAML envelopes have the same shape and include:

- `integrations[].models[]`: model DAG nodes, model refs, source refs, materialization, declared trust tier, and effective trust tier
- `integrations[].columnLineage[]`: one row per output column, with upstream column refs and `isComplete`

Use `isComplete=false` as a review signal. It means Dogsled found a lineage boundary it will not guess through, such as explicit `raw_sql`, a subquery, or a reshape operation that changes row/column shape.

## What Model Spec Column Lineage Traces

Model Spec lineage walks parsed model expression ASTs and records upstream `column_ref` nodes. It also includes common row-shaping dependencies:

| Construct                                     | Behavior                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Explicit column expressions                   | Direct upstream column refs are listed.                                                  |
| `include_all_columns`                         | Passthrough source columns become identity edges when source schema is known.            |
| `joins[].on`                                  | Join predicate refs are attached to output columns that reference the joined table.      |
| `source.filter`, `where`, `having`, `qualify` | Filter refs are attached to every output column because they constrain which rows exist. |
| `raw_sql`, subqueries                         | Lineage row is emitted with `isComplete=false`.                                          |
| `flatten_json`, `pivot`, `unpivot`            | Lineage row is emitted with `isComplete=false` until deeper reshape tracing lands.       |

## Quick Start: Entity Graph Lineage

Preview attribute provenance without writing to the warehouse:

```bash
dogsled entity-graph lineage compile --dry-run --json
```

Persist schema-level provenance to `entity_graph.lineage`:

```bash
dogsled entity-graph lineage compile --runner ./runner.js --json
```

Query one mastered attribute:

```bash
dogsled entity-graph lineage --entity company --attribute name --runner ./runner.js --json
```

Entity Graph lineage rows are schema-level by default (`entity_id = null`). They map survivorship attributes to resolution input refs and source columns, including standardization transforms and `is_complete`.

For table schema, SQL examples, and `explain` integration, see [entity-graph-lineage-guide.md](entity-graph-lineage-guide.md).

## Change Safety Workflow

Use this workflow before removing, renaming, or materially changing a source field, Model Spec model column, or survivorship attribute.

1. Run Model Spec lineage for the model or column you plan to change.

   ```bash
   dogsled model lineage --integration duckdb --column stg_orders.ORDER_ID --json
   ```

   Use `--yaml` instead when the output will be read directly in an agent handoff or PR note.

2. If the change feeds mastered entities, compile entity lineage in dry-run mode.

   ```bash
   dogsled entity-graph lineage compile --dry-run --json
   ```

3. Query persisted entity lineage for affected attributes.

   ```bash
   dogsled entity-graph lineage --entity company --attribute name --runner ./runner.js --json
   ```

4. Treat these as merge blockers until reviewed:
   - A removed or renamed column appears in any `is_complete=true` lineage row.
   - A change increases the number of `is_complete=false` rows.
   - A survivorship `source_order` change switches the winning source table for a critical attribute.

5. After merging and running the updated pipeline, refresh persisted lineage.

   ```bash
   dogsled entity-graph lineage compile --runner ./runner.js --json
   ```

## Agent Checklist

When an agent changes extraction specs, Model Spec models, resolution specs, or survivorship specs:

- [ ] Inspect model lineage for changed models or columns.
- [ ] Inspect entity lineage for affected mastered attributes when entity graph specs exist.
- [ ] Include any `isComplete=false` rows in the PR risk notes.
- [ ] Add or update tests when lineage behavior changes.
- [ ] Refresh docs when command semantics or output shape changes.

## Related Docs and Skills

- [Model lineage quick start](../../../packages/model-spec/docs/lineage-quickstart.md)
- [Entity Graph lineage guide](entity-graph-lineage-guide.md)
- [Entity Graph authoring guide](entity-graph-authoring-guide.md)
- [Lineage skill](../../../.agents/skills/lineage/SKILL.md)
