# Entity Graph Stable Entity IDs

Entity Graph now separates the current connected-component topology from the public ID that downstream systems should use. The short version:

- Use `entity_id` as the durable serving identifier.
- Treat `cluster_id` as a backward-compatible alias for `entity_id` in current serving tables.
- Use `component_id` only when you need to debug the current graph shape.

This matters because connected components can change when new records arrive, existing entities merge, or a reviewed split removes an edge. Stable entity IDs preserve the identity that BI, CRM, marketing, and activation systems already know.

## Configuration

Stable IDs are the default policy. You can leave `entity_id_policy` out of a resolution spec, or include it explicitly to make the behavior obvious to readers:

```yaml
entity_id_policy:
  strategy: stable
  new_id: component_id
  merge: oldest_entity_id
  split: preserve_anchor
```

Only this stable policy is currently supported:

| Field                     | Meaning                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `strategy: stable`        | Assign IDs through the append-only entity ID event log.                                       |
| `new_id: component_id`    | A brand-new connected component receives its current `component_id` as its first `entity_id`. |
| `merge: oldest_entity_id` | When multiple prior entities merge, the oldest existing entity ID wins.                       |
| `split: preserve_anchor`  | When a prior entity splits, the old ID stays with the component containing the anchor record. |

## ID Semantics

The resolver produces three related IDs:

| ID             | Stability                                                                 | Use it for                                                                                 |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `entity_id`    | Stable across reruns, lower-sorting arrivals, merges, and reviewed splits | External joins, clean views, profiles, survivorship, activation, and downstream references |
| `cluster_id`   | Current compatibility alias for `entity_id`                               | Existing consumers that still expect `cluster_id`                                          |
| `component_id` | Current topology ID, recomputed from the connected component              | Debugging split/merge topology and understanding why a run changed                         |

Do not use `component_id` as a durable foreign key. It can change when the graph shape changes. Prefer `entity_id` in new queries and dashboards.

## What Happens During `resolve cluster`

`bobsled entity-graph resolve cluster` runs the connected-components stage and then assigns stable entity IDs before rebuilding the serving surfaces:

1. Build current components from auto-merge pairs and applied `merge` review decisions.
2. Backfill stable entity events from existing `__clusters` if this project was created before stable IDs existed.
3. Append new assignment events for new records, moves, merges, splits, and reactivations.
4. Rebuild snapshots from the event log.
5. Rebuild `__clusters` and `__crosswalks` with `entity_id`, `cluster_id`, and `component_id`.

The event log is append-only. Snapshot tables are rebuilt from it so reruns are idempotent.

## Merge, Split, and Reactivation Rules

### New lower-sorting record

If a record with a lower lexical ID joins an existing entity, the connected component's `component_id` may change. The public `entity_id` does not change.

### Merge

When two existing entities become one component, the oldest existing `entity_id` wins. Losing IDs are written to `__entity_id_aliases` as active aliases.

Example:

| Before                            | After merge                                                    |
| --------------------------------- | -------------------------------------------------------------- |
| `a` and `z` are separate entities | `a` stays the `entity_id`; `z` becomes an active alias for `a` |

### Split

When a reviewed split separates records again, the resolver keeps the prior ID on the anchor component. If a split-off component previously had an alias ID, that alias can be reactivated and the alias row is superseded.

Example:

| Step                           | Result                                                           |
| ------------------------------ | ---------------------------------------------------------------- |
| `z` merged into `a`            | active alias: `entity_id = a`, `alias_entity_id = z`             |
| `z` later splits away from `a` | `z` reclaims `entity_id = z`; the alias row gets `superseded_at` |

### Missing records

If a record is absent from the current source data, it is absent from `__entity_id_current` and current serving tables. The event log and record map keep the historical assignment so future reappearance can be handled consistently.

## Output Tables

Stable ID assignment adds or enriches these tables:

| Table suffix                                              | Purpose                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `__components`                                            | Current connected components. `component_id` reflects current graph topology.                                |
| `__entity_id_events`                                      | Append-only assignment log. Contains `assign`, `move`, `alias`, `split`, `reactivate`, and backfill events.  |
| `__entity_id_record_map`                                  | Latest known assignment per record from the event log, including historical records that may not be current. |
| `__entity_id_current`                                     | Current live records joined to their stable `entity_id`.                                                     |
| `__entity_id_aliases`                                     | Active and superseded aliases created by merges and cleared by reactivation.                                 |
| `__clusters`                                              | Current serving membership with `entity_id`, `cluster_id`, `component_id`, record metadata, and confidence.  |
| `__crosswalks`                                            | Source-record-to-entity lookup with `entity_id`, `cluster_id`, `component_id`, source keys, and confidence.  |
| `__entity_profile`, `__entity_quality`, `__golden_record` | Downstream profile, quality, and survivorship outputs keyed by stable `entity_id`.                           |

