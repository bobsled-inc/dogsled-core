---
name: starter-models-linear
description: Curated starter analytics models, metrics, and relationships for
  Linear. Engineering delivery semantics for Linear issues, projects, cycles,
  and team workload. Pairs with the starter-data-models overview; adapt the
  bundle to the user's actually-loaded tables.
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

spec_version: '0.2'
name: linear__comments
type: model
description: Issue comments for collaboration and resolution analysis.
grain: comment_id
source:
  ref: stg_linear__comments
columns:
  - name: comment_id
    expr: stg_linear__comments.comment_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Linear comment identifier.
  - name: issue_id
    expr: stg_linear__comments.issue_id
    semantic_role: entity_id
    references: stg_linear__issues.issue_id
    description: Issue this comment belongs to.
  - name: issue_identifier
    expr: stg_linear__comments.issue_identifier
    semantic_role: categorical
    description: Human-readable issue identifier (e.g. TEAM-{number}).
  - name: user_id
    expr: stg_linear__comments.user_id
    semantic_role: entity_id
    description: Author of the comment.
  - name: user_name
    expr: stg_linear__comments.user_name
    semantic_role: categorical
    description: Display name of the comment author.
  - name: parent_id
    expr: stg_linear__comments.parent_id
    semantic_role: entity_id
    description: Parent comment ID for threaded replies.
  - name: resolved_at
    expr: stg_linear__comments.resolved_at
    semantic_role: event_timestamp
    description: Timestamp when the comment thread was resolved.
  - name: created_at
    expr: stg_linear__comments.created_at
    semantic_role: event_timestamp
    description: Timestamp when the comment was posted.
  - name: updated_at
    expr: stg_linear__comments.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the comment was last updated.
tags:
  - linear
  - comments
trust_tier: gold
materialization:
  type: table

### linear\_\_cycle_velocity

spec_version: '0.2'
name: linear__cycle_velocity
type: model
description: Cycle velocity with progress and schedule timestamps per team, useful for sprint-over-sprint comparison.
grain: cycle_id
source:
  ref: stg_linear__cycles
columns:
  - name: cycle_id
    expr: stg_linear__cycles.cycle_id
    primary_key: true
    semantic_role: entity_id
    description: Unique cycle identifier.
  - name: team_id
    expr: stg_linear__cycles.team_id
    semantic_role: entity_id
    description: Team that owns this cycle.
  - name: team_name
    expr: stg_linear__cycles.team_name
    semantic_role: categorical
    description: Team display name.
  - name: number
    expr: stg_linear__cycles.number
    semantic_role: categorical
    description: Sequential cycle number within the team.
  - name: progress
    expr: stg_linear__cycles.progress
    semantic_role: measure
    description: Completion progress as a decimal between 0 and 1.
  - name: starts_at
    expr: stg_linear__cycles.starts_at
    semantic_role: event_timestamp
    description: Cycle start timestamp.
  - name: ends_at
    expr: stg_linear__cycles.ends_at
    semantic_role: event_timestamp
    description: Cycle end timestamp.
  - name: completed_at
    expr: stg_linear__cycles.completed_at
    semantic_role: event_timestamp
    description: Cycle completion timestamp.
tags:
  - linear
  - cycles
  - velocity
trust_tier: gold
materialization:
  type: table

### linear\_\_cycles

spec_version: '0.2'
name: linear__cycles
type: model
description: Sprint cycles with date bounds, progress, and team association.
grain: cycle_id
source:
  ref: stg_linear__cycles
columns:
  - name: cycle_id
    expr: stg_linear__cycles.cycle_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Linear cycle identifier.
  - name: number
    expr: stg_linear__cycles.number
    semantic_role: categorical
    description: Sequential cycle number within the team.
  - name: name
    expr: stg_linear__cycles.name
    semantic_role: categorical
    description: Optional human-readable cycle name.
  - name: starts_at
    expr: stg_linear__cycles.starts_at
    semantic_role: event_timestamp
    description: Timestamp when the cycle is scheduled to begin.
  - name: ends_at
    expr: stg_linear__cycles.ends_at
    semantic_role: event_timestamp
    description: Timestamp when the cycle is scheduled to end.
  - name: completed_at
    expr: stg_linear__cycles.completed_at
    semantic_role: event_timestamp
    description: Timestamp when the cycle was marked as completed.
  - name: progress
    expr: stg_linear__cycles.progress
    semantic_role: measure
    description: Completion progress as a decimal between 0 and 1.
  - name: team_id
    expr: stg_linear__cycles.team_id
    semantic_role: entity_id
    description: UUID of the team that owns this cycle.
  - name: team_name
    expr: stg_linear__cycles.team_name
    semantic_role: categorical
    description: Display name of the owning team.
  - name: team_key
    expr: stg_linear__cycles.team_key
    semantic_role: categorical
    description: Short key prefix of the owning team.
  - name: created_at
    expr: stg_linear__cycles.created_at
    semantic_role: event_timestamp
    description: Timestamp when the cycle was created.
  - name: updated_at
    expr: stg_linear__cycles.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the cycle was last modified.
