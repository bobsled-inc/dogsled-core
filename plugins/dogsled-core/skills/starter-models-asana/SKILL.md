---
name: starter-models-asana
description: Curated starter analytics models, metrics, and relationships for
  Asana project and task management. Pairs with the starter-data-models
  overview; adapt the bundle to the user's actually-loaded tables.
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

spec_version: '0.2'
name: asana__portfolios
type: model
description: Asana portfolio detail with workspace context.
grain: portfolio_id
source:
  ref: stg_asana__get_portfolios
joins:
  - ref: stg_asana__get_workspaces
    type: left
    on: stg_asana__get_portfolios.workspace_gid = stg_asana__get_workspaces.gid
columns:
  - name: portfolio_id
    expr: stg_asana__get_portfolios.gid
    primary_key: true
    semantic_role: entity_id
    description: Unique Asana portfolio identifier.
  - name: name
    expr: stg_asana__get_portfolios.name
    semantic_role: categorical
    description: Portfolio name.
  - name: workspace_name
    expr: COALESCE(stg_asana__get_workspaces.name, stg_asana__get_portfolios.workspace_name)
    semantic_role: categorical
    description: Name of the workspace that owns the portfolio.
tags:
  - asana
  - portfolios
  - project-management
trust_tier: gold
materialization:
  type: table

### asana\_\_projects

spec_version: '0.2'
name: asana__projects
type: model
description: Asana projects with workspace and team context.
grain: project_id
source:
  ref: stg_asana__get_projects
joins:
  - ref: stg_asana__get_workspaces
    type: left
    on: stg_asana__get_projects.workspace_gid = stg_asana__get_workspaces.gid
  - ref: stg_asana__get_workspace_teams
    type: left
    on: stg_asana__get_projects.team_gid = stg_asana__get_workspace_teams.gid
columns:
  - name: project_id
    expr: stg_asana__get_projects.gid
    primary_key: true
    semantic_role: entity_id
    description: Unique Asana project identifier.
  - name: name
    expr: stg_asana__get_projects.name
    semantic_role: categorical
    description: Project name.
  - name: archived
    expr: stg_asana__get_projects.archived
    semantic_role: categorical
    description: Whether the project is archived.
  - name: team_name
    expr: COALESCE(stg_asana__get_workspace_teams.name, stg_asana__get_projects.team_name)
    semantic_role: categorical
    description: Name of the team that owns the project.
  - name: workspace_name
    expr: COALESCE(stg_asana__get_workspaces.name, stg_asana__get_projects.workspace_name)
    semantic_role: categorical
    description: Name of the workspace.
  - name: created_at
    expr: stg_asana__get_projects.created_at
    semantic_role: event_timestamp
    description: Timestamp when the project was created.
tags:
  - asana
  - projects
  - project-management
trust_tier: gold
materialization:
  type: table

### asana\_\_task_completion_summary

spec_version: '0.2'
name: asana__task_completion_summary
type: model
description: Task counts by project and completion status.
grain:
  - project_id
  - completed
source:
  ref: stg_asana__get_task_projects
joins:
  - ref: stg_asana__get_tasks
    type: left
    on: stg_asana__get_task_projects.task_gid = stg_asana__get_tasks.gid
columns:
  - name: project_id
    expr: stg_asana__get_task_projects.project_gid
    primary_key: true
    semantic_role: entity_id
    description: Asana project GID.
  - name: project_name
    expr: stg_asana__get_task_projects.project_name
    semantic_role: categorical
    description: Project name.
  - name: completed
    expr: stg_asana__get_tasks.completed
    primary_key: true
    semantic_role: categorical
    description: Whether tasks in this bucket are completed.
  - name: task_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of tasks in the completion bucket.
group_by:
  - project_id
  - project_name
  - completed
tags:
  - asana
  - tasks
  - summary
trust_tier: gold
materialization:
  type: table

### asana\_\_tasks

spec_version: '0.2'
name: asana__tasks
type: model
description: Asana tasks enriched with assignee and workspace context.
grain: task_id
source:
  ref: stg_asana__get_tasks
joins:
  - ref: stg_asana__get_workspace_users
    type: left
    on: stg_asana__get_tasks.assignee_gid = stg_asana__get_workspace_users.gid
  - ref: stg_asana__get_workspaces
    type: left
    on: stg_asana__get_tasks.workspace_gid = stg_asana__get_workspaces.gid
