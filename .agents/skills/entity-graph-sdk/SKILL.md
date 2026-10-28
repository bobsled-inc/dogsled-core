---
name: entity-graph-sdk
description: Run the entity-graph + mention-extraction + typed-SDK workflow — cross-source entity resolution, document mentions linked to resolved entities, generated TypeScript SDK, MCP read checks, doctor checks, and review exports.
---

# Entity Graph + Typed SDK

Use this skill when a task asks for resolved entity profiles, document mentions, generated SDKs, mention review queues, MCP read access to documents/chunks, or "company brain"-style cross-source resolution.

## Start Here

Read these first:

- `docs/guides/entity-graph.md`
- `docs/reference/advanced/mention-extraction.md`
- `docs/reference/advanced/sdk-codegen.md`
- `docs/reference/advanced/mcp-read-source.md`
- `docs/reference/advanced/entity-graph-authoring-guide.md`

## Workflow

1. Validate model roles:

```bash
dogsled doctor --json
dogsled ai test --connection mention_disambiguation_v1 --json
```

1. Resolve and profile entities:

```bash
dogsled entity-graph resolve validate --json
dogsled entity-graph resolve run <entity...> --runner ./runner.js --json
dogsled entity-graph resolve cluster <entity...> --runner ./runner.js --json
dogsled entity-graph resolve profile <entity...> --runner ./runner.js --json
```

1. Export mention review rows:

```bash
dogsled entity-graph mentions review export --runner ./runner.js --schema entity_graph --json
```

1. Review and compact document-derived relationships:

```bash
dogsled entity-graph relationships review export --runner ./runner.js --schema entity_graph --yaml
dogsled entity-graph relationships review apply relationship_decisions.yml --runner ./runner.js --json
dogsled entity-graph relationships compact --runner ./runner.js --schema entity_graph --json
```

1. Generate the SDK:

```bash
dogsled sdk generate --lang ts --out ./generated/dogsled-sdk --json
```

1. Run quality gates:

```bash
pnpm --filter @bobsled-inc/entity-graph test:unit
pnpm --filter @bobsled-inc/sdk-codegen test:unit
pnpm --filter @bobsled-inc/dogsled test:unit
pnpm precommit
```

## Operating Rules

- Use `--json` or `--yaml` whenever another agent or script consumes output.
- Entity spec names become generated SDK keys. `customer` becomes `dogsled.entity.customer`.
- The generated TypeScript SDK is executor-backed; do not claim it opens warehouse connections itself.
- The executor returns `Array<EntityFindResult>`; `.first()` and `.all()` are SDK-side conveniences.
- Use MCP `read_source` for low-level document/chunk reads with citations; use the generated SDK for typed entity profiles and relationships.
- Treat `compromise_ner`, `schema_violation`, and unresolved mentions as review-queue material.
- Treat relationship evidence and decisions as append-only; public consumers read compacted `__entity_relationship`, not internal `__entity_relationship_edge`.
- Run `resolve profile` before SDK generation so the entity profile inventory is current.
- Run `dogsled doctor --json` after chunker config changes and before PR close-out.
- Do not write internal doctor namespaces in user-facing docs; describe the concrete check names instead.