tags:
  - linear
  - cycles
trust_tier: gold
materialization:
  type: table

### linear\_\_issue_state_summary

spec_version: '0.2'
name: linear__issue_state_summary
type: model
description: Issue volume, average estimate, and priority grouped by workflow state type.
grain: state_type
source:
  ref: stg_linear__issues
columns:
  - name: state_type
    expr: stg_linear__issues.state_type
    primary_key: true
    semantic_role: categorical
    description: Workflow state type (backlog, unstarted, started, completed, cancelled).
  - name: issue_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of issues in this state type.
  - name: avg_estimate
    expr: AVG(stg_linear__issues.estimate)
    semantic_role: measure
    description: Average estimate in points for issues in this state type.
  - name: avg_priority
    expr: AVG(stg_linear__issues.priority)
    semantic_role: measure
    description: Average priority rank for issues in this state type.
group_by:
  - state_type
tags:
  - linear
  - issues
  - summary
trust_tier: gold
materialization:
  type: table

### linear\_\_issue_summary_by_team

spec_version: '0.2'
name: linear__issue_summary_by_team
type: model
description: Issue volume, estimate, and average priority grouped by team and state type.
grain:
  - team_id
  - state_type
source:
  ref: stg_linear__issues
columns:
  - name: team_id
    expr: stg_linear__issues.team_id
    semantic_role: entity_id
    description: Stable Linear team identifier.
  - name: team_name
    expr: stg_linear__issues.team_name
    semantic_role: categorical
    description: Team display name.
  - name: state_type
    expr: stg_linear__issues.state_type
    semantic_role: categorical
    description: State category such as started or completed.
  - name: issue_count
    expr: COUNT(*)
    semantic_role: measure
    description: Count of issues for the team and state bucket.
  - name: total_estimate
    expr: SUM(stg_linear__issues.estimate)
    semantic_role: measure
    description: Sum of issue estimates in the bucket.
  - name: avg_priority
    expr: AVG(stg_linear__issues.priority)
    semantic_role: measure
    description: Average priority level in the bucket.
group_by:
  - team_id
  - state_type
  - team_name
tags:
  - linear
  - teams
trust_tier: gold
materialization:
  type: table

### linear\_\_issues

spec_version: '0.2'
name: linear__issues
type: model
description: Detailed Linear issues with team and project metadata.
grain: issue_id
source:
  ref: stg_linear__issues
columns:
  - name: issue_id
    expr: stg_linear__issues.issue_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Linear issue identifier.
  - name: identifier
    expr: stg_linear__issues.identifier
    semantic_role: categorical
    description: Human-readable issue identifier.
  - name: title
    expr: stg_linear__issues.title
    semantic_role: categorical
    description: Issue title.
  - name: priority
    expr: stg_linear__issues.priority
    semantic_role: measure
    description: Priority rank used by Linear.
  - name: estimate
    expr: stg_linear__issues.estimate
    semantic_role: measure
    description: Issue estimate in points.
  - name: state_name
    expr: stg_linear__issues.state_name
    semantic_role: categorical
    description: Workflow state name.
  - name: state_type
    expr: stg_linear__issues.state_type
    semantic_role: categorical
    description: Workflow state type category.
  - name: team_name
    expr: stg_linear__issues.team_name
    semantic_role: categorical
    description: Owning Linear team.
  - name: project_name
    expr: stg_linear__issues.project_name
    semantic_role: categorical
    description: Parent project name.
  - name: created_at
    expr: stg_linear__issues.created_at
    semantic_role: event_timestamp
    description: Timestamp when the issue was created.
  - name: completed_at
    expr: stg_linear__issues.completed_at
    semantic_role: event_timestamp
    description: Timestamp when the issue was completed.
