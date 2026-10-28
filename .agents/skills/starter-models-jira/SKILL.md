---
name: starter-models-jira
description: Curated starter analytics models, metrics, and relationships for Jira engineering delivery. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - jira starter models
  - prebuilt jira models
  - curated jira analytics models
  - standard jira data models
  - build jira marts
  - Jira analytics shape
  - models for jira
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

{{include: packages/models/marts/jira/jira__boards.yml}}

### jira\_\_issue_status_summary

{{include: packages/models/marts/jira/jira__issue_status_summary.yml}}

### jira\_\_issues

{{include: packages/models/marts/jira/jira__issues.yml}}

### jira\_\_projects

{{include: packages/models/marts/jira/jira__projects.yml}}

### jira\_\_sprints

{{include: packages/models/marts/jira/jira__sprints.yml}}

### jira\_\_worklogs

{{include: packages/models/marts/jira/jira__worklogs.yml}}

## Metrics

{{include: packages/models/marts/jira/metrics/jira_issue_count.yml}}
{{include: packages/models/marts/jira/metrics/jira_resolved_issue_count.yml}}
{{include: packages/models/marts/jira/metrics/jira_total_time_spent_seconds.yml}}

## Relationships

{{include: packages/models/marts/jira/relationships/jira_issues_to_projects.yml}}
{{include: packages/models/marts/jira/relationships/jira_worklogs_to_issues.yml}}
