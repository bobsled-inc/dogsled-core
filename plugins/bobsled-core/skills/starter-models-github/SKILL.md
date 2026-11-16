---
name: starter-models-github
description: Curated starter analytics models, metrics, and relationships for
  GitHub. Engineering system semantics for GitHub repositories, pull requests,
  deployments, and workflow health. Pairs with the starter-data-models overview;
  adapt the bundle to the user's actually-loaded tables.
---

# Starter data models — GitHub

Engineering system models for GitHub repositories, pull requests, and workflow health.

This bundle contains the **gold marts, metrics, and relationships** for
GitHub—the canonical analytics layer an analyst would build on top of the loaded GitHub extract. Each
mart references a silver staging model named `stg_github__<resource>`
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

### github\_\_commits

spec_version: '0.2'
name: github__commits
type: model
description: Commit-level detail for code churn and contributor analysis.
grain: sha
source:
  ref: stg_github__commits
columns:
  - name: sha
    expr: stg_github__commits.sha
    primary_key: true
    semantic_role: entity_id
    description: Full 40-character SHA identifying the commit.
  - name: message
    expr: stg_github__commits.message
    semantic_role: categorical
    description: Full commit message.
  - name: author_name
    expr: stg_github__commits.author_name
    semantic_role: categorical
    tags:
      - pii
    description: Git author display name.
  - name: author_email
    expr: stg_github__commits.author_email
    semantic_role: categorical
    tags:
      - pii
    description: Git author email address.
  - name: author_date
    expr: stg_github__commits.author_date
    semantic_role: event_timestamp
    description: Timestamp when the commit was originally authored.
  - name: author_login
    expr: stg_github__commits.author_login
    semantic_role: categorical
    description: GitHub username of the commit author.
  - name: committer_name
    expr: stg_github__commits.committer_name
    semantic_role: categorical
    description: Git committer display name.
  - name: committer_date
    expr: stg_github__commits.committer_date
    semantic_role: event_timestamp
    description: Timestamp when the commit was applied.
  - name: verified
    expr: stg_github__commits.verified
    semantic_role: categorical
    description: Whether the commit signature has been verified.
  - name: parent_count
    expr: stg_github__commits.parent_count
    semantic_role: measure
    description: Number of parent commits (2+ indicates a merge).
  - name: comment_count
    expr: stg_github__commits.comment_count
    semantic_role: measure
    description: Number of comments on this commit.
tags:
  - github
  - commits
trust_tier: gold
materialization:
  type: table

### github\_\_deployments

spec_version: '0.2'
name: github__deployments
type: model
description: Deployment records across environments with creator and production flag.
grain: deployment_id
source:
  ref: stg_github__deployments
columns:
  - name: deployment_id
    expr: stg_github__deployments.deployment_id
    primary_key: true
    semantic_role: entity_id
    description: Unique GitHub deployment identifier.
  - name: sha
    expr: stg_github__deployments.sha
    semantic_role: categorical
    description: Full SHA of the commit being deployed.
  - name: ref
    expr: stg_github__deployments.ref
    semantic_role: categorical
    description: Git ref that was deployed (branch, tag, or SHA).
  - name: environment
    expr: stg_github__deployments.environment
    semantic_role: categorical
    description: Target deployment environment (production, staging, preview, etc.).
  - name: production_environment
    expr: stg_github__deployments.production_environment
    semantic_role: categorical
    description: Whether this targets a production environment.
  - name: task
    expr: stg_github__deployments.task
    semantic_role: categorical
    description: Deployment task type (deploy, rollback, etc.).
  - name: creator_login
    expr: stg_github__deployments.creator_login
    semantic_role: categorical
    description: GitHub username of the deployment creator.
  - name: creator_type
    expr: stg_github__deployments.creator_type
    semantic_role: categorical
    description: Creator type (User or Bot).
  - name: created_at
    expr: stg_github__deployments.created_at
    semantic_role: event_timestamp
    description: Timestamp when the deployment was created.
  - name: updated_at
    expr: stg_github__deployments.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the deployment was last updated.
tags:
  - github
  - deployments
trust_tier: gold
materialization:
  type: table

### github\_\_issues

spec_version: '0.2'
name: github__issues
type: model
description: Repository issues with state, labels, milestone, and engagement metadata.
grain: issue_id
source:
  ref: stg_github__issues
