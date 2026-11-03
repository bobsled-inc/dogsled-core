---
name: mcp-discover
description: Discover MCP server tools and scaffold Dogsled source/resource YAML
  using dogsled extract mcp commands.
---

# MCP Discover

Use this skill when adding or extending a Dogsled Source from an MCP server.

## Workflow

### 1. Gather Inputs

Required:

- Source name, such as `linear` or `hubspot`
- An existing `source.yml` that already declares an MCP transport.
- Transport configuration lives in YAML, not in `mcp` command flags:
  - `mcp_http` uses `url` plus YAML auth config.
  - `mcp_stdio` uses `command` and optional `args`.

If you encounter a legacy `integration.yml`, migrate it to `source.yml` before authoring new MCP work.

Never put literal secrets in YAML. Use env-var indirection.

### 2. List Tools

```bash
dogsled extract mcp list-tools <integration> --format json
```

Prefer read-only list/search/get tools. This command enumerates the tools exposed by the configured MCP transport and does not write files.

### 3. Discover

Preview the full server:

```bash
dogsled extract mcp discover <integration> --format json
```

Write scaffold files after reviewing the preview:

```bash
dogsled extract mcp discover <integration> --write
```

Use `--no-dry-run` when you want to rely only on declared `outputSchema` and avoid probing tools that do not expose one. `--concurrency <n>` controls dry-run probe parallelism.

### 4. Enrich Scaffolded Resources

Open every generated resource and inspect `_scaffold_metadata`.

- Replace guessed primary keys with authoritative keys.
- Confirm `extract.record_path`.
- Replace placeholder descriptions.
- Add or refine pagination.
- Add `query.filters.<field>.compile` when the tool supports query arguments.
- Remove `_scaffold_metadata` before committing catalog YAML.

### 5. Validate

```bash
dogsled extract validate <integration>
dogsled extract verify <integration>
dogsled extract verify <integration> --mock
pnpm --filter @bobsled-inc/extractor test:unit
pnpm --filter @bobsled-inc/integrations test:unit
```

Fix all validation errors. Warnings about `_scaffold_metadata` mean the resource is still scaffold-stage.

### 6. Verify Redaction

For any server/tool that required dry-run shape inference:

```bash
dogsled extract mcp verify-redaction <integration> --tool <tool_name> --format json
```

Inspect the JSON payload and confirm sentinel secrets, tokens, and emails are redacted by `redactSensitiveValues` before using dry-run output as scaffold evidence.

## Agent Notes

- Resource names are canonical external identifiers. Filesystem nesting is internal.
- Multi-transport resources should declare explicit `via: <transport-id>`.
- Use `entity: <logical_entity>` when the same entity exists through multiple transports.
- Keep MCP resources read-only unless the user explicitly asks for action tooling.
