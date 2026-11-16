---
name: entity-resolution
description: Set up entity resolution / golden records — author an entity-graph
  resolution spec, run it on an entity-graph pipeline, then review and apply the
  borderline-pair decisions.
exposed: true
triggers:
  - entity resolution
  - golden records
  - deduplicate records across sources
  - resolve customers or companies
  - merge duplicate accounts
  - clear the review queue
---

# Entity Resolution

Use this skill to configure, run, review, or operate Bobsled Core entity resolution.

## Workflow

1. Read the nearest package guide and inspect the existing implementation and tests.
2. Resolve the decisions below before editing.
3. Use the established schemas, interfaces, security helpers, and error contracts.
4. Implement the smallest compatible change with regression coverage.
5. Run the focused checks, then the repository gate.

## Decisions

- Confirm source grain, identifiers, standardization, blocking, scoring, and review thresholds.
- Choose full versus incremental operation and preserve review and inbox durability.
- Apply privacy controls to identifiers and keep write-capable access explicitly gated.

## Completion

- Validate and compile the resolution spec before execution.
- Exercise resolve, review, cluster, incremental-state, and privacy-sensitive behavior as applicable.
- Run Entity Graph package gates and the repository precommit gate.

## Detailed Reference

Load the full reference only when the task needs its schemas, command tables, examples,
or troubleshooting detail:

{{include: .agents/skills/entity-resolution/references/full-guide.md}}