columns:
  - name: issue_id
    expr: stg_github__issues.issue_id
    primary_key: true
    semantic_role: entity_id
    description: Unique GitHub issue identifier.
  - name: number
    expr: stg_github__issues.number
    semantic_role: categorical
    description: Repository-scoped issue number.
  - name: title
    expr: stg_github__issues.title
    semantic_role: categorical
    description: Issue title.
  - name: state
    expr: stg_github__issues.state
    semantic_role: categorical
    description: Issue state (open or closed).
  - name: state_reason
    expr: stg_github__issues.state_reason
    semantic_role: categorical
    description: Reason for closure (completed, not_planned, or null).
  - name: user_login
    expr: stg_github__issues.user_login
    semantic_role: categorical
    description: GitHub username of the issue author.
  - name: assignee_login
    expr: stg_github__issues.assignee_login
    semantic_role: categorical
    description: GitHub username of the primary assignee.
  - name: assignees_count
    expr: stg_github__issues.assignees_count
    semantic_role: measure
    description: Number of users assigned to this issue.
  - name: labels
    expr: stg_github__issues.labels
    semantic_role: categorical
    description: Label names applied to the issue.
  - name: milestone_title
    expr: stg_github__issues.milestone_title
    semantic_role: categorical
    description: Associated milestone title.
  - name: comments
    expr: stg_github__issues.comments
    semantic_role: measure
    description: Number of comments on the issue.
  - name: reactions_total
    expr: stg_github__issues.reactions_total
    semantic_role: measure
    description: Total emoji reactions on the issue.
  - name: author_association
    expr: stg_github__issues.author_association
    semantic_role: categorical
    description: Author relationship to the repository.
  - name: created_at
    expr: stg_github__issues.created_at
    semantic_role: event_timestamp
    description: Timestamp when the issue was created.
  - name: closed_at
    expr: stg_github__issues.closed_at
    semantic_role: event_timestamp
    description: Timestamp when the issue was closed.
  - name: updated_at
    expr: stg_github__issues.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the issue was last updated.
tags:
  - github
  - issues
trust_tier: gold
materialization:
  type: table

### github\_\_pull_request_activity

spec_version: '0.2'
name: github__pull_request_activity
type: model
description: Pull request activity summarized by state and draft status.
grain:
  - state
  - draft
  - merged
source:
  ref: stg_github__pull_requests
columns:
  - name: state
    expr: stg_github__pull_requests.state
    semantic_role: categorical
    description: Open or closed state.
  - name: draft
    expr: stg_github__pull_requests.draft
    semantic_role: categorical
    description: Draft status of the pull request.
  - name: merged
    expr: stg_github__pull_requests.merged
    semantic_role: categorical
    description: Whether pull requests in the bucket are merged.
  - name: pull_request_count
    expr: COUNT(*)
    semantic_role: measure
    description: Count of pull requests in the bucket.
  - name: total_changed_files
    expr: SUM(COALESCE(stg_github__pull_requests.changed_files, 0))
    semantic_role: measure
    description: Total changed files across pull requests in the bucket.
group_by:
  - state
  - draft
  - merged
tags:
  - github
  - pull-requests
  - summary
trust_tier: gold
materialization:
  type: table

### github\_\_pull_requests

spec_version: '0.2'
name: github__pull_requests
type: model
description: Detailed pull request records with review and merge metadata.
grain: pull_request_id
source:
  ref: stg_github__pull_requests
columns:
  - name: pull_request_id
    expr: stg_github__pull_requests.pull_request_id
    primary_key: true
    semantic_role: entity_id
    description: Unique GitHub pull request identifier.
  - name: number
    expr: stg_github__pull_requests.number
    semantic_role: categorical
    description: Repository-scoped pull request number.
  - name: title
    expr: stg_github__pull_requests.title
    semantic_role: categorical
    description: Pull request title.
  - name: state
    expr: stg_github__pull_requests.state
    semantic_role: categorical
    description: Open or closed state of the pull request.
  - name: draft
    expr: stg_github__pull_requests.draft
    semantic_role: categorical
    description: Whether the pull request is still a draft.
  - name: merged
    expr: stg_github__pull_requests.merged
    semantic_role: categorical
    description: Whether the pull request has been merged.
  - name: user_login
    expr: stg_github__pull_requests.user_login
    semantic_role: categorical
    description: GitHub login of the pull request author.
  - name: comments
    expr: stg_github__pull_requests.comments
    semantic_role: measure
    description: Count of general comments on the pull request.
  - name: review_comments
    expr: stg_github__pull_requests.review_comments
    semantic_role: measure
    description: Count of inline review comments.
  - name: commits
    expr: stg_github__pull_requests.commits
    semantic_role: measure
    description: Number of commits in the pull request.
  - name: additions
    expr: stg_github__pull_requests.additions
    semantic_role: measure
    description: Lines added by the pull request.
  - name: deletions
    expr: stg_github__pull_requests.deletions
    semantic_role: measure
    description: Lines deleted by the pull request.
  - name: created_at
    expr: stg_github__pull_requests.created_at
    semantic_role: event_timestamp
    description: Timestamp when the pull request was opened.
  - name: merged_at
    expr: stg_github__pull_requests.merged_at
    semantic_role: event_timestamp
    description: Timestamp when the pull request was merged.
