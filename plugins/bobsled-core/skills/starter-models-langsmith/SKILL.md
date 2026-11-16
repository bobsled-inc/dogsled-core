---
name: starter-models-langsmith
description: Curated starter analytics models, metrics, and relationships for
  LangSmith observability and evaluation. Pairs with the starter-data-models
  overview; adapt the bundle to the user's actually-loaded tables.
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

spec_version: '0.2'
name: langsmith__datasets
type: model
description: Dataset catalog for LangSmith examples and evaluation runs.
grain: dataset_id
source:
  ref: stg_langsmith__datasets
columns:
  - name: dataset_id
    expr: stg_langsmith__datasets.dataset_id
    primary_key: true
    semantic_role: entity_id
    description: Unique LangSmith dataset identifier.
  - name: dataset_name
    expr: stg_langsmith__datasets.name
    semantic_role: name
    description: Dataset display name.
  - name: description
    expr: stg_langsmith__datasets.description
    semantic_role: categorical
    description: Human-readable dataset description.
  - name: data_type
    expr: stg_langsmith__datasets.data_type
    semantic_role: categorical
    description: LangSmith dataset data type, such as kv, llm, or chat.
  - name: tenant_id
    expr: stg_langsmith__datasets.tenant_id
    semantic_role: entity_id
    description: LangSmith tenant that owns the dataset.
  - name: example_count
    expr: stg_langsmith__datasets.example_count
    semantic_role: measure
    description: Number of examples in the dataset.
  - name: session_count
    expr: stg_langsmith__datasets.session_count
    semantic_role: measure
    description: Number of sessions or experiments linked to the dataset.
  - name: created_at
    expr: stg_langsmith__datasets.created_at
    semantic_role: event_timestamp
    description: Timestamp when the dataset was created.
  - name: modified_at
    expr: stg_langsmith__datasets.modified_at
    semantic_role: event_timestamp
    description: Timestamp when the dataset was last modified.
  - name: last_session_start_time
    expr: stg_langsmith__datasets.last_session_start_time
    semantic_role: event_timestamp
    description: Most recent linked session start time, when present.
  - name: externally_managed
    expr: stg_langsmith__datasets.externally_managed
    semantic_role: categorical
    description: Whether the dataset is managed by an external process.
  - name: baseline_experiment_id
    expr: stg_langsmith__datasets.baseline_experiment_id
    semantic_role: entity_id
    description: Baseline experiment or session identifier linked to the dataset.
  - name: metadata
    expr: stg_langsmith__datasets.metadata
    semantic_role: categorical
    description: Dataset metadata payload.
tags:
  - langsmith
  - datasets
  - evaluation
trust_tier: gold
materialization:
  type: table

### langsmith\_\_examples

spec_version: '0.2'
name: langsmith__examples
type: model
description: Dataset examples enriched with dataset context.
grain: example_id
source:
  ref: stg_langsmith__examples
joins:
  - ref: stg_langsmith__datasets
    type: left
    on: stg_langsmith__examples.dataset_id = stg_langsmith__datasets.dataset_id
columns:
  - name: example_id
    expr: stg_langsmith__examples.example_id
    primary_key: true
    semantic_role: entity_id
    description: Unique LangSmith example identifier.
  - name: dataset_id
    expr: stg_langsmith__examples.dataset_id
    semantic_role: entity_id
    references: stg_langsmith__datasets.dataset_id
    description: Dataset that owns the example.
  - name: dataset_name
    expr: stg_langsmith__datasets.name
    semantic_role: name
    description: Dataset display name.
  - name: example_name
    expr: stg_langsmith__examples.name
    semantic_role: name
    description: Example display name.
  - name: source_run_id
    expr: stg_langsmith__examples.source_run_id
    semantic_role: entity_id
    description: Run used to create the example, when present.
  - name: inputs
    expr: stg_langsmith__examples.inputs
    semantic_role: categorical
    description: Input payload for the example.
  - name: outputs
    expr: stg_langsmith__examples.outputs
    semantic_role: categorical
    description: Reference output payload for the example.
  - name: metadata
    expr: stg_langsmith__examples.metadata
    semantic_role: categorical
    description: Example metadata payload.
  - name: attachment_urls
    expr: stg_langsmith__examples.attachment_urls
    semantic_role: categorical
    description: Attachment URLs associated with the example.
  - name: created_at
    expr: stg_langsmith__examples.created_at
    semantic_role: event_timestamp
    description: Timestamp when the example was created.
  - name: modified_at
    expr: stg_langsmith__examples.modified_at
    semantic_role: event_timestamp
    description: Timestamp when the example was last modified.
