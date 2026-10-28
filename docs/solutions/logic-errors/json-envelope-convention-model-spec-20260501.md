---
module: model-spec
date: 2026-05-01
problem_type: logic_error
component: commands/lineage
symptoms:
  - 'New JSON output uses camelCase keys (sourceRefs, trustTier) while all other commands use snake_case'
  - "command field value is 'lineage' instead of 'model.lineage' dotted namespace"
  - 'Agents and consumers key-routing on command field receive no results for lineage payloads'
root_cause: New structured output command did not follow the established snake_case + dotted-namespace conventions visible only when comparing multiple command files
severity: medium
tags: [json-output, api-convention, model-spec, agent-native, lineage]
---

# model-spec JSON Envelope Convention Mismatch

## Symptom

A new `model lineage --json` command emitted structured output with:

- camelCase keys: `sourceRefs`, `trustTier`, `effectiveTrustTier`, `columnLineage`
- command field: `"command": "lineage"` (bare verb)

All other model-spec commands use snake_case keys and a dotted namespace:

- `"command": "model.run"`, `"command": "model.profile"`, `"command": "seed.validate"`
- `dry_run`, `model_name`, `rows_affected`, `target_schema`, `execution_results`

Agents consuming the payload and routing on `command` or accessing known keys would silently fail.

## Investigation

The issue was not visible by reading only `lineage.ts` — the convention requires comparing the new file against `run.ts`, `profile.ts`, `seed.ts`, etc. Single-file review misses cross-file conventions.

The `ColumnLineageEntry` type (Layer 1 API) legitimately uses camelCase for its fields (`isComplete`, `upstream`) because it's a TypeScript type and those fields were established before this PR. The new _wrapper_ fields for the envelope were the ones requiring snake_case.

## Root Cause

Two distinct conventions coexist in the same output:

1. `ColumnLineageEntry` fields: camelCase (established TypeScript API, exported type)
2. JSON envelope fields: snake_case (serialization convention, not tied to TS type naming)

New commands that add structured output may not notice the envelope convention without checking existing commands.

## Solution

In `toStructuredPayload()` / `buildJsonPayload()` in any command file, explicitly map TypeScript camelCase fields to snake_case JSON keys:

```typescript
// WRONG — camelCase leaks into JSON output
models: group.models.map((node) => ({
  sourceRefs: node.sourceRefs,
  trustTier: node.parsedSpec.trust_tier ?? 'bronze',
  effectiveTrustTier: group.effectiveTiers.get(node.name),
})),
columnLineage: group.columnLineage,
```

```typescript
// CORRECT — explicit snake_case in the serialized shape
models: group.models.map((node) => ({
  source_refs: node.sourceRefs,         // camelCase TS field → snake_case JSON key
  trust_tier: node.parsedSpec.trust_tier ?? 'bronze',
  effective_trust_tier: group.effectiveTiers.get(node.name) ?? null,  // null not absent
})),
column_lineage: group.columnLineage,
```

For `command`, always use dotted package-verb namespace:

```typescript
command: 'model.lineage',  // not 'lineage'
command: 'seed.validate',  // not 'validate'
```

## Prevention

When adding `--json` output to any model-spec command:

1. **Check `run.ts` and `profile.ts`** before writing the payload builder — the established keys show the expected snake_case convention.
2. **Verify the `command` field** follows `<package>.<verb>` (e.g., `model.lineage`, not `lineage`).
3. **Emit `null` not absent fields**: use `?? null` for optional Map lookups (`effectiveTiers.get(name) ?? null`) so the JSON key is always present.
4. **Layer 1 types stay camelCase in TypeScript**: `ColumnLineageEntry.isComplete` stays camelCase; only the serialization wrapper uses snake_case keys.

## Related Issues

- `packages/model-spec/src/commands/run.ts` — reference implementation for snake_case envelope
- `packages/model-spec/src/commands/profile.ts` — `command: 'model.profile'` pattern
- `packages/model-spec/CLAUDE.md` — lineage command docs (updated to show snake_case keys)
- `packages/model-spec/docs/lineage-quickstart.md` — JSON example (updated to reflect correct shape)
