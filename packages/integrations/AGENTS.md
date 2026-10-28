# @bobsled-inc/integrations — Agent Guide

<!-- last-reviewed: 2026-07-27 -->

YAML source library for API and MCP specs. Each source defines transport config, metadata, and per-resource endpoint specs consumed by the extractor.

---

## Source Directory Structure

```text
sources/<name>/
  source.yml          # Transports; loader also accepts source.yaml and legacy integration.yml
  meta.yml            # Display: name, description, category, docs URL, auth setup steps
  resources/**/*.yml  # One file per API/MCP resource; identifiers come from resource.name
```

Bundled sources use the `resources/` subdirectory and the integrations package loader
supports nested transport variants there. Local extractor project resources still use
the flat `<resources_dir>/<source_name>/*.yml` layout.

## Adding an Integration

Use the `/add-integration` skill for the full workflow. See the root AGENTS.md Builder's Skill Index for all available skills.

Quick checklist:

1. Start from the API's OpenAPI spec if available (`dogsled extract generate`)
2. Resolve ALL `# REVIEW:` markers — specs with these markers fail validation
3. Ensure every resource has a non-empty `description`
4. Ensure every resource defines `primary_key` fields
5. Wire `for_each` on child endpoints (e.g., `/campaigns/{id}/leads` needs `for_each` pointing to the parent resource)
6. Validate: `dogsled extract validate`
7. Run the offline gate: `dogsled extract verify <integration>`
8. Run mock execution when the transport is HTTP: `dogsled extract verify <integration> --mock`
9. Run tests: `pnpm --filter @bobsled-inc/integrations test:unit`
10. Test live when credentials are available: `dogsled extract scaffold-test`

Required gate order for new or changed connectors:

1. `dogsled extract validate <integration>`
2. `dogsled extract verify <integration>`
3. `dogsled extract verify <integration> --mock`
4. `pnpm --filter @bobsled-inc/integrations test:unit`

**Reference integrations**: GitHub and Stripe are the most complete — copy their patterns.

## Quality Requirements

The test suite (`validate-all.test.ts`) enforces these automatically:

- No `# REVIEW:` markers in any spec file
- Non-empty descriptions on all resources
- At least one output field per resource
- Primary keys defined
- `for_each` present on child endpoints that have a sibling parent resource
- All specs pass Zod schema validation

## Common Pitfalls

- **Never bypass `assertSafeName()`** when resolving integration or resource paths
- **No underscore-prefixed directories** unless they are templates or intentionally hidden
- **No secrets in YAML** — integration docs should reference env-var setup only (e.g., `$MY_TOKEN`)
- **`meta.yml openapi_url` may be either an HTTPS URL or an integration-relative spec file** when a curated verify subset is needed for stable offline drift checks
- **Do not duplicate extractor schemas** — `src/validate.ts` re-exports from the extractor package
- **YAML cache**: `loader.ts` caches parsed YAML for CLI processes. Clear the cache in tests or long-running processes

## Key Source Files

| File              | Purpose                                                   |
| ----------------- | --------------------------------------------------------- |
| `src/index.ts`    | Public API: listing, loading, searching sources           |
| `src/loader.ts`   | Filesystem access, YAML parsing, cache, safe path helpers |
| `src/validate.ts` | Zod schemas (re-exports from extractor)                   |
| `src/types.ts`    | SourceSummary, Source, SourceResource types               |

## Development

```bash
pnpm --filter @bobsled-inc/integrations build
pnpm --filter @bobsled-inc/integrations typecheck
pnpm --filter @bobsled-inc/integrations lint
pnpm --filter @bobsled-inc/integrations test:unit
pnpm --filter @bobsled-inc/integrations test:types
```
