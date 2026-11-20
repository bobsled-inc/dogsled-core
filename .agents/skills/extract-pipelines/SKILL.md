---
name: extract-pipelines
description: Author and operate dogsled extract pipelines end to end, including pipeline configuration files, resource YAML, transports, filters, pushdown, incremental state, destinations, schedules, validation, local execution, and troubleshooting. Use when creating, changing, running, or diagnosing an extract pipeline or asking what extraction functionality Dogsled supports.
exposed: true
triggers:
  - author extract pipeline
  - manage extract pipeline
  - configure dogsled yml extraction
  - add resources to pipeline
  - filter extracted records
  - incremental extraction
  - extract filter operators
  - extract pipeline transport
  - run scheduled extraction
  - troubleshoot extraction pipeline
---

# Extract pipelines

This is the authoritative skill for dogsled extract-pipeline capability and workflow. Use it for both orchestration in a root `dogsled.yml` or typed pipeline-config fragments and extractor resource behavior. Other skills may collect a goal, implement a new connector, configure a loader, or diagnose infrastructure, but must route extract-pipeline decisions here.

## Required workflow

1. Inspect the Project's pipeline config files and capability before editing. A root `dogsled.yml` or `dogsled.yaml` remains valid. Nonroot fragments declare `type: pipeline_config`. Read the config file that owns the related pipeline, then inspect:
   ```bash
   dogsled integrations list
   dogsled integrations show <source>
   ```
   Read the owning pipeline fragment, `extractor.yml`, and project-local `integrations/` and `resources/`. Never guess resource names, transport ids, inputs, auth variables, or destination fields.
2. Decide the boundary:
   - Pipeline config files own source-to-destination orchestration, the explicit resource allowlist, transport selection, schedule, optional embedding, and runner behavior. Dogsled merges fragments by declared names and rejects duplicate owners.
   - Integration/resource YAML owns transport/auth, request/tool/query shape, pagination, output mapping, filters, incremental cursors, and table metadata.
   - Loader configuration owns destination-specific behavior. Model Spec model pipelines are not extract pipelines.
3. Author the smallest explicit pipeline. Every extract pipeline must declare non-empty `resources:`. Never write `only:` or `exclude:`.
4. Decide the destination schema contract before the first write. Set `schema_behavior` explicitly to `evolve`, `strict`, or `freeze` in `extractor.yml` `default_load.defaults` or in the resource's `load.defaults`; the resource load block replaces the project default rather than merging with it. For Snowflake, an effective `full_refresh` with the default `evolve` behavior replaces a drifted table before loading; `strict` fails on drift and `freeze` leaves the physical schema unchanged. Treat an upstream rename as a migration, not an evolution. For an existing Snowflake table that needs an in-place one-shot repair, target the stream with `dogsled load run --dest snowflake --reconcile-schema <stream>` and use an effective `full_refresh` strategy; follow the repair with a normal `strict` run. A managed/background adapter without shell access should pass the same request through Dogsled's public `runProjectPipeline` API as `reconcileSchema: [<stream>]` together with `fullRefresh: true`; the adapter maps its validated task override to those fields. Dogsled's MCP server is read-only (`read_source`) and is not the pipeline execution surface.
5. Validate resource semantics before any write, then validate runner orchestration.
6. Verify environment-variable references and review the intended destination before execution.
7. Run a bounded extraction against a disposable destination first. Treat `dogsled runner run` as a real write. A run using extractor `--limit` is preview-only and never advances durable state.
8. Verify destination rows/schema and state behavior. Review pipeline configuration changes before committing.

## Safe command ladder

```bash
dogsled extract validate <source> --semantic-check=strict
dogsled extract verify <source>
dogsled extract verify <source> --mock
# HTTP API integrations only, with credentials:
dogsled extract scaffold-test <source>
# MCP, warehouse, and file sources: use their source-specific checks, then a
# bounded extractor preview. Do not use scaffold-test for these source kinds.
dogsled extract run --integration <source> <resource> --limit 5

dogsled runner validate --strict
# Real write: first point dogsled.yml at a disposable destination.
dogsled runner run <pipeline> --resource <resource>
```

A file Resource with `source.kind: copy` cannot be previewed with `dogsled extract run` alone. It writes `FILE` lines and then waits for a loader to read them, and it refuses to write to a terminal or a file. Pipe the preview into a loader instead. `--limit` still caps the files and saves no state:

```bash
dogsled extract run --integration <source> <resource> --limit 5 | dogsled load run --dest local --format jsonl --output-dir ./preview
```

A pipeline with a copy Resource takes one destination, of type `local`, `s3` or `gcs`. `PIPELINE_SUMMARY` counts rows, so it shows 0 records for a copy. Read the `METRIC` line instead. It carries `files_processed` and `bytes_downloaded`, which are both 0 when a run copied nothing.

If an applicable check fails, do not run past it. `scaffold-test` is
not applicable to MCP, warehouse/database, or file-storage sources. Use
`dogsled-troubleshoot` for runtime failures and local setup problems.

## Authoritative reference

Read and apply the complete capability contract below. It defines exact YAML shapes, operator vocabularies, pushdown and state semantics, supported boundaries, and troubleshooting rules.

{{include: .agents/skills/extract-pipelines/REFERENCE.md}}
