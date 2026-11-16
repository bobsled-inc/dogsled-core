---
name: sdk-codegen
description: Generate, validate, and explain the typed SDK over a Bobsled Core entity graph.
---

# SDK Codegen

Use this skill when a task mentions `bobsled sdk generate`, generated TypeScript SDKs, SDK IR, branded IDs, profile quality fields, or app code that reads the entity graph.

## References

- `docs/reference/advanced/sdk-codegen.md`
- `packages/sdk-codegen/README.md`
- `packages/sdk-codegen/src/ir/schema.ts`
- `packages/sdk-codegen/src/emitters/typescript/index.ts`

## Workflow

1. Confirm entity graph specs exist and validate:

```bash
bobsled entity-graph resolve validate --json
```

1. Refresh profiles when runtime state matters:

```bash
bobsled entity-graph resolve profile <entity...> --runner ./runner.js --json
```

1. Generate or validate the SDK:

```bash
bobsled sdk generate --lang ts --out ./generated/bobsled-sdk --json
bobsled sdk generate --lang ts --ir-only --json
```

1. Type-check the consumer project:

```bash
pnpm exec tsc --noEmit
```

## Rules

- The v1 CLI supports `--lang ts`. The Python emitter is a library export only.
- Generated SDK files are checked-in app artifacts; do not hand-edit them.
- The SDK is executor-backed. Apps provide the warehouse/API/MCP executor through `BobsledEntityExecutor`.
- Entity spec names define SDK keys. A `company` spec means `bobsled.entity.company`.
- Additions are minor; renames, deletions, and type changes are major and require downstream coordination.
- Every generated profile should expose `_quality` with confidence, freshness, source diversity, and profile coverage.