tags:
  - linear
  - issues
trust_tier: gold
materialization:
  type: table

### linear\_\_project_delivery

spec_version: '0.2'
name: linear__project_delivery
type: model
description: Project-level delivery summary built from project records and associated issues.
grain: project_id
source:
  ref: stg_linear__projects
joins:
  - ref: stg_linear__issues
    type: left
    on: stg_linear__projects.project_id = stg_linear__issues.project_id
    pre_aggregate:
      group_by:
        - project_id
      columns:
        - name: issue_count
          expr: COUNT(*)
        - name: completed_issue_count
          expr: SUM(CASE WHEN state_type = 'completed' THEN 1 ELSE 0 END)
        - name: open_issue_count
          expr: SUM(CASE WHEN state_type != 'completed' THEN 1 ELSE 0 END)
        - name: avg_estimate
          expr: AVG(estimate)
columns:
  - name: project_id
    expr: stg_linear__projects.project_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Linear project identifier.
  - name: name
    expr: stg_linear__projects.name
    semantic_role: categorical
    description: Project name.
  - name: state
    expr: stg_linear__projects.state
    semantic_role: categorical
    description: Current project state.
  - name: progress
    expr: stg_linear__projects.progress
    semantic_role: measure
    description: Current completion progress as a decimal.
  - name: issue_count
    expr: COALESCE(stg_linear__issues.issue_count, 0)
    semantic_role: measure
    description: Count of issues attached to the project.
  - name: completed_issue_count
    expr: COALESCE(stg_linear__issues.completed_issue_count, 0)
    semantic_role: measure
    description: Count of completed issues attached to the project.
  - name: open_issue_count
    expr: COALESCE(stg_linear__issues.open_issue_count, 0)
    semantic_role: measure
    description: Count of non-completed issues attached to the project.
  - name: avg_estimate
    expr: stg_linear__issues.avg_estimate
    semantic_role: measure
    description: Average issue estimate for the project.
  - name: target_date
    expr: stg_linear__projects.target_date
    semantic_role: time_dimension
    description: Target completion date for the project.
tags:
  - linear
  - projects
  - delivery
trust_tier: gold
materialization:
  type: table

### linear\_\_projects

spec_version: '0.2'
name: linear__projects
type: model
description: Linear projects with owner, schedule, and current progress fields.
grain: project_id
source:
  ref: stg_linear__projects
columns:
  - name: project_id
    expr: stg_linear__projects.project_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Linear project identifier.
  - name: name
    expr: stg_linear__projects.name
    semantic_role: categorical
    description: Project name.
  - name: state
    expr: stg_linear__projects.state
    semantic_role: categorical
    description: Current project state.
  - name: progress
    expr: stg_linear__projects.progress
    semantic_role: measure
    description: Current progress as a decimal from 0 to 1.
  - name: lead_name
    expr: stg_linear__projects.lead_name
    semantic_role: categorical
    description: Project lead display name.
  - name: target_date
    expr: stg_linear__projects.target_date
    semantic_role: time_dimension
    description: Target completion date for the project.
tags:
  - linear
  - projects
trust_tier: gold
materialization:
  type: table

### linear\_\_roadmaps

spec_version: '0.2'
name: linear__roadmaps
type: model
description: Roadmap entities for organizing projects and initiatives.
grain: roadmap_id
source:
  ref: stg_linear__roadmaps
columns:
  - name: roadmap_id
    expr: stg_linear__roadmaps.roadmap_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Linear roadmap identifier.
  - name: name
    expr: stg_linear__roadmaps.name
    semantic_role: categorical
    description: Roadmap name.
  - name: description
    expr: stg_linear__roadmaps.description
    semantic_role: categorical
    description: Roadmap description in markdown.
  - name: slug_id
    expr: stg_linear__roadmaps.slug_id
    semantic_role: entity_id
    description: URL-safe slug for shareable links.
  - name: creator_id
    expr: stg_linear__roadmaps.creator_id
    semantic_role: entity_id
    description: User who created the roadmap.
  - name: creator_name
    expr: stg_linear__roadmaps.creator_name
    semantic_role: categorical
    description: Display name of the roadmap creator.
  - name: created_at
    expr: stg_linear__roadmaps.created_at
    semantic_role: event_timestamp
    description: Timestamp when the roadmap was created.
  - name: updated_at
    expr: stg_linear__roadmaps.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the roadmap was last modified.