tags:
  - langsmith
  - examples
  - evaluation
trust_tier: gold
materialization:
  type: table

### langsmith\_\_runs

spec_version: '0.2'
name: langsmith__runs
type: model
description: LangSmith run detail enriched with session, dataset, and example context.
grain: run_id
source:
  ref: stg_langsmith__runs
joins:
  - ref: stg_langsmith__sessions
    type: left
    on: stg_langsmith__runs.session_id = stg_langsmith__sessions.session_id
  - ref: stg_langsmith__datasets
    type: left
    on: stg_langsmith__runs.reference_dataset_id = stg_langsmith__datasets.dataset_id
  - ref: stg_langsmith__examples
    type: left
    on: stg_langsmith__runs.reference_example_id = stg_langsmith__examples.example_id
columns:
  - name: run_id
    expr: stg_langsmith__runs.run_id
    primary_key: true
    semantic_role: entity_id
    description: Unique LangSmith run identifier.
  - name: trace_id
    expr: stg_langsmith__runs.trace_id
    semantic_role: entity_id
    description: Identifier shared by all runs in the same trace.
  - name: session_id
    expr: stg_langsmith__runs.session_id
    semantic_role: entity_id
    references: stg_langsmith__sessions.session_id
    description: Session or project that owns the run.
  - name: session_name
    expr: stg_langsmith__sessions.name
    semantic_role: name
    description: Session or project display name.
  - name: run_name
    expr: stg_langsmith__runs.name
    semantic_role: name
    description: Run display name.
  - name: run_type
    expr: stg_langsmith__runs.run_type
    semantic_role: categorical
    description: LangSmith run type, such as chain, llm, tool, retriever, or embedding.
  - name: status
    expr: stg_langsmith__runs.status
    semantic_role: categorical
    description: Run execution status.
  - name: parent_run_id
    expr: stg_langsmith__runs.parent_run_id
    semantic_role: entity_id
    description: Direct parent run identifier for nested traces.
  - name: thread_id
    expr: stg_langsmith__runs.thread_id
    semantic_role: entity_id
    description: Thread identifier associated with the run.
  - name: reference_dataset_id
    expr: stg_langsmith__runs.reference_dataset_id
    semantic_role: entity_id
    references: stg_langsmith__datasets.dataset_id
    description: Reference dataset linked to the run.
  - name: reference_dataset_name
    expr: stg_langsmith__datasets.name
    semantic_role: name
    description: Reference dataset display name.
  - name: reference_example_id
    expr: stg_langsmith__runs.reference_example_id
    semantic_role: entity_id
    references: stg_langsmith__examples.example_id
    description: Reference example linked to the run.
  - name: reference_example_name
    expr: stg_langsmith__examples.name
    semantic_role: name
    description: Reference example display name.
  - name: start_time
    expr: stg_langsmith__runs.start_time
    semantic_role: event_timestamp
    description: Timestamp when the run started.
  - name: end_time
    expr: stg_langsmith__runs.end_time
    semantic_role: event_timestamp
    description: Timestamp when the run ended.
  - name: total_tokens
    expr: stg_langsmith__runs.total_tokens
    semantic_role: measure
    description: Total tokens attributed to the run.
  - name: prompt_tokens
    expr: stg_langsmith__runs.prompt_tokens
    semantic_role: measure
    description: Prompt tokens attributed to the run.
  - name: completion_tokens
    expr: stg_langsmith__runs.completion_tokens
    semantic_role: measure
    description: Completion tokens attributed to the run.
  - name: total_cost
    expr: stg_langsmith__runs.total_cost
    semantic_role: measure
    tags:
      - financial
    description: Total cost attributed to the run.
  - name: prompt_cost
    expr: stg_langsmith__runs.prompt_cost
    semantic_role: measure
    tags:
      - financial
    description: Prompt cost attributed to the run.
  - name: completion_cost
    expr: stg_langsmith__runs.completion_cost
    semantic_role: measure
    tags:
      - financial
    description: Completion cost attributed to the run.
  - name: error
    expr: stg_langsmith__runs.error
    semantic_role: categorical
    description: Error message captured for failed runs.
  - name: inputs
    expr: stg_langsmith__runs.inputs
    semantic_role: categorical
    description: Raw input payload captured for the run.
  - name: inputs_preview
    expr: stg_langsmith__runs.inputs_preview
    semantic_role: categorical
    description: Preview text for the run inputs.
  - name: input_message
    expr: stg_langsmith__runs.input_message
    semantic_role: categorical
    description: Last input message content when the run input has a messages array.
  - name: outputs
    expr: stg_langsmith__runs.outputs
    semantic_role: categorical
    description: Raw output payload captured for the run.
  - name: outputs_preview
    expr: stg_langsmith__runs.outputs_preview
    semantic_role: categorical
    description: Preview text for the run outputs.
  - name: output_message
    expr: stg_langsmith__runs.output_message
    semantic_role: categorical
    description: Assistant output content when the run output has a content field.
  - name: messages
    expr: stg_langsmith__runs.messages
    semantic_role: categorical
    description: Message payloads associated with the run.
  - name: extra
    expr: stg_langsmith__runs.extra
    semantic_role: categorical
    description: Additional run metadata.
  - name: tags
    expr: stg_langsmith__runs.tags
    semantic_role: categorical
    description: Tags attached to the run.
  - name: feedback_stats
    expr: stg_langsmith__runs.feedback_stats
    semantic_role: categorical
    description: Aggregated feedback statistics attached to the run.
  - name: app_path
    expr: stg_langsmith__runs.app_path
    semantic_role: url
    description: LangSmith application path for opening the run.
  - name: in_dataset
    expr: stg_langsmith__runs.in_dataset
    semantic_role: categorical
    description: Whether the run is included in a dataset.
  - name: trace_tier
    expr: stg_langsmith__runs.trace_tier
    semantic_role: categorical
    description: Trace retention or indexing tier for the run.
