---
name: starter-models-jira
description: Curated starter analytics models, metrics, and relationships for
  Jira engineering delivery. Pairs with the starter-data-models overview; adapt
  the bundle to the user's actually-loaded tables.
---

# Starter data models — Jira

Engineering delivery analytics models for Jira projects, issues, boards, sprints, and worklogs.

These are the **gold marts** for Jira — the canonical analytics
tables an analyst would build on top of the loaded Jira extract. Each
mart references a silver staging model named `stg_jira__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### jira\_\_boards

spec_version: '0.2'
name: jira__boards
type: model
description: Jira boards enriched with linked project metadata and sprint rollups.
grain: board_id
source:
  ref: stg_jira__boards
joins:
  - ref: stg_jira__search_projects
    type: left
    on: stg_jira__boards.location_project_key = stg_jira__search_projects.key
  - ref: stg_jira__sprints
    type: left
    on: stg_jira__boards.board_id = stg_jira__sprints.board_id
    pre_aggregate:
      group_by:
        - board_id
      columns:
        - name: sprint_count
          expr: COUNT(*)
        - name: active_sprint_count
          expr: countif(state = 'active')
        - name: closed_sprint_count
          expr: countif(state = 'closed')
        - name: future_sprint_count
          expr: countif(state = 'future')
columns:
  - name: board_id
    expr: stg_jira__boards.board_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Jira board identifier.
  - name: board_name
    expr: stg_jira__boards.name
    semantic_role: categorical
    description: Board name.
  - name: board_type
    expr: stg_jira__boards.type
    semantic_role: categorical
    description: Board type such as scrum or kanban.
  - name: project_id
    expr: stg_jira__search_projects.search_project_id
    semantic_role: entity_id
    references: stg_jira__search_projects.search_project_id
    description: Linked Jira project identifier.
  - name: project_key
    expr: stg_jira__boards.location_project_key
    semantic_role: categorical
    description: Project key where the board is located.
  - name: project_name
    expr: COALESCE(stg_jira__search_projects.name, stg_jira__boards.location_project_name)
    semantic_role: categorical
    description: Project name where the board is located.
  - name: sprint_count
    expr: COALESCE(stg_jira__sprints.sprint_count, 0)
    semantic_role: measure
    description: Number of sprints associated with the board.
  - name: active_sprint_count
    expr: COALESCE(stg_jira__sprints.active_sprint_count, 0)
    semantic_role: measure
    description: Number of active sprints on the board.
  - name: closed_sprint_count
    expr: COALESCE(stg_jira__sprints.closed_sprint_count, 0)
    semantic_role: measure
    description: Number of closed sprints on the board.
  - name: future_sprint_count
    expr: COALESCE(stg_jira__sprints.future_sprint_count, 0)
    semantic_role: measure
    description: Number of future sprints on the board.
tags:
  - jira
  - boards
  - engineering
trust_tier: gold
materialization:
  type: table

### jira\_\_issue_status_summary

spec_version: '0.2'
name: jira__issue_status_summary
type: model
description: Jira issue summary by project and workflow status.
grain:
  - project_id
  - status_id
source:
  ref: stg_jira__search_issues
columns:
  - name: project_id
    expr: stg_jira__search_issues.project_id
    semantic_role: entity_id
    description: Jira project identifier.
  - name: project_key
    expr: stg_jira__search_issues.project_key
    semantic_role: categorical
    description: Jira project key.
  - name: project_name
    expr: stg_jira__search_issues.project_name
    semantic_role: categorical
    description: Jira project name.
  - name: status_id
    expr: stg_jira__search_issues.status_id
    semantic_role: entity_id
    description: Jira workflow status identifier.
  - name: status_name
    expr: stg_jira__search_issues.status_name
    semantic_role: categorical
    description: Jira workflow status name.
  - name: status_category_key
    expr: stg_jira__search_issues.status_category_key
    semantic_role: categorical
    description: Jira status category key.
  - name: issue_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of issues in the status bucket.
  - name: resolved_issue_count
    expr: countif(stg_jira__search_issues.resolution_date IS NOT NULL)
    semantic_role: measure
    description: Number of issues with a resolution timestamp.
  - name: assignee_count
    expr: count_distinct(stg_jira__search_issues.assignee_account_id)
    semantic_role: measure
    description: Number of distinct assignees represented in the bucket.
  - name: avg_time_spent_seconds
    expr: AVG(stg_jira__search_issues.time_spent)
    semantic_role: measure
    description: Average time spent across issues in the bucket, in seconds.
  - name: avg_remaining_estimate_seconds
    expr: AVG(stg_jira__search_issues.time_estimate)
    semantic_role: measure
    description: Average remaining estimate across issues in the bucket, in seconds.
group_by:
  - project_id
  - project_key
  - project_name
  - status_id
  - status_name
  - status_category_key
tags:
  - jira
  - issues
  - summary
trust_tier: gold
materialization:
  type: table

### jira\_\_issues

spec_version: '0.2'
name: jira__issues
type: model
description: Detailed Jira issues enriched with project and priority metadata.
grain: issue_id
source:
  ref: stg_jira__search_issues
joins:
  - ref: stg_jira__search_projects
    type: left
    on: stg_jira__search_issues.project_id = stg_jira__search_projects.search_project_id
  - ref: stg_jira__search_priorities
    type: left
    on: stg_jira__search_issues.priority_id = stg_jira__search_priorities.search_priority_id
columns:
  - name: issue_id
    expr: stg_jira__search_issues.search_issue_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Jira issue identifier.
  - name: issue_key
    expr: stg_jira__search_issues.key
    semantic_role: categorical
    description: Human-readable Jira issue key.
  - name: summary
    expr: stg_jira__search_issues.summary
    semantic_role: categorical
    description: Issue summary.
  - name: project_id
    expr: stg_jira__search_issues.project_id
    semantic_role: entity_id
    references: stg_jira__search_projects.search_project_id
    description: Project that owns the issue.
  - name: project_key
    expr: stg_jira__search_issues.project_key
    semantic_role: categorical
    description: Short project key.
  - name: project_name
    expr: COALESCE(stg_jira__search_projects.name, stg_jira__search_issues.project_name)
    semantic_role: categorical
    description: Project name.
  - name: issue_type_id
    expr: stg_jira__search_issues.issue_type_id
    semantic_role: entity_id
    description: Issue type identifier.
  - name: issue_type_name
    expr: stg_jira__search_issues.issue_type_name
    semantic_role: categorical
    description: Issue type name.
  - name: status_id
    expr: stg_jira__search_issues.status_id
    semantic_role: entity_id
    description: Workflow status identifier.
  - name: status_name
    expr: stg_jira__search_issues.status_name
    semantic_role: categorical
    description: Workflow status name.
  - name: status_category_key
    expr: stg_jira__search_issues.status_category_key
    semantic_role: categorical
    description: Jira status category key such as new, indeterminate, or done.
  - name: priority_id
    expr: stg_jira__search_issues.priority_id
    semantic_role: entity_id
    references: stg_jira__search_priorities.search_priority_id
    description: Priority identifier.
  - name: priority_name
    expr: COALESCE(stg_jira__search_priorities.name, stg_jira__search_issues.priority_name)
    semantic_role: categorical
    description: Priority name.
  - name: assignee_account_id
    expr: stg_jira__search_issues.assignee_account_id
    semantic_role: entity_id
    description: Account ID of the assigned user.
  - name: assignee_display_name
    expr: stg_jira__search_issues.assignee_display_name
    semantic_role: categorical
    description: Display name of the assigned user.
  - name: reporter_account_id
    expr: stg_jira__search_issues.reporter_account_id
    semantic_role: entity_id
    description: Account ID of the reporting user.
  - name: reporter_display_name
    expr: stg_jira__search_issues.reporter_display_name
    semantic_role: categorical
    description: Display name of the reporting user.
  - name: creator_account_id
    expr: stg_jira__search_issues.creator_account_id
    semantic_role: entity_id
    description: Account ID of the issue creator.
  - name: creator_display_name
    expr: stg_jira__search_issues.creator_display_name
    semantic_role: categorical
    description: Display name of the issue creator.
  - name: resolution_name
    expr: stg_jira__search_issues.resolution_name
    semantic_role: categorical
    description: Resolution name when the issue is complete.
  - name: due_date
    expr: stg_jira__search_issues.due_date
    semantic_role: time_dimension
    description: Due date for the issue.
  - name: created_at
    expr: stg_jira__search_issues.created_at
    semantic_role: event_timestamp
    description: Timestamp when the issue was created.
  - name: updated_at
    expr: stg_jira__search_issues.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the issue was last updated.
  - name: resolution_date
    expr: stg_jira__search_issues.resolution_date
    semantic_role: event_timestamp
    description: Timestamp when the issue was resolved.
  - name: remaining_estimate_seconds
    expr: stg_jira__search_issues.time_estimate
    semantic_role: measure
    description: Remaining estimate in seconds.
  - name: aggregate_remaining_estimate_seconds
    expr: stg_jira__search_issues.aggregate_time_estimate
    semantic_role: measure
    description: Aggregate remaining estimate in seconds.
  - name: time_spent_seconds
    expr: stg_jira__search_issues.time_spent
    semantic_role: measure
    description: Time spent on the issue in seconds.
  - name: parent_issue_id
    expr: stg_jira__search_issues.parent_id
    semantic_role: entity_id
    description: Parent issue identifier for subtasks.
  - name: parent_issue_key
    expr: stg_jira__search_issues.parent_key
    semantic_role: categorical
    description: Parent issue key for subtasks.
tags:
  - jira
  - issues
  - engineering
trust_tier: gold
materialization:
  type: table

### jira\_\_projects

spec_version: '0.2'
name: jira__projects
type: model
description: Jira projects enriched with issue and board rollups.
grain: project_id
source:
  ref: stg_jira__search_projects
joins:
  - ref: stg_jira__search_issues
    type: left
    on: stg_jira__search_projects.search_project_id = stg_jira__search_issues.project_id
    pre_aggregate:
      group_by:
        - project_id
      columns:
        - name: issue_count
          expr: COUNT(*)
        - name: done_issue_count
          expr: countif(status_category_key = 'done')
        - name: total_time_spent_seconds
          expr: SUM(time_spent)
        - name: total_remaining_estimate_seconds
          expr: SUM(time_estimate)
  - ref: stg_jira__boards
    type: left
    on: stg_jira__search_projects.key = stg_jira__boards.location_project_key
    pre_aggregate:
      group_by:
        - location_project_key
      columns:
        - name: board_count
          expr: COUNT(*)
        - name: scrum_board_count
          expr: countif(type = 'scrum')
        - name: kanban_board_count
          expr: countif(type = 'kanban')
columns:
  - name: project_id
    expr: stg_jira__search_projects.search_project_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Jira project identifier.
  - name: project_key
    expr: stg_jira__search_projects.key
    semantic_role: categorical
    description: Project key.
  - name: project_name
    expr: stg_jira__search_projects.name
    semantic_role: categorical
    description: Project name.
  - name: project_type_key
    expr: stg_jira__search_projects.project_type_key
    semantic_role: categorical
    description: Jira project type.
  - name: project_category
    expr: stg_jira__search_projects.project_category
    semantic_role: categorical
    description: Project category.
  - name: lead
    expr: stg_jira__search_projects.lead
    semantic_role: categorical
    description: Username of the project lead.
  - name: archived
    expr: stg_jira__search_projects.archived
    semantic_role: categorical
    description: Whether the project is archived.
  - name: simplified
    expr: stg_jira__search_projects.simplified
    semantic_role: categorical
    description: Whether the project uses the simplified Jira workflow model.
  - name: board_count
    expr: COALESCE(stg_jira__boards.board_count, 0)
    semantic_role: measure
    description: Number of Jira boards linked to the project.
  - name: scrum_board_count
    expr: COALESCE(stg_jira__boards.scrum_board_count, 0)
    semantic_role: measure
    description: Number of scrum boards linked to the project.
  - name: kanban_board_count
    expr: COALESCE(stg_jira__boards.kanban_board_count, 0)
    semantic_role: measure
    description: Number of kanban boards linked to the project.
  - name: issue_count
    expr: COALESCE(stg_jira__search_issues.issue_count, 0)
    semantic_role: measure
    description: Number of issues in the project.
  - name: done_issue_count
    expr: COALESCE(stg_jira__search_issues.done_issue_count, 0)
    semantic_role: measure
    description: Number of issues in a done status category.
  - name: total_time_spent_seconds
    expr: COALESCE(stg_jira__search_issues.total_time_spent_seconds, 0)
    semantic_role: measure
    description: Time spent across issues in the project, in seconds.
  - name: total_remaining_estimate_seconds
    expr: COALESCE(stg_jira__search_issues.total_remaining_estimate_seconds, 0)
    semantic_role: measure
    description: Remaining estimate across project issues, in seconds.
tags:
  - jira
  - projects
  - engineering
trust_tier: gold
materialization:
  type: table

### jira\_\_sprints

spec_version: '0.2'
name: jira__sprints
type: model
description: Jira sprints enriched with their board and project context.
grain: sprint_id
source:
  ref: stg_jira__sprints
joins:
  - ref: stg_jira__boards
    type: left
    on: stg_jira__sprints.board_id = stg_jira__boards.board_id
  - ref: stg_jira__search_projects
    type: left
    on: stg_jira__boards.location_project_key = stg_jira__search_projects.key
columns:
  - name: sprint_id
    expr: stg_jira__sprints.sprint_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Jira sprint identifier.
  - name: sprint_name
    expr: stg_jira__sprints.name
    semantic_role: categorical
    description: Sprint name.
  - name: sprint_state
    expr: stg_jira__sprints.state
    semantic_role: categorical
    description: Sprint state such as active, closed, or future.
  - name: board_id
    expr: stg_jira__sprints.board_id
    semantic_role: entity_id
    references: stg_jira__boards.board_id
    description: Board that owns the sprint.
  - name: board_name
    expr: stg_jira__boards.name
    semantic_role: categorical
    description: Name of the owning board.
  - name: board_type
    expr: stg_jira__boards.type
    semantic_role: categorical
    description: Type of the owning board.
  - name: project_id
    expr: stg_jira__search_projects.search_project_id
    semantic_role: entity_id
    references: stg_jira__search_projects.search_project_id
    description: Project linked to the sprint through the board.
  - name: project_key
    expr: stg_jira__boards.location_project_key
    semantic_role: categorical
    description: Project key linked to the sprint through the board.
  - name: project_name
    expr: COALESCE(stg_jira__search_projects.name, stg_jira__boards.location_project_name)
    semantic_role: categorical
    description: Project name linked to the sprint through the board.
  - name: goal
    expr: stg_jira__sprints.goal
    semantic_role: categorical
    description: Sprint goal text.
  - name: start_date
    expr: stg_jira__sprints.start_date
    semantic_role: event_timestamp
    description: Timestamp when the sprint starts.
  - name: end_date
    expr: stg_jira__sprints.end_date
    semantic_role: event_timestamp
    description: Timestamp when the sprint is scheduled to end.
  - name: complete_date
    expr: stg_jira__sprints.complete_date
    semantic_role: event_timestamp
    description: Timestamp when the sprint completed.
tags:
  - jira
  - sprints
  - engineering
trust_tier: gold
materialization:
  type: table

### jira\_\_worklogs

spec_version: '0.2'
name: jira__worklogs
type: model
description: Jira worklogs enriched with their related issue and project context.
grain: worklog_id
source:
  ref: stg_jira__worklogs
joins:
  - ref: stg_jira__search_issues
    type: left
    on: stg_jira__worklogs.issue_id = stg_jira__search_issues.search_issue_id
columns:
  - name: worklog_id
    expr: stg_jira__worklogs.worklog_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Jira worklog identifier.
  - name: issue_id
    expr: stg_jira__worklogs.issue_id
    semantic_role: entity_id
    references: stg_jira__search_issues.search_issue_id
    description: Jira issue linked to the worklog.
  - name: issue_key
    expr: stg_jira__search_issues.key
    semantic_role: categorical
    description: Human-readable issue key.
  - name: issue_summary
    expr: stg_jira__search_issues.summary
    semantic_role: categorical
    description: Summary of the related issue.
  - name: project_id
    expr: stg_jira__search_issues.project_id
    semantic_role: entity_id
    description: Project that owns the issue tied to the worklog.
  - name: project_key
    expr: stg_jira__search_issues.project_key
    semantic_role: categorical
    description: Project key associated with the worklog.
  - name: project_name
    expr: stg_jira__search_issues.project_name
    semantic_role: categorical
    description: Project name associated with the worklog.
  - name: author_account_id
    expr: stg_jira__worklogs.author_account_id
    semantic_role: entity_id
    description: Account ID of the worklog author.
  - name: author_display_name
    expr: stg_jira__worklogs.author_display_name
    semantic_role: categorical
    description: Display name of the worklog author.
  - name: time_spent_text
    expr: stg_jira__worklogs.time_spent
    semantic_role: categorical
    description: Human-readable time-spent string.
  - name: time_spent_seconds
    expr: stg_jira__worklogs.time_spent_seconds
    semantic_role: measure
    description: Time logged in seconds.
  - name: started_at
    expr: stg_jira__worklogs.started
    semantic_role: event_timestamp
    description: Timestamp when the work started.
  - name: created_at
    expr: stg_jira__worklogs.created_at
    semantic_role: event_timestamp
    description: Timestamp when the worklog was created.
  - name: updated_at
    expr: stg_jira__worklogs.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the worklog was last updated.
tags:
  - jira
  - worklogs
  - engineering
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: jira_issue_count
description: Number of Jira issues.
model: jira__issues
expression: COUNT({jira__issues}.issue_id)
synonyms: [issues, ticket count, issue volume]
tags: [jira, engineering, planning]
spec_version: '0.2'
type: metric
name: jira_resolved_issue_count
description: Number of Jira issues with a resolution date.
model: jira__issues
expression: SUM(CASE WHEN {jira__issues}.resolution_date IS NOT NULL THEN 1 ELSE 0 END)
synonyms: [resolved issues, completed issues, issues resolved]
tags: [jira, engineering, delivery]
spec_version: '0.2'
type: metric
name: jira_total_time_spent_seconds
description: Total time logged on Jira issues, in seconds.
model: jira__issues
expression: SUM({jira__issues}.time_spent_seconds)
synonyms: [time spent, logged time, worklog seconds]
tags: [jira, engineering, delivery]

## Relationships

spec_version: '0.2'
type: relationship
name: jira_issues_to_projects
description: Each Jira issue belongs to one project.
left_model: jira__issues
right_model: jira__projects
join_columns:
  - left: project_id
    right: project_id
join_type: left
relationship_type: many_to_one
tags: [jira, issues, projects]
spec_version: '0.2'
type: relationship
name: jira_worklogs_to_issues
description: Each Jira worklog belongs to one issue.
left_model: jira__worklogs
right_model: jira__issues
join_columns:
  - left: issue_id
    right: issue_id
join_type: left
relationship_type: many_to_one
tags: [jira, worklogs, issues]
