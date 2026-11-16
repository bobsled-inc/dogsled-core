---
name: query-wrapper-authoring
description: Add or update a curated typed query wrapper in @bobsled-inc/integrations once a resource already exposes a validated query block.
---

# Query wrapper authoring

Use this skill after the extractor-side `query:` work is already done and validated.

## When to stop on the extractor side

Stay in `.agents/skills/extractor-query-authoring/SKILL.md` until all of these are true:

1. The resource YAML has a valid `query:` block.
2. The resource passes validation and any provider checks you can run offline.
3. `listQueryResources()` / `getQuerySpec()` can discover the resource from YAML alone.

Once those are true, decide whether the resource should remain discovery-only or get a curated typed wrapper.

Default to discovery-only unless the resource is a high-signal public pilot, heavily reused, or especially valuable as a typed example in docs/tests.

## Workflow

1. Confirm the resource is already queryable from YAML.
   Run:
   - `bobsled extract validate <integration>`
   - `bobsled extract verify <integration>`
   - `bobsled extract verify <integration> --mock`
   - `pnpm --filter @bobsled-inc/integrations test:unit`

2. Hand-write the three public types from the YAML.
   - `Record` type: copy the `output` block field names and scalar kinds exactly.
   - `Filter` type: mirror `query.filters`, using the per-operator helpers that match the YAML operators: `MongoEqFilter<TScalar>`, `MongoContainsFilter<TScalar>`, `MongoGteFilter<TScalar>`, or `MongoLteFilter<TScalar>`.
   - Context input type: start from `input`, then remove any bound query inputs because callers must pass those via `filter` or `search`, not `input`.

3. Create the wrapper file under `packages/integrations/src/query-resources/`.
   - Filename pattern: `<integration>-<resource>.ts`
   - Wrapper export name: camel-case the resource name exactly as it appears under `queryResources`
   - Examples:
     - `branches` -> `queryResources.github.branches`
     - `get_event_types` -> `queryResources.calendly.getEventTypes`
     - `search_issues` -> `queryResources.jira.searchIssues`

4. Build the wrapper with `makeQuerySource(...)` and the capability constant that matches the YAML.
   - Filter-only wrappers: `makeQuerySource<TRecord, TInput, TFilter>(integration, resource, FILTER_ONLY_QUERY_SOURCE_CAPABILITIES)`
   - Search-only wrappers: `makeQuerySource<TRecord, TInput>(integration, resource, SEARCH_ONLY_QUERY_SOURCE_CAPABILITIES)`
   - Resources that support both: `makeQuerySource<TRecord, TInput, TFilter>(integration, resource, FILTER_AND_SEARCH_QUERY_SOURCE_CAPABILITIES)`
   - Keep wrappers thin.
   - Do not duplicate runtime YAML loading or extractor execution logic inside the wrapper.

5. Register the wrapper in `packages/integrations/src/query-resources/index.ts`.
   - Import the wrapper module.
   - Re-export the wrapper and its public types.
   - Add it to the `queryResources` object in the right integration namespace.

6. Register wrapper metadata in `packages/integrations/src/query-resources/typed-wrapper-bindings.ts`.
   - Integration name
   - Resource name
   - Client-surface string (e.g., `queryResources.github.branches`)
   - Keep this file metadata-only. Do not import wrapper modules into the catalog layer.

7. Update public docs.
   - Refresh the `Query resources` section in `packages/integrations/README.md`.
   - Keep the capability table truthful: wrappers should show their `queryResources.*` surface, discovery-only resources should show `queryIntegrationResource('<integration>', '<resource>', ...)`.
   - Regenerate the table with `pnpm --filter @bobsled-inc/integrations render:query-table`.

8. Run the integrations package gates.
   - `pnpm --filter @bobsled-inc/integrations build`
   - `pnpm --filter @bobsled-inc/integrations typecheck`
   - `pnpm --filter @bobsled-inc/integrations lint`
   - `pnpm --filter @bobsled-inc/integrations test:unit`
   - `pnpm --filter @bobsled-inc/integrations test:types`

9. Run the repo gates before shipping.
   - `pnpm check`
   - `pnpm test:unit`
   - `pnpm format:check`

## Wrapper typing expectations

`makeQuerySource()` is capability-aware.

Current expectations:

- Filter-only wrappers should expose `filter` and hide `search`.
- Search-only wrappers should expose `search` and hide `filter`.
- Required context inputs must make the `input` object required at the wrapper surface.
- Dual-capability wrappers must accept either `filter` or `search`, but never both in the same call.

If a resource cannot be expressed cleanly with those rules, pause and resolve the wrapper ergonomics before adding the wrapper.
