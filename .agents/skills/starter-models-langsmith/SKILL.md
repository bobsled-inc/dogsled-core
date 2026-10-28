---
name: starter-models-langsmith
description: Curated starter analytics models, metrics, and relationships for LangSmith observability and evaluation. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - langsmith starter models
  - prebuilt langsmith models
  - curated langsmith analytics models
  - standard langsmith data models
  - build langsmith marts
  - LangSmith analytics shape
  - models for langsmith
  - langsmith traces model
  - langsmith evaluation models
---

# Starter data models — LangSmith

Observability and evaluation models for LangSmith projects, runs, traces,
datasets, and examples.

These are the **gold marts** for LangSmith — the canonical analytics
tables an analyst would build on top of the loaded LangSmith extract.
Each mart references a silver staging model named
`stg_langsmith__<resource>` through `source.ref`; you author those
staging models (and their bronze sources) from the user's loaded raw
tables using the recipe in the **`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. LangSmith runs depend on
sessions/projects through `session_id`; include the parent `sessions`
resource whenever extracting runs so downstream trace and session rollups
have context. The `starter-data-models` overview has the full build flow,
naming conventions, and the bronze/silver recipe — read it first.

## Marts

### langsmith\_\_datasets

{{include: packages/models/marts/langsmith/langsmith__datasets.yml}}

### langsmith\_\_examples

{{include: packages/models/marts/langsmith/langsmith__examples.yml}}

### langsmith\_\_runs

{{include: packages/models/marts/langsmith/langsmith__runs.yml}}

### langsmith\_\_session_run_summary

{{include: packages/models/marts/langsmith/langsmith__session_run_summary.yml}}

### langsmith\_\_sessions

{{include: packages/models/marts/langsmith/langsmith__sessions.yml}}

### langsmith\_\_trace_summary

{{include: packages/models/marts/langsmith/langsmith__trace_summary.yml}}

## Metrics

{{include: packages/models/marts/langsmith/metrics/langsmith_run_count.yml}}
{{include: packages/models/marts/langsmith/metrics/langsmith_error_run_count.yml}}
{{include: packages/models/marts/langsmith/metrics/langsmith_trace_token_count.yml}}

## Relationships

{{include: packages/models/marts/langsmith/relationships/langsmith_runs_to_sessions.yml}}
{{include: packages/models/marts/langsmith/relationships/langsmith_examples_to_datasets.yml}}
