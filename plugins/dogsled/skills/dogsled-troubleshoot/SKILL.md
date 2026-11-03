---
name: dogsled-troubleshoot
description: Diagnose and fix dogsled pipeline failures — auth issues, rate
  limits, schema drift, transient errors
---

# Dogsled Troubleshoot

Diagnose local Dogsled pipelines using `extract-pipelines` as the authoritative extraction contract. Read the Project guide, the owning `dogsled.yml` or typed pipeline fragment, `extractor.yml`, and the relevant integration/resource files.

## Validate and locate the failure

1. Run `dogsled setup doctor` for guided setup problems.
2. Run `dogsled runner validate --strict` to check orchestration and references.
3. Validate the affected integration with `dogsled extract validate <source> --semantic-check=strict`; use `dogsled extract verify <source> --mock` for fixture-backed checks.
4. Read the failed command's structured stderr and summary. stdout is protocol data and must stay machine-readable. Never include credentials or raw provider bodies in a report.
5. Identify the exact source, resource, destination and execution phase before proposing a retry. Inspect environment-variable names and presence only.

## Failure categories

- **Authentication (401/403):** compare required integration auth metadata with environment references and provider permissions. Never print token values. Retry only after the user fixes the credential or permission.
- **Plan restriction (400/403):** inspect the resource's documented availability. Remove an unavailable resource from the explicit selection or ask the user to change their provider plan; do not invent an endpoint.
- **Rate limit (429):** use the integration's documented retry/backoff behavior. Reduce resource scope or schedule frequency when appropriate.
- **Schema drift:** inspect pipeline/resource `schema_behavior`, types, keys and load strategy. Follow `extract-pipelines` for supported schema repair. Confirm destructive changes before a real write.
- **Transient failure (500, timeout, network):** inspect the cause and the last successful phase. Retry a bounded affected resource only after confirming the destination and resume behavior are safe.
- **State/resume problem:** inspect the configured local state/checkpoint location and resource identity. Back up state before an intentional reset; never delete cursors merely to hide a failure. Preview runs do not advance durable state.
- **Unsupported configuration:** current pipeline files reject root `state`, `runner`, `agent`, and `console`. A pipeline's `runner` may only be `managed` (the default). Old project files require the consuming app's migration before validation.
- **for_each child failure:** the parent and child must execute together in dependency order. Include the parent in the same pipeline's explicit `resources` list and validate the child's `extract.for_each.resource` reference.

## Verify the fix

Repeat static validation first. When the user authorizes execution, point at a disposable destination and run `dogsled runner run <pipeline> --resource <resource>`. Verify rows, schema, table names, load strategy and cursor behavior. A bounded extractor preview is useful diagnosis but does not prove state-advancing execution. Keep schedules and retry policy in the caller's orchestration layer.
