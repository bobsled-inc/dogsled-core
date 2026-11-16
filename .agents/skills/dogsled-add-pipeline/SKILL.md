---
name: dogsled-add-pipeline
description: Add a pipeline to an existing Dogsled repository. Use when a user asks to add a new extract, model, or scheduled pipeline to an existing bobsled.yml.
exposed: true
triggers:
  - add pipeline
  - new extract
  - schedule a pipeline
  - hourly rebuild
  - daily refresh
  - add data pipeline
  - add integration to dogsled
  - connect new data source
  - set up pipeline schedule
---

# Add a dogsled pipeline

Preserve this skill as the stable entry point for adding pipelines. Route all extract-pipeline capability, authoring, resource selection, transport, filtering, state, execution, and troubleshooting decisions to `extract-pipelines`; it is authoritative.

## Workflow

1. Read the Project's pipeline config files and determine whether the requested pipeline is:
   - extract + optional embed + load → use `extract-pipelines` now;
   - Model Spec model materialization (`type: models`) → use `dogsled-model-spec` and the relevant authoring skills.
2. For extraction, inspect `dogsled integrations show <source>` and follow the complete `extract-pipelines` workflow. Every extract pipeline must have an explicit non-empty `resources:` allowlist. Never use `only:` or `exclude:`.
3. For models, add a model pipeline without pretending it extracts data:
   ```yaml
   pipelines:
     snowflake_silver:
       type: models
       connection: snowflake
       models: '*'
       schedule: daily
       warehouse: large # Optional stable ID from this connection's warehouses map
   ```
   Use the existing fragment that owns related pipelines. If you add a nonroot fragment, declare `type: pipeline_config` and group its entries under `pipelines:`. Keep a pipeline name in one file.
   When selecting a warehouse, use only a declared warehouse-map ID (such as
   `large`), never the provider's configured warehouse name (such as
   `BIG_WH`). Omit `warehouse` for providers without a warehouse-ID map.
4. Validate the full configuration with `dogsled runner validate --strict`.
5. Review configuration changes and verify environment references. Use a disposable destination for the first authorized local run.

Do not duplicate extract syntax here. Load destination internals belong to `loader`; embedding provider/model decisions belong to `pipeline` or `ai-model-roles`; local setup diagnosis belongs to `dogsled-troubleshoot`.

## Extract-pipeline capability contract

The following content is transcluded from the single authoritative source so a
consumer routed through this compatibility skill receives the complete contract.

{{include: .agents/skills/extract-pipelines/REFERENCE.md}}