tags:
  - langsmith
  - runs
  - traces
trust_tier: gold
materialization:
  type: table

### langsmith\_\_session_run_summary

spec_version: '0.2'
name: langsmith__session_run_summary
type: model
description: Session-level run health, token, and cost summary by run type and status.
grain:
  - session_id
  - run_type
  - status
source:
  ref: stg_langsmith__runs
joins:
  - ref: stg_langsmith__sessions
    type: left
    on: stg_langsmith__runs.session_id = stg_langsmith__sessions.session_id
columns:
  - name: session_id
    expr: stg_langsmith__runs.session_id
    primary_key: true
    semantic_role: entity_id
    references: stg_langsmith__sessions.session_id
    description: Session or project that owns the runs.
  - name: session_name
    expr: stg_langsmith__sessions.name
    semantic_role: name
    description: Session or project display name.
  - name: run_type
    expr: stg_langsmith__runs.run_type
    primary_key: true
    semantic_role: categorical
    description: LangSmith run type, such as chain, llm, tool, retriever, or embedding.
  - name: status
    expr: stg_langsmith__runs.status
    primary_key: true
    semantic_role: categorical
    description: Run execution status.
  - name: run_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of runs in the session, type, and status bucket.
  - name: error_run_count
    expr: SUM(CASE WHEN stg_langsmith__runs.error IS NOT NULL THEN 1 ELSE 0 END)
    semantic_role: measure
    description: Number of runs in the bucket with captured errors.
  - name: first_run_start_at
    expr: MIN(stg_langsmith__runs.start_time)
    semantic_role: event_timestamp
    description: Earliest run start timestamp in the bucket.
  - name: last_run_end_at
    expr: MAX(stg_langsmith__runs.end_time)
    semantic_role: event_timestamp
    description: Latest run end timestamp in the bucket.
  - name: total_tokens
    expr: SUM(stg_langsmith__runs.total_tokens)
    semantic_role: measure
    description: Total tokens attributed to the bucket.
  - name: total_cost
    expr: SUM(stg_langsmith__runs.total_cost)
    semantic_role: measure
    tags:
      - financial
    description: Total cost attributed to the bucket.