For a source-facing clean view, set:

```yaml
profile:
  views:
    enabled: true
    name_pattern: '{source_table}_clean'
    include_entity_graph_metadata: true
```

Clean views include these Entity Graph metadata columns when enabled:

| Column                          | Meaning                                           |
| ------------------------------- | ------------------------------------------------- |
| `ENTITY_GRAPH_ENTITY_ID`        | Stable entity ID for the source row.              |
| `ENTITY_GRAPH_CLUSTER_ID`       | Compatibility alias for `ENTITY_GRAPH_ENTITY_ID`. |
| `ENTITY_GRAPH_COMPONENT_ID`     | Current connected component ID.                   |
| `ENTITY_GRAPH_CONFIDENCE_SCORE` | Row-level entity assignment confidence.           |

If a source table already has one of those names, clean-view generation fails fast so the view does not expose duplicate or ambiguous columns.

## Inspecting IDs

Use `resolve cluster --json` to get an entity ID summary after an executed cluster run:

```bash
bobsled entity-graph resolve cluster company --runner ./runner.js --json
```

Each `entities[]` entry in the JSON response can include:

```json
{
  "entity_id_summary": {
    "new_ids": 3,
    "reused_ids": 120,
    "merged_ids": 2,
    "split_ids": 1,
    "reactivated_ids": 1,
    "alias_count": 2
  }
}
```

Use `resolve inspect cluster` to inspect the current entity and its evidence:

```bash
bobsled entity-graph resolve inspect cluster \
  --entity company \
  --entity-id <entity_id> \
  --runner ./runner.js \
  --json
```

`--cluster-id` is accepted as an alias for `--entity-id` for compatibility:

```bash
bobsled entity-graph resolve inspect cluster \
  --entity company \
  --cluster-id <entity_id> \
  --runner ./runner.js \
  --json
```

If both flags are provided, they must match. A conflicting pair is a validation error.

The JSON response includes:

| Field                    | Meaning                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `entity_id`              | Canonical stable ID from current cluster evidence.                                                                |
| `cluster_id`             | Compatibility alias from current cluster evidence.                                                                |
| `executed`               | `false` when no runner is provided and the command only emits SQL.                                                |
| `found`                  | `true` only when current members, crosswalks, or golden-record rows exist. Audit-only hits return `found: false`. |
| `members`                | Current rows from `__clusters`.                                                                                   |
| `crosswalks`             | Current rows from `__crosswalks`.                                                                                 |
| `golden_record`          | Current survivorship rows for the entity.                                                                         |
| `contributing_decisions` | Latest review decisions that contributed to the current component.                                                |
| `audit`                  | Matching audit events, when present.                                                                              |

## Useful Queries

Find current records for an entity:

```sql
SELECT record_id, source_ref, source_system, source_entity_id, component_id
FROM entity_graph.company__clusters
WHERE entity_id = '<entity_id>'
ORDER BY source_ref, record_id;
```

Find active aliases:

```sql
SELECT entity_id, alias_entity_id, alias_reason, created_at
FROM entity_graph.company__entity_id_aliases
WHERE superseded_at IS NULL
ORDER BY created_at DESC;
```

Find reactivated IDs:

```sql
SELECT record_id, entity_id, previous_entity_id, component_id, created_at
FROM entity_graph.company__entity_id_events
WHERE event_type = 'reactivate'
ORDER BY created_at DESC;
```

Join downstream data through the crosswalk:

```sql
SELECT cw.entity_id, cw.source_system, cw.source_entity_id, p.display_name
FROM entity_graph.company__crosswalks cw
JOIN entity_graph.company__entity_profile p
  ON cw.entity_id = p.entity_id
WHERE p.superseded_at IS NULL;
```

## Migration Guidance

Existing projects do not need a manual migration. The first cluster run after stable IDs are available backfills the event log from the existing `__clusters` table when the stable tables are empty.

For downstream consumers:

- Prefer `entity_id` or `ENTITY_GRAPH_ENTITY_ID` for new work.
- Keep reading `cluster_id` only for backward compatibility.
- Do not persist `component_id` outside debugging workflows.
- After a merge, expect old entity IDs to appear in `__entity_id_aliases`.
- After a split/reactivation, expect an alias row to have `superseded_at` and the reactivated ID to appear in current tables again.
