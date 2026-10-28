---
name: add-warehouse-source
description: Add a new warehouse or database extractor source to
  @bobsled-inc/extractor. Guides through schema definitions, client
  implementation, SQL dialect support, type mappings, factory wiring, and tests.
exposed: true
triggers:
  - add warehouse source
  - add database extractor
  - support new sql database
  - add clickhouse source
  - add oracle extractor
  - new warehouse connector
  - implement warehouse client
  - add database source type
---

# Add a Warehouse Source

Use this skill to add or extend a warehouse/database extractor source.

## Workflow

1. Read the nearest package guide and inspect the existing implementation and tests.
2. Resolve the decisions below before editing.
3. Use the established schemas, interfaces, security helpers, and error contracts.
4. Implement the smallest compatible change with regression coverage.
5. Run the focused checks, then the repository gate.

## Decisions

- Identify the dialect, authentication shape, discovery behavior, and replication modes.
- Reuse the shared warehouse schemas, client interfaces, query builder, and type mapper.
- Keep credentials indirect, quote identifiers per dialect, and bound reads and retries.

## Completion

- Validate configuration and schema discovery.
- Cover query generation, cursor/state behavior, errors, and mocked client execution.
- Run extractor package gates and the repository precommit gate.

## Detailed Reference

Load the full reference only when the task needs its schemas, command tables, examples,
or troubleshooting detail:

{{include: .agents/skills/add-warehouse-source/references/full-guide.md}}