tags:
  - github
  - pull-requests
trust_tier: gold
materialization:
  type: table

### github\_\_repo_visibility_summary

spec_version: '0.2'
name: github__repo_visibility_summary
type: model
description: Repository counts and engagement metrics grouped by visibility and language.
grain:
  - visibility
  - language
source:
  ref: stg_github__repos
columns:
  - name: visibility
    expr: stg_github__repos.visibility
    semantic_role: categorical
    description: Visibility bucket for the repository group.
  - name: language
    expr: stg_github__repos.language
    semantic_role: categorical
    description: Primary language bucket for the repository group.
  - name: repo_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of repositories in the visibility and language bucket.
  - name: total_stars
    expr: SUM(stg_github__repos.stargazers_count)
    semantic_role: measure
    description: Total stars across repositories in the bucket.
  - name: total_forks
    expr: SUM(stg_github__repos.forks_count)
    semantic_role: measure
    description: Total forks across repositories in the bucket.
  - name: total_open_issues
    expr: SUM(stg_github__repos.open_issues_count)
    semantic_role: measure
    description: Total open issues and pull requests across the bucket.
group_by:
  - visibility
  - language
tags:
  - github
  - repos
  - summary
trust_tier: gold
materialization:
  type: table

### github\_\_repos

spec_version: '0.2'
name: github__repos
type: model
description: Repository detail for GitHub repositories with visibility and activity metadata.
grain: repo_id
source:
  ref: stg_github__repos
columns:
  - name: repo_id
    expr: stg_github__repos.repo_id
    primary_key: true
    semantic_role: entity_id
    description: Unique GitHub repository identifier.
  - name: repo_name
    expr: stg_github__repos.name
    semantic_role: categorical
    description: Short repository name.
  - name: repo_full_name
    expr: stg_github__repos.full_name
    semantic_role: categorical
    description: Fully qualified repository name.
  - name: owner_login
    expr: stg_github__repos.owner_login
    semantic_role: categorical
    description: Owner login for the repository.
  - name: language
    expr: stg_github__repos.language
    semantic_role: categorical
    description: Primary language detected by GitHub.
  - name: visibility
    expr: stg_github__repos.visibility
    semantic_role: categorical
    description: Repository visibility setting.
  - name: stargazers_count
    expr: stg_github__repos.stargazers_count
    semantic_role: measure
    description: Number of stars on the repository.
  - name: forks_count
    expr: stg_github__repos.forks_count
    semantic_role: measure
    description: Number of forks created from the repository.
  - name: open_issues_count
    expr: stg_github__repos.open_issues_count
    semantic_role: measure
    description: Open issues and pull requests tracked by GitHub.
  - name: pushed_at
    expr: stg_github__repos.pushed_at
    semantic_role: event_timestamp
    description: Timestamp of the latest push.
tags:
  - github
  - repos
trust_tier: gold
materialization:
  type: table

### github\_\_workflow_health

spec_version: '0.2'
name: github__workflow_health
type: model
description: Workflow-level execution health summary built from recent workflow runs.
grain: workflow_id
source:
  ref: stg_github__workflows
joins:
  - ref: stg_github__workflow_runs
    type: left
    on: stg_github__workflows.workflow_id = stg_github__workflow_runs.workflow_id
    pre_aggregate:
      group_by:
        - workflow_id
      columns:
        - name: total_runs
          expr: COUNT(*)
        - name: successful_runs
          expr: SUM(CASE WHEN conclusion = 'success' THEN 1 ELSE 0 END)
        - name: failed_runs
          expr: SUM(CASE WHEN conclusion = 'failure' THEN 1 ELSE 0 END)
        - name: latest_run_at
          expr: MAX(created_at)
