---
name: add-database-destination
description: Add a new database load destination (e.g., Snowflake, PostgreSQL,
  ClickHouse) to the @bobsled-inc/loader package. Implements the
  DatabaseDestination interface with full append/merge/full_refresh support.
exposed: true
triggers:
  - add database destination
  - add snowflake destination
  - add postgres load target
  - add clickhouse loader
  - new database load target
  - implement database destination
  - wire new destination
  - add warehouse load destination
---

# Add a Database Destination

Use this skill to add a database or warehouse loader destination.

## Workflow

1. Read the nearest package guide and inspect the existing implementation and tests.
2. Resolve the decisions below before editing.
3. Use the established schemas, interfaces, security helpers, and error contracts.
4. Implement the smallest compatible change with regression coverage.
5. Run the focused checks, then the repository gate.

## Decisions

- Choose the existing destination interface and isolate optional native dependencies.
- Define connection, schema evolution, append, merge, and full-refresh behavior.
- Reuse shared identifier quoting, redaction, transaction, and error contracts.

## Completion

- Cover configuration, SQL generation, schema evolution, and every supported load strategy.
- Use mocked connections unless a credentialed integration test is explicitly available.
- Run loader package gates and the repository precommit gate.

## Detailed Reference

Load the full reference only when the task needs its schemas, command tables, examples,
or troubleshooting detail:

{{include: .agents/skills/add-database-destination/references/full-guide.md}}
