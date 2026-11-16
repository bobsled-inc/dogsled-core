---
name: build-mcp-server
description: Build a remote MCP (Model Context Protocol) server from scratch —
  pick a language/SDK, define tools, implement streamable HTTP transport, add
  auth, deploy publicly, then connect it as a Bobsled Core custom_mcp source. Use when
  a user wants to expose their own data or operations as an MCP server.
exposed: true
triggers:
  - build mcp server
  - build an mcp server
  - create mcp server
  - write mcp server
  - author mcp server
  - expose mcp
  - my own mcp server
  - mcp endpoint
  - mcp http server
  - publish mcp server
  - host mcp server
---

# Build an MCP Server

Use this skill when exposing Bobsled Core capabilities through an MCP server.

## Workflow

1. Read the nearest package guide and inspect the existing implementation and tests.
2. Resolve the decisions below before editing.
3. Use the established schemas, interfaces, security helpers, and error contracts.
4. Implement the smallest compatible change with regression coverage.
5. Run the focused checks, then the repository gate.

## Decisions

- Define the smallest composable tools and explicit input/output schemas.
- Maintain outcome parity without exposing unrestricted filesystem, network, or subprocess access.
- Bound payloads, validate principals, redact errors, and keep write actions explicitly gated.

## Completion

- Test tool schemas, authorization, malformed requests, limits, redaction, and transport failures.
- Verify read-only defaults and explicit completion/error results.
- Run focused MCP, security, and repository gates.

## Detailed Reference

Load the full reference only when the task needs its schemas, command tables, examples,
or troubleshooting detail:

{{include: .agents/skills/build-mcp-server/references/full-guide.md}}