columns:
  - name: workflow_id
    expr: stg_github__workflows.workflow_id
    primary_key: true
    semantic_role: entity_id
    description: Unique workflow identifier.
  - name: name
    expr: stg_github__workflows.name
    semantic_role: categorical
    description: Workflow name.
  - name: state
    expr: stg_github__workflows.state
    semantic_role: categorical
    description: Current workflow enabled or disabled state.
  - name: total_runs
    expr: COALESCE(stg_github__workflow_runs.total_runs, 0)
    semantic_role: measure
    description: Total workflow runs observed.
  - name: successful_runs
    expr: COALESCE(stg_github__workflow_runs.successful_runs, 0)
    semantic_role: measure
    description: Successful workflow runs observed.
  - name: failed_runs
    expr: COALESCE(stg_github__workflow_runs.failed_runs, 0)
    semantic_role: measure
    description: Failed workflow runs observed.
  - name: latest_run_at
    expr: stg_github__workflow_runs.latest_run_at
    semantic_role: event_timestamp
    description: Timestamp of the latest observed workflow run. NULL when no runs exist.
tags:
  - github
  - workflows
  - summary
trust_tier: gold
materialization:
  type: table

### github\_\_workflow_runs

spec_version: '0.2'
name: github__workflow_runs
type: model
description: Workflow run detail joined to workflow metadata.
grain: workflow_run_id
source:
  ref: stg_github__workflow_runs
joins:
  - ref: stg_github__workflows
    type: left
    on: stg_github__workflow_runs.workflow_id = stg_github__workflows.workflow_id
columns:
  - name: workflow_run_id
    expr: stg_github__workflow_runs.workflow_run_id
    primary_key: true
    semantic_role: entity_id
    description: Unique GitHub workflow run identifier.
  - name: workflow_id
    expr: stg_github__workflow_runs.workflow_id
    semantic_role: entity_id
    references: stg_github__workflows.workflow_id
    description: Workflow definition associated with the run.
  - name: workflow_name
    expr: stg_github__workflows.name
    semantic_role: categorical
    description: Name of the workflow definition.
  - name: status
    expr: stg_github__workflow_runs.status
    semantic_role: categorical
    description: Execution status of the workflow run.
  - name: conclusion
    expr: stg_github__workflow_runs.conclusion
    semantic_role: categorical
    description: Final conclusion of the run when completed.
  - name: event
    expr: stg_github__workflow_runs.event
    semantic_role: categorical
    description: GitHub event that triggered the run.
  - name: head_branch
    expr: stg_github__workflow_runs.head_branch
    semantic_role: categorical
    description: Branch name on which the run executed.
  - name: actor_login
    expr: stg_github__workflow_runs.actor_login
    semantic_role: categorical
    description: Login of the actor who triggered the run.
  - name: created_at
    expr: stg_github__workflow_runs.created_at
    semantic_role: event_timestamp
    description: Timestamp when the workflow run was queued.
  - name: run_started_at
    expr: stg_github__workflow_runs.run_started_at
    semantic_role: event_timestamp
    description: Timestamp when the workflow run started execution.
tags:
  - github
  - workflows
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: github_pull_request_count
description: Number of GitHub pull requests.
model: github__pull_requests
expression: COUNT({github__pull_requests}.pull_request_id)
synonyms:
  - pull requests
  - PR count
  - number of pull requests
tags:
  - github
  - engineering
  - delivery

spec_version: '0.2'
type: metric
name: github_merged_pull_request_count
description: Number of GitHub pull requests marked as merged.
model: github__pull_requests
expression: SUM(CASE WHEN {github__pull_requests}.merged THEN 1 ELSE 0 END)
synonyms:
  - merged pull requests
  - merged PRs
  - PRs merged
tags:
  - github
  - engineering
  - delivery

spec_version: '0.2'
type: metric
name: github_successful_workflow_run_count
description: Number of GitHub workflow runs that completed successfully.
model: github__workflow_runs
expression: SUM(CASE WHEN {github__workflow_runs}.conclusion = 'success' THEN 1 ELSE 0 END)
synonyms:
  - successful workflow runs
  - passing workflow runs
  - successful CI runs
tags:
  - github
  - engineering
  - ci

## Relationships

spec_version: '0.2'
type: relationship
name: github_deployments_to_commits
description: Each GitHub deployment references the commit that it deploys.
left_model: github__deployments
right_model: github__commits
join_columns:
  - left: sha
    right: sha
join_type: left
relationship_type: many_to_one
tags:
  - github
  - engineering
  - deployments

spec_version: '0.2'
type: relationship
name: github_workflow_runs_to_health
description: Each GitHub workflow run contributes to one workflow health summary.
left_model: github__workflow_runs
right_model: github__workflow_health
join_columns:
  - left: workflow_id
    right: workflow_id
join_type: left
relationship_type: many_to_one
tags:
  - github
  - engineering
  - ci
