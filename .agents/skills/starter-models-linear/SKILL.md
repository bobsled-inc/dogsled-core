---
name: starter-models-linear
description: Curated starter analytics models, metrics, and relationships for Linear. Engineering delivery semantics for Linear issues, projects, cycles, and team workload. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - linear starter models
  - prebuilt linear models
  - curated linear analytics models
  - standard linear data models
  - build linear marts
  - Linear analytics shape
  - models for linear
---

# Starter data models — Linear

Engineering delivery models for Linear issues, projects, and team workload.

This bundle contains the **gold marts, metrics, and relationships** for
Linear—the canonical analytics layer an analyst would build on top of the loaded Linear extract. Each
mart references a silver staging model named `stg_linear__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
trim columns whose staging field is absent, and remove metadata that references
pruned models. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### linear\_\_comments

{{include: packages/models/marts/linear/linear__comments.yml}}

### linear\_\_cycle_velocity

{{include: packages/models/marts/linear/linear__cycle_velocity.yml}}

### linear\_\_cycles

{{include: packages/models/marts/linear/linear__cycles.yml}}

### linear\_\_issue_state_summary

{{include: packages/models/marts/linear/linear__issue_state_summary.yml}}

### linear\_\_issue_summary_by_team

{{include: packages/models/marts/linear/linear__issue_summary_by_team.yml}}

### linear\_\_issues

{{include: packages/models/marts/linear/linear__issues.yml}}

### linear\_\_project_delivery

{{include: packages/models/marts/linear/linear__project_delivery.yml}}

### linear\_\_projects

{{include: packages/models/marts/linear/linear__projects.yml}}

### linear\_\_roadmaps

{{include: packages/models/marts/linear/linear__roadmaps.yml}}

### linear\_\_team_workload

{{include: packages/models/marts/linear/linear__team_workload.yml}}

## Metrics

{{include: packages/models/marts/linear/metrics/linear_issue_count.yml}}

{{include: packages/models/marts/linear/metrics/linear_completed_issue_count.yml}}

{{include: packages/models/marts/linear/metrics/linear_completed_estimate.yml}}

## Relationships

{{include: packages/models/marts/linear/relationships/linear_comments_to_issues.yml}}

{{include: packages/models/marts/linear/relationships/linear_cycle_velocity_to_cycles.yml}}

{{include: packages/models/marts/linear/relationships/linear_project_delivery_to_projects.yml}}
