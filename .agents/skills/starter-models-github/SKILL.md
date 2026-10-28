---
name: starter-models-github
description: Curated starter analytics models, metrics, and relationships for GitHub. Engineering system semantics for GitHub repositories, pull requests, deployments, and workflow health. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - github starter models
  - prebuilt github models
  - curated github analytics models
  - standard github data models
  - build github marts
  - GitHub analytics shape
  - models for github
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

{{include: packages/models/marts/github/github__commits.yml}}

### github\_\_deployments

{{include: packages/models/marts/github/github__deployments.yml}}

### github\_\_issues

{{include: packages/models/marts/github/github__issues.yml}}

### github\_\_pull_request_activity

{{include: packages/models/marts/github/github__pull_request_activity.yml}}

### github\_\_pull_requests

{{include: packages/models/marts/github/github__pull_requests.yml}}

### github\_\_repo_visibility_summary

{{include: packages/models/marts/github/github__repo_visibility_summary.yml}}

### github\_\_repos

{{include: packages/models/marts/github/github__repos.yml}}

### github\_\_workflow_health

{{include: packages/models/marts/github/github__workflow_health.yml}}

### github\_\_workflow_runs

{{include: packages/models/marts/github/github__workflow_runs.yml}}

## Metrics

{{include: packages/models/marts/github/metrics/github_pull_request_count.yml}}

{{include: packages/models/marts/github/metrics/github_merged_pull_request_count.yml}}

{{include: packages/models/marts/github/metrics/github_successful_workflow_run_count.yml}}

## Relationships

{{include: packages/models/marts/github/relationships/github_deployments_to_commits.yml}}

{{include: packages/models/marts/github/relationships/github_workflow_runs_to_health.yml}}
