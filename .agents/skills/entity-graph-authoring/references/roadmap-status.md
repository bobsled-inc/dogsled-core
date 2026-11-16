# Entity Graph Simplification Roadmap Status

Bobsled Core carries a historical plan for a friendlier Entity Graph authoring surface. This page records which of those commands have shipped and which remain roadmap items.

## Shipped on `main`

**Drop 1:** `bobsled entity-graph build`, `bobsled entity-graph status`, `bobsled entity-graph audit list/verify`, `bobsled entity-graph review unmerge`, `bobsled entity-graph resolve report overview`

**Drop 8 (column-level lineage):** `bobsled entity-graph lineage compile`, `bobsled entity-graph lineage --entity <name> --attribute <attr>`, provenance blocks in `bobsled entity-graph explain --subject entity`

## Planned, not shipped on `main`

- `bobsled entity-graph quickstart`
- `bobsled entity-graph fixtures`
- `bobsled entity-graph unmerge`
- `bobsled entity-graph suggest thresholds`
- `bobsled entity-graph explain pair`
- `bobsled entity-graph scaffold`
- `bobsled entity-graph diff`
- `bobsled entity-graph resolve run --mode=direct`

## How to talk about them

- Present them as roadmap work or planned command surface.
- Do not tell users to run them unless the commands are actually registered for Entity Graph (for example under `packages/entity-graph/src/commands/` and wired through the `bobsled entity-graph` entrypoint).
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