group_by:
  - session_id
  - session_name
  - run_type
  - status
tags:
  - langsmith
  - sessions
  - summary
trust_tier: gold
materialization:
  type: table

### langsmith\_\_sessions

spec_version: '0.2'
name: langsmith__sessions
type: model
description: LangSmith projects and evaluation sessions enriched with dataset context.
grain: session_id
source:
  ref: stg_langsmith__sessions
joins:
  - ref: stg_langsmith__datasets
    type: left
    on: stg_langsmith__sessions.reference_dataset_id = stg_langsmith__datasets.dataset_id
columns:
  - name: session_id
    expr: stg_langsmith__sessions.session_id
    primary_key: true
    semantic_role: entity_id
    description: Unique LangSmith session or project identifier.
  - name: tenant_id
    expr: stg_langsmith__sessions.tenant_id
    semantic_role: entity_id
    description: LangSmith tenant that owns the session.
  - name: session_name
    expr: stg_langsmith__sessions.name
    semantic_role: name
    description: Session or project display name.
  - name: description
    expr: stg_langsmith__sessions.description
    semantic_role: categorical
    description: Human-readable session or project description.
  - name: start_time
    expr: stg_langsmith__sessions.start_time
    semantic_role: event_timestamp
    description: Timestamp when the session began receiving runs.
  - name: reference_dataset_id
    expr: stg_langsmith__sessions.reference_dataset_id
    semantic_role: entity_id
    references: stg_langsmith__datasets.dataset_id
    description: Dataset linked to the session for evaluation projects.
  - name: reference_dataset_name
    expr: stg_langsmith__datasets.name
    semantic_role: name
    description: Name of the linked reference dataset.
  - name: trace_tier
    expr: stg_langsmith__sessions.trace_tier
    semantic_role: categorical
    description: Trace retention or indexing tier for the session.
  - name: test_run_number
    expr: stg_langsmith__sessions.test_run_number
    semantic_role: measure
    description: Evaluation test run number for the session.
  - name: feedback_stats
    expr: stg_langsmith__sessions.feedback_stats
    semantic_role: categorical
    description: Aggregated feedback statistics for runs in the session.
  - name: session_feedback_stats
    expr: stg_langsmith__sessions.session_feedback_stats
    semantic_role: categorical
    description: Aggregated feedback statistics attached directly to the session.
  - name: run_facets
    expr: stg_langsmith__sessions.run_facets
    semantic_role: categorical
    description: Faceted run summary payload for the session.
  - name: extra
    expr: stg_langsmith__sessions.extra
    semantic_role: categorical
    description: Additional session metadata payload.
tags:
  - langsmith
  - sessions
  - projects
trust_tier: gold
materialization:
  type: table

### langsmith\_\_trace_summary

spec_version: '0.2'
name: langsmith__trace_summary
type: model
description: Trace-level rollup of run counts, errors, tokens, and costs.
grain: trace_id
source:
  ref: stg_langsmith__runs
joins:
  - ref: stg_langsmith__sessions
    type: left
    on: stg_langsmith__runs.session_id = stg_langsmith__sessions.session_id
