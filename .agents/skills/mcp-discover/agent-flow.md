# MCP Discover Agent Flow

This file gives a programmatic sequence for agents that need predictable CLI surfaces.

## 1. Enumerate Builders

```bash
dogsled extract mcp list-builders --format json
```

Use this before writing `query.filters.<field>.compile.mode: filter_dsl`.

## 2. Enumerate Tools

```bash
dogsled extract mcp list-tools "$SOURCE" --format json
```

Select read-only tools with list/search/get-style names. Record skipped tools and reasons in the PR body when coverage matters.

## 3. Preview And Scaffold

```bash
dogsled extract mcp discover "$SOURCE" --format json
```

After reviewing the preview, write scaffold files:

```bash
dogsled extract mcp discover "$SOURCE" --write
```

The MCP URL, stdio command, args, and auth belong in the source YAML. The current CLI does not accept per-run transport flags or an `--only-tool` selector.

## 4. Parse Metadata

For each generated YAML resource:

1. Parse `_scaffold_metadata`.
2. Resolve low-confidence fields.
3. Replace placeholder arguments.
4. Confirm primary keys and output field paths.
5. Remove `_scaffold_metadata`.

Do not commit scaffold metadata to the OSS catalog.

## 5. Validate And Verify

```bash
dogsled extract validate "$SOURCE"
dogsled extract verify "$SOURCE"
dogsled extract verify "$SOURCE" --mock
dogsled extract mcp verify-redaction "$SOURCE" --tool "$TOOL_NAME" --format json
pnpm --filter @bobsled-inc/extractor test:unit
pnpm --filter @bobsled-inc/integrations test:unit
```

Validation and connector verification must pass. Redaction verification must show that sentinel secrets, tokens, and emails are redacted from the tool result or error.
