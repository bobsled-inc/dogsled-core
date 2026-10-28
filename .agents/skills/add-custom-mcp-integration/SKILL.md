---
name: add-custom-mcp-integration
description: Author a custom_mcp source for any remote MCP server (Model Context
  Protocol over streamable HTTP) purely in YAML — inline mcp_http transport (url
  + auth + auth_env_vars), one resource_kind mcp resource per tool, then
  validate/verify/extract. Use when the MCP server isn't in the bundled catalog.
exposed: true
triggers:
  - mcp
  - mcp server
  - model context protocol
  - bring my own mcp
  - custom mcp
  - connect mcp
  - remote mcp
  - mcp source
  - self-describing mcp
  - pull from mcp
  - extract from mcp
---

# Add a Custom MCP Integration

Use this skill to add a reviewed MCP-backed extraction integration.

## Workflow

1. Read the nearest package guide and inspect the existing implementation and tests.
2. Resolve the decisions below before editing.
3. Use the established schemas, interfaces, security helpers, and error contracts.
4. Implement the smallest compatible change with regression coverage.
5. Run the focused checks, then the repository gate.

## Decisions

- Choose HTTP or stdio transport and an exact, immutable command or endpoint shape.
- Map tool arguments, pagination, authentication, retry, and decoded response limits declaratively.
- Preserve SSRF, redirect, header, subprocess, environment, and credential invariants.

## Completion

- Validate the integration and mock at least one resource and pagination path.
- Cover rejected transports, unsafe command shapes, limits, retry, and redaction behavior.
- Run integration, extractor, security, and repository gates.

## Detailed Reference

Load the full reference only when the task needs its schemas, command tables, examples,
or troubleshooting detail:

{{include: .agents/skills/add-custom-mcp-integration/references/full-guide.md}}