columns:
  - name: trace_id
    expr: stg_langsmith__runs.trace_id
    primary_key: true
    semantic_role: entity_id
    description: Identifier shared by all runs in the trace.
  - name: session_id
    expr: stg_langsmith__runs.session_id
    semantic_role: entity_id
    references: stg_langsmith__sessions.session_id
    description: Session or project that owns the trace.
  - name: session_name
    expr: stg_langsmith__sessions.name
    semantic_role: name
    description: Session or project display name.
  - name: run_count
    expr: COUNT(*)
    semantic_role: measure
    description: Total runs observed in the trace.
  - name: root_run_count
    expr: SUM(CASE WHEN stg_langsmith__runs.parent_run_id IS NULL THEN 1 ELSE 0 END)
    semantic_role: measure
    description: Number of root runs in the trace.
  - name: error_run_count
    expr: SUM(CASE WHEN stg_langsmith__runs.error IS NOT NULL THEN 1 ELSE 0 END)
    semantic_role: measure
    description: Number of runs in the trace with captured errors.
  - name: first_run_start_at
    expr: MIN(stg_langsmith__runs.start_time)
    semantic_role: event_timestamp
    description: Earliest run start timestamp in the trace.
  - name: last_run_end_at
    expr: MAX(stg_langsmith__runs.end_time)
    semantic_role: event_timestamp
    description: Latest run end timestamp in the trace.
  - name: total_tokens
    expr: SUM(stg_langsmith__runs.total_tokens)
    semantic_role: measure
    description: Total tokens attributed to the trace.
  - name: prompt_tokens
    expr: SUM(stg_langsmith__runs.prompt_tokens)
    semantic_role: measure
    description: Prompt tokens attributed to the trace.
  - name: completion_tokens
    expr: SUM(stg_langsmith__runs.completion_tokens)
    semantic_role: measure
    description: Completion tokens attributed to the trace.
  - name: total_cost
    expr: SUM(stg_langsmith__runs.total_cost)
    semantic_role: measure
    tags:
      - financial
    description: Total cost attributed to the trace.
group_by:
  - trace_id
  - session_id
  - session_name
tags:
  - langsmith
  - traces
  - summary
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: langsmith_run_count
description: Number of LangSmith runs.
model: langsmith__runs
expression: COUNT({langsmith__runs}.run_id)
synonyms: [runs, LLM runs, execution count]
tags: [langsmith, ai, observability]
spec_version: '0.2'
type: metric
name: langsmith_error_run_count
description: Number of LangSmith runs that recorded an error.
model: langsmith__runs
expression: SUM(CASE WHEN {langsmith__runs}.error IS NOT NULL THEN 1 ELSE 0 END)
synonyms: [error runs, failed runs, run errors]
tags: [langsmith, ai, reliability]
spec_version: '0.2'
type: metric
name: langsmith_trace_token_count
description: Total tokens across root LangSmith traces. Child runs are excluded because root runs contain aggregate trace token usage.
model: langsmith__runs
expression: SUM(CASE WHEN {langsmith__runs}.parent_run_id IS NULL THEN {langsmith__runs}.total_tokens ELSE 0 END)
synonyms: [trace token usage, root run tokens, aggregate trace tokens]
tags: [langsmith, ai, cost]

## Relationships

spec_version: '0.2'
type: relationship
name: langsmith_runs_to_sessions
description: Each LangSmith run can belong to one session.
left_model: langsmith__runs
right_model: langsmith__sessions
join_columns:
  - left: session_id
    right: session_id
join_type: left
relationship_type: many_to_one
tags: [langsmith, runs, sessions]
spec_version: '0.2'
type: relationship
name: langsmith_examples_to_datasets
description: Each LangSmith example belongs to one dataset.
left_model: langsmith__examples
right_model: langsmith__datasets
join_columns:
  - left: dataset_id
    right: dataset_id
join_type: left
relationship_type: many_to_one
tags: [langsmith, examples, datasets]
