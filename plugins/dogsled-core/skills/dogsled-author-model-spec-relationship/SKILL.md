---
name: dogsled-author-model-spec-relationship
description: Author a Model Spec relationship YAML — declares how two Model Spec
  models join, including multi-column joins, join type, and cardinality. Used by
  downstream planners (BI tools, host application, query planner) when a query
  spans more than one model.
---

# Author a Model Spec relationship

Use this skill when a user wants to declare how two Model Spec models join.
No SQL is emitted directly — downstream consumers (BI tools, the
query planner, a host application) read the relationship spec to plan
joins when a query spans more than one model.

For mastered-entity relationships (entity-graph identity edges), see
the `entity_relationship` type instead — different schema with
confidence scoring, temporal validity, and review thresholds.

## Where the file goes

Place each relationship in its own file under the project's
`relationships/` directory (configurable via `relationships_dir` in
`model-spec.yml`, defaults to `relationships/`). One relationship per file.

## Schema (canonical)

```yaml
spec_version: '0.2'
type: relationship
name: <identifier> # must match identifierRegex; required
description: Short human-readable explanation # optional

left_model: <model_a> # required; the "from" side
right_model: <model_b> # required; the "to" side — must differ from left_model

join_columns: # required; at least one pair, multi-column joins supported
  - left: <column_in_left>
    right: <column_in_right>
  - left: <another_column> # additional pairs AND together in the generated ON clause
    right: <another_column>

join_type: inner # 'inner' (default) or 'left'; 'right'/'full' are intentionally not supported
relationship_type: many_to_one # required; one of one_to_one | one_to_many | many_to_one | many_to_many

tags: # optional
  - core
  - shop-domain
```

**Required:** `spec_version`, `type`, `name`, `left_model`,
`right_model`, `join_columns` (≥1 pair), `relationship_type`.

Self-joins are rejected — `left_model` must differ from
`right_model`. If you need a self-referential relationship (manager
of an employee, parent of an account), model it as two Model Spec models
that point at the same underlying table.

## Workflow

1. **Pick `left_model` and `right_model`.** Order matters for the
   cardinality reading — a `many_to_one` from `fct_orders` (left) to
   `dim_customers` (right) means "many orders per customer".
2. **Declare every join column pair.** A single-column join is one
   pair under `join_columns:`. Multi-column joins list multiple
   pairs; each becomes an `AND` in the generated `ON` clause.
3. **Join the one side on its primary key.** The one side must be
   unique on its join columns: the `right_model` of a `many_to_one`,
   the `left_model` of a `one_to_many`, and both models of a
   `one_to_one` (`many_to_many` has none). Mark that model's or
   source's key columns `primary_key: true` (an agentic model's key is
   its `grain`) and join on exactly those columns, every column of a
   composite key included. Warehouses that
   trust declared keys, such as Snowflake semantic views, never check
   them against the data, so a missing or different key returns wrong
   numbers rather than an error.
4. **Pick `join_type`.** `inner` is the default; use `left` to
   preserve rows on the left side when the right side may not match.
   `right` and `full` are deliberately not supported — reorder the
   models for a `right`, and `full` is rarely analytically meaningful.
5. **Pick `relationship_type`.** Be explicit about cardinality:
   `one_to_one`, `one_to_many`, `many_to_one`, `many_to_many`. This
   drives the Data Estate UI and helps the query planner reason
   about join fan-out before generating SQL.
6. **Validate.** `dogsled model validate --integration <handle>`
   checks that both models exist; column existence inside the join
   pairs is **not** validated (see caveats below).
   `dogsled runner validate` and Ossie export warn with
   `relationship_target_key_missing` when the one side declares no
   primary key, and with `relationship_target_key_mismatch` when its
   join columns are not its primary key (compared as a set, ignoring
   order and case).

## Concrete example

`dim_customers` marks `customer_id` with `primary_key: true`, so this
`many_to_one` joins its one side on its primary key.

```yaml
spec_version: '0.2'
type: relationship
name: orders_to_customers
description: Each order belongs to exactly one customer.

left_model: fct_orders
right_model: dim_customers

join_columns:
  - left: customer_id
    right: customer_id

join_type: inner
relationship_type: many_to_one

tags:
  - core
  - shop-domain
```

A multi-column composite-key example, where `fct_orders` marks both
`tenant_id` and `order_id` with `primary_key: true`:

```yaml
spec_version: '0.2'
type: relationship
name: line_items_to_orders
description: Order line items link to orders by tenant + order id.

left_model: fct_order_items
right_model: fct_orders

join_columns:
  - left: tenant_id
    right: tenant_id
  - left: order_id
    right: order_id

join_type: inner
relationship_type: many_to_one
```

## Validation caveats

- `validateMetadataReferences` is a **structural** check: it
  confirms `left_model` / `right_model` resolve, but does **not**
  check that each `join_columns.left` / `join_columns.right` exists
  in the referenced model's `schema.columns`. A column typo slips
  through and fails only at query time.
- Composite-key joins must list every key column. Missing one
  silently produces a fan-out join at query time; the primary-key
  warning catches it when the one side declares its full key.

## Related skills

- `dogsled-author-model-spec-model` — author the models being joined.
- `dogsled-author-model-spec-metric` — multi-model metrics rely on relationships to
  plan their joins.
- `dogsled-author-model-spec-vq` — verified queries that hand-write joins can be
  treated as ground truth for ad-hoc shapes the relationship doesn't
  cover.

For programmatic edits to an existing relationship, see `dogsled-model-spec-edit`
— `updateRelationship()` is the validated entry point.
