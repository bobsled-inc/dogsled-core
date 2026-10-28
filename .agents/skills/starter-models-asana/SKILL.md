---
name: starter-models-asana
description: Curated starter analytics models, metrics, and relationships for Asana project and task management. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - asana starter models
  - prebuilt asana models
  - curated asana analytics models
  - standard asana data models
  - build asana marts
  - Asana analytics shape
  - models for asana
---

# Starter data models — Asana

Project and task management analytics models for Asana workspaces, projects, tasks, and users.

These are the **gold marts** for Asana — the canonical analytics
tables an analyst would build on top of the loaded Asana extract. Each
mart references a silver staging model named `stg_asana__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### asana\_\_portfolios

{{include: packages/models/marts/asana/asana__portfolios.yml}}

### asana\_\_projects

{{include: packages/models/marts/asana/asana__projects.yml}}

### asana\_\_task_completion_summary

{{include: packages/models/marts/asana/asana__task_completion_summary.yml}}

### asana\_\_tasks

{{include: packages/models/marts/asana/asana__tasks.yml}}

### asana\_\_task_projects

{{include: packages/models/marts/asana/asana__task_projects.yml}}

### asana\_\_users

{{include: packages/models/marts/asana/asana__users.yml}}

## Metrics

{{include: packages/models/marts/asana/metrics/asana_task_count.yml}}
{{include: packages/models/marts/asana/metrics/asana_completed_task_count.yml}}
{{include: packages/models/marts/asana/metrics/asana_project_count.yml}}

## Relationships

{{include: packages/models/marts/asana/relationships/asana_task_projects_to_projects.yml}}
{{include: packages/models/marts/asana/relationships/asana_task_projects_to_tasks.yml}}
{{include: packages/models/marts/asana/relationships/asana_tasks_to_users.yml}}
