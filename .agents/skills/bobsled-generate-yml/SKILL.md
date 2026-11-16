---
name: bobsled-generate-yml
description: Generate a bobsled.yml pipeline configuration from a plain-English goal. Use when a user describes data to sync, sources, destinations, schedules, or analytics and wants Dogsled configuration.
argument-hint: '<goal> — e.g., "sync stripe and hubspot to bigquery every 4 hours"'
exposed: true
triggers:
  - generate dogsled yml
  - create pipeline config
  - sync stripe to bigquery
  - build dogsled config from goal
  - generate pipeline from description
  - write dogsled yml
  - configure data sync
  - set up analytics pipeline
---

# Generate a dogsled pipeline configuration from a goal

Translate the goal into pipeline intent, then route each pipeline type to its authoritative skill. For extract pipelines, load and follow `extract-pipelines` before emitting YAML; do not invent a parallel configuration reference here.

## Workflow

1. Parse the goal into source integrations, destination, exact resources, transport preference, schedule, and optional embeddings/models.
2. Inspect the repository and its pipeline config files. Keep the root `bobsled.yml` or `bobsled.yaml` when it already owns the related pipeline. For a domain-specific fragment, add a typed `pipeline_config` file. Discover capabilities with:
   ```bash
   dogsled integrations list
   dogsled integrations show <source>
   ```
3. For each extract pipeline, use `extract-pipelines` to select resources, transports, inputs, destinations, fan-out, filters, and incremental behavior. `resources:` must be an explicit non-empty allowlist; never generate `only:` or `exclude:`.
4. Route destination-specific fields to `loader`, embedding provider/model decisions to `pipeline` or `ai-model-roles`, and Model Spec model configuration to `bobsled-model-spec`.
5. Preserve unrelated existing configuration and use `$ENV_VAR` references for secrets. Declare environment names in `auth_env_vars` on every integration, pipeline destination, and webhook action. Model connections need declarations for custom key names.
6. Validate before presenting or writing:
   ```bash
   dogsled runner validate --strict
   ```
7. Explain required environment variables, local execution boundaries, and the safe first-run command from `extract-pipelines`.

Do not default unspecified resources to “all.” Inspect the integration and either select the resources justified by the goal or ask for the missing choice. Writing `bobsled.yml` is an implementation action; when authorized, edit it with the repository workflow rather than printing shell redirection instructions.

## Extract-pipeline capability contract

The following content is transcluded from the single authoritative source so a
consumer routed through this compatibility skill receives the complete contract.

{{include: .agents/skills/extract-pipelines/REFERENCE.md}}
