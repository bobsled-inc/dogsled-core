---
name: pipeline
description: Compose and run Dogsled protocol stages from extraction through optional embedding and loading. Use when running an end-to-end pipeline, configuring embeddings, or verifying loaded output.
exposed: true
triggers:
  - run pipeline
  - extract and load
  - run etl
  - dogsled pipeline command
  - extract to bigquery
  - load to duckdb
  - end to end data pipeline
  - multi destination fanout
  - pipeline with retry
---

# Run an end-to-end pipeline

This skill owns composition across extract → optional embed → load. The `extract-pipelines` skill is authoritative for pipeline-config authoring, resources, transports, filters, incremental state, schedules, fan-out constraints, safe validation, and runner operations. Load it first whenever those concerns are involved.

## Composition boundary

- Extract behavior and runner orchestration → `extract-pipelines`.
- Embedding fields/providers/model roles → `ai-model-roles` plus the embed guidance below.
- Destination configuration and load strategy → `loader`.
- Model Spec model materialization → `dogsled-model-spec`; it is not extraction.

For direct composition, stdout carries Dogsled protocol data and stderr carries structured logs:

```bash
dogsled extract run --integration <source> <resource> \
  | dogsled embed --config ./embedder.json \
  | dogsled load run --dest <destination> ...
```

For a configured pipeline, use the safe command ladder and destination precautions in `extract-pipelines`:

```bash
dogsled runner run <pipeline> --resource <resource>
```

An `embed:` block enriches selected text fields between extraction and loading. Use environment placeholders for credentials, validate stream/field names against resource output, enforce model dimensions and cost budgets, and confirm the destination supports vector columns. Use `DOGSLED_EMBED_STUB=1` only for wiring tests that intentionally avoid a provider call.

The keys of `embed.streams` are resource names. For a document resource, the key stands for its chunk stream and the field must be `text`. `dogsled embed` and `--embed-config-json` take exact stream names instead, such as `<resource>__chunks`. With `provider: host`, the application that runs Dogsled supplies the model, so the block has no `model` or `api_key`.

After running, verify destination row counts, schema, table/load strategy, vector dimensions when applicable, and state behavior. Never interpret a limited extractor preview as a state-advancing acceptance run.

## Detailed direct-CLI reference

Read this only when using the legacy/direct `dogsled pipeline` command rather than dogsled runner orchestration:

{{include: .agents/skills/pipeline/references/cli-reference.md}}

## Extract-pipeline capability contract

The following content is transcluded from the single authoritative source so a
consumer routed through this compatibility skill receives the complete contract.

{{include: .agents/skills/extract-pipelines/REFERENCE.md}}
