# Entity Graph Simplification Roadmap Status

Dogsled carries a historical plan for a friendlier Entity Graph authoring surface. This page records which of those commands have shipped and which remain roadmap items.

## Shipped on `main`

**Drop 1:** `dogsled entity-graph build`, `dogsled entity-graph status`, `dogsled entity-graph audit list/verify`, `dogsled entity-graph review unmerge`, `dogsled entity-graph resolve report overview`

**Drop 8 (column-level lineage):** `dogsled entity-graph lineage compile`, `dogsled entity-graph lineage --entity <name> --attribute <attr>`, provenance blocks in `dogsled entity-graph explain --subject entity`

## Planned, not shipped on `main`

- `dogsled entity-graph quickstart`
- `dogsled entity-graph fixtures`
- `dogsled entity-graph unmerge`
- `dogsled entity-graph suggest thresholds`
- `dogsled entity-graph explain pair`
- `dogsled entity-graph scaffold`
- `dogsled entity-graph diff`
- `dogsled entity-graph resolve run --mode=direct`

## How to talk about them

- Present them as roadmap work or planned command surface.
- Do not tell users to run them unless the commands are actually registered for Entity Graph (for example under `packages/entity-graph/src/commands/` and wired through the `dogsled entity-graph` entrypoint).
- When a user wants the same outcome today, translate back to the shipped primitives.

## Current equivalents

| Planned command                   | Current fallback                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `entity-graph quickstart`         | Start from `packages/model-spec/examples/entity-graph-b2b-company-master/`, then use `resolve init`, `resolve run`, `review export/apply`, `resolve cluster`, and `resolve profile`. |
| `entity-graph fixtures`           | Use the example project and any committed seed data directly.                                                                                                                        |
| `entity-graph unmerge`            | No first-class command yet. Treat this as manual operator work until the command ships.                                                                                              |
| `entity-graph suggest thresholds` | Use `truthset score` and `truthset tune` if labeled pairs exist.                                                                                                                     |
| `entity-graph explain pair`       | Combine `resolve inspect pair` with `review show`.                                                                                                                                   |
| `entity-graph scaffold`           | Use `resolve init` and author the YAML manually.                                                                                                                                     |
| `entity-graph diff`               | Use `resolve compile`, `git diff`, and runtime inspection commands manually.                                                                                                         |
| `resolve run --mode=direct`       | Use the existing review loop explicitly.                                                                                                                                             |