tags:
  - linear
  - roadmaps
trust_tier: gold
materialization:
  type: table

### linear\_\_team_workload

spec_version: '0.2'
name: linear__team_workload
type: model
description: Team-level workload summary derived from issue assignments and workflow states.
grain: team_id
source:
  ref: stg_linear__teams
joins:
  - ref: stg_linear__issues
    type: left
    on: stg_linear__teams.team_id = stg_linear__issues.team_id
    pre_aggregate:
      group_by:
        - team_id
      columns:
        - name: issue_count
          expr: COUNT(*)
        - name: started_issue_count
          expr: SUM(CASE WHEN state_type = 'started' THEN 1 ELSE 0 END)
        - name: completed_issue_count
          expr: SUM(CASE WHEN state_type = 'completed' THEN 1 ELSE 0 END)
        - name: total_estimate
          expr: SUM(estimate)
columns:
  - name: team_id
    expr: stg_linear__teams.team_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Linear team identifier.
  - name: name
    expr: stg_linear__teams.name
    semantic_role: categorical
    description: Team name.
  - name: key
    expr: stg_linear__teams.key
    semantic_role: categorical
    description: Team key prefix.
  - name: issue_count
    expr: COALESCE(stg_linear__issues.issue_count, 0)
    semantic_role: measure
    description: Total issues assigned to the team.
  - name: started_issue_count
    expr: COALESCE(stg_linear__issues.started_issue_count, 0)
    semantic_role: measure
    description: Issues currently in started states for the team.
  - name: completed_issue_count
    expr: COALESCE(stg_linear__issues.completed_issue_count, 0)
    semantic_role: measure
    description: Completed issues for the team.
  - name: total_estimate
    expr: COALESCE(stg_linear__issues.total_estimate, 0)
    semantic_role: measure
    description: Total issue estimate points assigned to the team.
tags:
  - linear
  - teams
  - workload
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: linear_issue_count
description: Number of Linear issues.
model: linear__issues
expression: COUNT({linear__issues}.issue_id)
synonyms:
  - issues
  - issue count
  - number of issues
tags:
  - linear
  - engineering
  - planning

spec_version: '0.2'
type: metric
name: linear_completed_issue_count
description: Number of Linear issues with a completion timestamp.
model: linear__issues
expression: SUM(CASE WHEN {linear__issues}.completed_at IS NOT NULL THEN 1 ELSE 0 END)
synonyms:
  - completed issues
  - finished issues
  - issues completed
tags:
  - linear
  - engineering
  - delivery

spec_version: '0.2'
type: metric
name: linear_completed_estimate
description: Total estimate assigned to completed Linear issues.
model: linear__issues
expression: SUM(CASE WHEN {linear__issues}.completed_at IS NOT NULL THEN {linear__issues}.estimate ELSE 0 END)
synonyms:
  - completed estimate
  - completed points
  - delivered estimate
tags:
  - linear
  - engineering
  - delivery

## Relationships

spec_version: '0.2'
type: relationship
name: linear_comments_to_issues
description: Each Linear comment belongs to one issue.
left_model: linear__comments
right_model: linear__issues
join_columns:
  - left: issue_id
    right: issue_id
join_type: left
relationship_type: many_to_one
tags:
  - linear
  - engineering
  - collaboration

spec_version: '0.2'
type: relationship
name: linear_cycle_velocity_to_cycles
description: Each Linear cycle velocity row summarizes one cycle.
left_model: linear__cycle_velocity
right_model: linear__cycles
join_columns:
  - left: cycle_id
    right: cycle_id
join_type: left
relationship_type: one_to_one
tags:
  - linear
  - engineering
  - delivery

spec_version: '0.2'
type: relationship
name: linear_project_delivery_to_projects
description: Each Linear project delivery row summarizes one project.
left_model: linear__project_delivery
right_model: linear__projects
join_columns:
  - left: project_id
    right: project_id
join_type: left
relationship_type: one_to_one
tags:
  - linear
  - engineering
  - planning
