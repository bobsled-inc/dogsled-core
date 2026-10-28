# Entity Graph Column-Level Lineage

Column-level lineage tracks which source columns ultimately contribute to each attribute in an entity profile. This guide covers how to compile lineage, query it, and use it to reason about the safety of upstream changes.

For stable entity ID semantics see [entity-graph-stable-entity-ids.md](entity-graph-stable-entity-ids.md). For the full entity graph authoring loop see [entity-graph-authoring-guide.md](entity-graph-authoring-guide.md). For the cross-project workflow that starts with Model Spec model/column lineage and then checks mastered-attribute provenance, see [lineage-guide.md](lineage-guide.md).

## Overview

When you run `lineage compile`, Dogsled joins your Model Spec column-level extraction metadata with the survivorship `source_order` configuration and writes one row per `(entity_type, attribute, source_table, source_column)` combination to `entity_graph.lineage`. Each row records:

- **Where the data came from** — `source_system`, `source_table`, `source_column`, `field_path`
- **How it was transformed** — `transform_ref`, `transform_step`
- **Whether the full chain is known** — `is_complete`

The table is safe to query from any BI tool or downstream pipeline that has access to the `entity_graph` schema.

## The `entity_graph.lineage` Table

```sql
entity_graph.lineage (
  entity_type    STRING,        -- e.g. 'acme.company'
  entity_id      STRING NULL,   -- NULL for schema-level rows; populated for instance-level (future)
  attribute      STRING,        -- survivorship output column name
  profile_table  STRING,        -- entity_graph profile table
  profile_column STRING,        -- attribute column in profile table
  source_system  STRING NULL,   -- source system from resolution spec input
  source_table   STRING,        -- fully-qualified upstream table
  source_column  STRING,        -- upstream column name
  field_path     STRING NULL,   -- JSON path for nested fields
  transform_ref  STRING NULL,   -- Model Spec transform function reference(s)
  transform_step STRING NULL,   -- Model Spec transform step name
  is_complete    BOOLEAN,       -- false when source path is opaque
  loaded_at      TIMESTAMP      -- refresh timestamp
)
```

Each lineage refresh writes a `lineage_refresh` event to `entity_graph.audit_log` (category=mutation).

## Compiling Lineage

Before compiling entity lineage after a model change, inspect the model side:

```bash
dogsled model lineage --integration <handle> --column <model.column> --json
dogsled model lineage --integration <handle> --column <model.column> --yaml
```

Then preview the entity graph rows:

```bash
# Preview what would be written (no warehouse writes)
dogsled entity-graph lineage compile --dry-run --json

# Write to entity_graph.lineage (idempotent DELETE+INSERT per entity type)
dogsled entity-graph lineage compile --runner ./runner.js --json

# Limit to one spec directory
dogsled entity-graph lineage compile --spec-dir ./entity-graph --runner ./runner.js --json
```

The compile step uses `--contract-schema` (default: `entity_graph`) to control which schema the output table lives in. Pass `--contract-schema <name>` to target a non-default schema.

### What compile does

For each `(survivorship spec, resolution spec)` pair:

1. Builds a `tableByAlias` map from the resolution spec's `inputs` (alias → `fqTableName`)
2. For each survivorship output attribute, walks the `source_order` list to find the first resolvable source alias
3. If the alias resolves, emits an `is_complete=true` row with `source_table=fqTableName`
4. If no alias resolves (empty `source_order`, all aliases unresolvable), emits an `is_complete=false` row
5. Executes `DELETE FROM entity_graph.lineage WHERE entity_type = ?` then `INSERT` for the new rows

### Incomplete lineage (`is_complete=false`)

A row has `is_complete=false` when:

- The `source_order` list is empty
- Every source alias in `source_order` is missing from the resolution spec's inputs
- The Model Spec model uses a raw SQL expression rather than a column reference (no column-level metadata available)

Incomplete rows still appear in query output so you can identify which attributes have opaque provenance.

## Querying Lineage

```bash
# All lineage rows for an entity type
dogsled entity-graph lineage --entity company --runner ./runner.js --json

# One attribute
dogsled entity-graph lineage --entity company --attribute name --runner ./runner.js --json

# Formatted as a Markdown table
dogsled entity-graph lineage --entity company --attribute name --runner ./runner.js --format markdown
```

### SQL queries

