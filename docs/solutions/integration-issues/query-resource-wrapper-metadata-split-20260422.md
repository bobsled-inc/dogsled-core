---
module: '@bobsled-inc/integrations'
date: 2026-04-22
problem_type: integration_issue
component: query-resources
symptoms:
  - 'Discovery treated every queryable resource like it had a typed wrapper'
  - 'README capability docs drifted once YAML query coverage expanded beyond pilot wrappers'
  - 'Wrapper and generic execution paths duplicated the same YAML-loading runtime logic'
root_cause: The original pilot coupled public discovery docs to wrapper naming assumptions instead of separating wrapper metadata from YAML-backed query capability discovery.
severity: medium
tags: [query-resources, integrations, docs, wrappers]
---

# Query Resource Wrapper Metadata Split

## Symptom

The first query-resource pilot worked while every public query surface had a hand-written wrapper. As soon as broader YAML `query:` coverage was added, discovery and documentation started lying by omission:

- `listQueryResources()` could discover resources that had no typed wrapper.
- The README capability table still implied every queryable resource lived under `queryResources.*`.
- Wrapper modules and any future generic helper would have duplicated the same "load YAML specs and call extractor query" flow.

## Investigation

The rollout needed two conflicting goals at once:

1. Broaden `query:` coverage across more integration YAMLs.
2. Keep hand-written wrappers limited to a curated public subset.

Keeping the existing `makeQuerySource()` shape alone was not enough because the docs renderer only knew how to derive wrapper names heuristically from integration/resource names. Importing wrapper modules into the catalog was also a dead end because it would create a runtime cycle:

`make-query-source -> catalog -> wrapper registry -> wrapper -> make-query-source`

## Root Cause

The pilot mixed up two separate concerns:

- **Queryable capability discovery** belongs to the YAML-backed catalog.
- **Curated typed wrapper discovery** belongs to a metadata registry owned by the integrations package.

Without that split, discovery-only resources either looked unsupported or forced wrapper sprawl just to keep documentation and public API truthful.

## Solution

Split the public surface into three layers:

1. Add a metadata-only registry at `packages/integrations/src/query-resources/typed-wrapper-bindings.ts`.
   - Store only `integration`, `resource`, and public client-surface strings.
   - Never import wrapper modules into the catalog.

2. Add a generic public helper at `packages/integrations/src/query-resources/query-integration-resource.ts`.
   - Move the shared "load YAML specs and call extractor `queryResource()`" logic there.
   - Make `makeQuerySource()` delegate to that helper instead of duplicating runtime work.

3. Enrich catalog output with optional `typedWrapper`.
   - `listQueryResources()` and `getQuerySpec()` stay YAML-first.
   - Wrapper-backed resources expose `typedWrapper`.
   - Discovery-only resources omit it and are documented/rendered with `queryIntegrationResource('<integration>', '<resource>', ...)`.

That made it possible to expand YAML query coverage immediately while keeping typed wrappers intentionally curated.

## Prevention

- When adding a new queryable resource, decide explicitly whether it is:
  - discovery-only via `queryIntegrationResource()`
  - wrapper-backed via `queryResources.*`
- Keep wrapper registration and wrapper metadata separate.
- Regenerate the README capability table from `render-query-table.ts` instead of hand-editing it.
- If wrapper ergonomics need stronger typing, address that in the dedicated follow-up issue instead of folding type-system refactors into YAML rollout work.