columns:
  - name: task_id
    expr: stg_asana__get_tasks.gid
    primary_key: true
    semantic_role: entity_id
    description: Unique Asana task identifier.
  - name: name
    expr: stg_asana__get_tasks.name
    semantic_role: categorical
    description: Task name.
  - name: completed
    expr: stg_asana__get_tasks.completed
    semantic_role: categorical
    description: Whether the task is completed.
  - name: assignee_gid
    expr: stg_asana__get_tasks.assignee_gid
    semantic_role: entity_id
    references: stg_asana__get_workspace_users.gid
    description: GID of the assigned user.
  - name: assignee_name
    expr: COALESCE(stg_asana__get_workspace_users.name, stg_asana__get_tasks.assignee_name)
    semantic_role: categorical
    description: Display name of the assigned user.
  - name: workspace_gid
    expr: stg_asana__get_tasks.workspace_gid
    semantic_role: entity_id
    references: stg_asana__get_workspaces.gid
    description: GID of the workspace.
  - name: workspace_name
    expr: COALESCE(stg_asana__get_workspaces.name, stg_asana__get_tasks.workspace_name)
    semantic_role: categorical
    description: Name of the workspace.
  - name: due_at
    expr: stg_asana__get_tasks.due_at
    semantic_role: time_dimension
    description: Timestamp when the task is due.
  - name: due_on
    expr: stg_asana__get_tasks.due_on
    semantic_role: time_dimension
    description: Date when the task is due.
  - name: completed_at
    expr: stg_asana__get_tasks.completed_at
    semantic_role: event_timestamp
    description: Timestamp when the task was completed.
  - name: created_at
    expr: stg_asana__get_tasks.created_at
    semantic_role: event_timestamp
    description: Timestamp when the task was created.
  - name: modified_at
    expr: stg_asana__get_tasks.modified_at
    semantic_role: event_timestamp
    description: Timestamp when the task was last modified.
tags:
  - asana
  - tasks
  - project-management
trust_tier: gold
materialization:
  type: table

### asana\_\_task_projects

spec_version: '0.2'
name: asana__task_projects
type: model
description: Bridge between Asana tasks and every project that contains each task.
grain:
  - task_id
  - project_id
source:
  ref: stg_asana__get_task_projects
columns:
  - name: task_id
    expr: stg_asana__get_task_projects.task_gid
    primary_key: true
    semantic_role: entity_id
    references: stg_asana__get_tasks.gid
    description: Task contained in the project.
  - name: project_id
    expr: stg_asana__get_task_projects.project_gid
    primary_key: true
    semantic_role: entity_id
    references: stg_asana__get_projects.gid
    description: Project that contains the task.
  - name: project_name
    expr: stg_asana__get_task_projects.project_name
    semantic_role: categorical
    description: Name of the project that contains the task.
tags:
  - asana
  - tasks
  - projects
trust_tier: gold
materialization:
  type: table

### asana\_\_users

spec_version: '0.2'
name: asana__users
type: model
description: Asana workspace users with task rollups.
grain: user_id
source:
  ref: stg_asana__get_workspace_users
joins:
  - ref: stg_asana__get_tasks
    type: left
    on: stg_asana__get_workspace_users.gid = stg_asana__get_tasks.assignee_gid
    pre_aggregate:
      group_by:
        - assignee_gid
      columns:
        - name: task_count
          expr: COUNT(*)
        - name: completed_task_count
          expr: countif(completed = true)
columns:
  - name: user_id
    expr: stg_asana__get_workspace_users.gid
    primary_key: true
    semantic_role: entity_id
    description: Unique Asana user identifier.
  - name: name
    expr: stg_asana__get_workspace_users.name
    semantic_role: categorical
    description: User display name.
  - name: email
    expr: stg_asana__get_workspace_users.email
    semantic_role: categorical
    description: User email address.
  - name: task_count
    expr: COALESCE(stg_asana__get_tasks.task_count, 0)
    semantic_role: measure
    description: Number of tasks assigned to the user.
  - name: completed_task_count
    expr: COALESCE(stg_asana__get_tasks.completed_task_count, 0)
    semantic_role: measure
    description: Number of completed tasks assigned to the user.
tags:
  - asana
  - users
  - project-management
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: asana_task_count
description: Number of Asana tasks.
model: asana__tasks
expression: COUNT({asana__tasks}.task_id)
synonyms: [tasks, task count, number of tasks]
tags: [asana, productivity, planning]
spec_version: '0.2'
type: metric
name: asana_completed_task_count
description: Number of Asana tasks marked as completed.
model: asana__tasks
expression: SUM(CASE WHEN {asana__tasks}.completed THEN 1 ELSE 0 END)
synonyms: [completed tasks, finished tasks, tasks completed]
tags: [asana, productivity, delivery]
spec_version: '0.2'
type: metric
name: asana_project_count
description: Number of Asana projects.
model: asana__projects
expression: COUNT({asana__projects}.project_id)
synonyms: [projects, project count, number of projects]
tags: [asana, productivity, planning]

## Relationships

spec_version: '0.2'
type: relationship
name: asana_task_projects_to_projects
description: Each Asana task-project membership belongs to one project.
left_model: asana__task_projects
right_model: asana__projects
join_columns:
  - left: project_id
    right: project_id
join_type: left
relationship_type: many_to_one
tags: [asana, tasks, projects]
spec_version: '0.2'
type: relationship
name: asana_task_projects_to_tasks
description: Each Asana task-project membership belongs to one task.
left_model: asana__task_projects
right_model: asana__tasks
join_columns:
  - left: task_id
    right: task_id
join_type: left
relationship_type: many_to_one
tags: [asana, task-projects, tasks]
spec_version: '0.2'
type: relationship
name: asana_tasks_to_users
description: Each Asana task can be assigned to one user.
left_model: asana__tasks
right_model: asana__users
join_columns:
  - left: assignee_gid
    right: user_id
join_type: left
relationship_type: many_to_one
tags: [asana, tasks, users]