```sql
-- Complete lineage for all company attributes
SELECT attribute, source_system, source_table, source_column, transform_ref
FROM entity_graph.lineage
WHERE entity_type = 'acme.company'
  AND is_complete = true
ORDER BY attribute, source_table;

-- Attributes with incomplete lineage (need attention)
SELECT entity_type, attribute, COUNT(*) AS incomplete_rows
FROM entity_graph.lineage
WHERE is_complete = false
GROUP BY entity_type, attribute
ORDER BY entity_type, attribute;

-- Which entity attributes depend on a specific source column?
SELECT entity_type, attribute, source_table, transform_ref
FROM entity_graph.lineage
WHERE source_table = 'raw.salesforce.accounts'
  AND source_column = 'Name'
ORDER BY entity_type, attribute;
```

## Provenance in `explain`

When lineage rows exist, `entity-graph explain --subject entity` includes a `lineage_provenance` block for each attribute:

```bash
dogsled entity-graph explain --subject entity --entity-id <id> --runner ./runner.js --json
```

The block lists the upstream source columns that contributed to each resolved attribute, joining `entity_graph.lineage` with the entity's profile rows.

## Using Lineage to Assess Change Safety

Before changing a Model Spec model column, extraction spec field, or survivorship rule, query lineage to understand downstream impact.

### Find attributes that depend on a column

```bash
# Which entity attributes source from salesforce.accounts.Name?
dogsled entity-graph lineage --runner ./runner.js --json \
| jq '.rows[] | select(.source_table == "raw.salesforce.accounts" and .source_column == "Name")'
```

Or in SQL:

```sql
SELECT entity_type, attribute, is_complete
FROM entity_graph.lineage
WHERE source_table = 'raw.salesforce.accounts'
  AND source_column = 'Name';
```

### Risk by change type

| Change                                              | Risk            | Signal                                                                   |
| --------------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| Rename or remove a source column                    | **High**        | Any `is_complete=true` row with that `source_column` loses data silently |
| Change a Model Spec transform expression to raw SQL | **Medium**      | Downstream attribute gains `is_complete=false` rows (loses traceability) |
| Add a new source alias to `source_order`            | **Low**         | New rows appear; no existing rows change                                 |
| Reorder `source_order`                              | **Medium**      | Different `source_table` may win; compile with `--dry-run` and compare   |
| Remove a source alias from `source_order`           | **Medium–High** | Attribute may fall through to a different source or become incomplete    |

### Safe change checklist

Before merging an upstream schema change:

- [ ] Run `lineage compile --dry-run` and confirm expected rows
- [ ] Check no `is_complete=true` rows reference the removed/renamed column
- [ ] If new `is_complete=false` rows appear, assess whether traceability loss is acceptable
- [ ] Run `lineage compile --runner ./runner.js` after the schema change to refresh provenance

## Joining Lineage to Other Contract Surfaces

```sql
-- Lineage + audit: who refreshed lineage and when?
SELECT l.entity_type, l.attribute, a.created_at, a.payload->>'run_id' AS run_id
FROM entity_graph.lineage l
JOIN entity_graph.audit_log a
  ON a.payload->>'entity_type' = l.entity_type
 AND a.payload->>'kind' = 'lineage_refresh'
ORDER BY a.created_at DESC;

-- Lineage + entity quality: trust tier by lineage completeness
SELECT eq.trust_tier,
       COUNT(DISTINCT l.attribute) AS attributes_with_complete_lineage
FROM entity_graph.entity_quality_current eq
JOIN entity_graph.lineage l
  ON l.entity_type = eq.entity_type
 AND l.is_complete = true
WHERE eq.entity_type LIKE '%.company'
GROUP BY eq.trust_tier;
```

## Related Docs and Skills

- Dogsled lineage guide: [`docs/reference/advanced/lineage-guide.md`](lineage-guide.md)
- Model Spec lineage quick start: [`packages/model-spec/docs/lineage-quickstart.md`](../../../packages/model-spec/docs/lineage-quickstart.md)
- Entity graph authoring guide: [`docs/reference/advanced/entity-graph-authoring-guide.md`](entity-graph-authoring-guide.md)
- Stable entity ID reference: [`docs/reference/advanced/entity-graph-stable-entity-ids.md`](entity-graph-stable-entity-ids.md)
- Lineage skill: [`.agents/skills/lineage/SKILL.md`](../../../.agents/skills/lineage/SKILL.md)
- Authoring skill: [`.agents/skills/entity-graph-authoring/SKILL.md`](../../../.agents/skills/entity-graph-authoring/SKILL.md)
