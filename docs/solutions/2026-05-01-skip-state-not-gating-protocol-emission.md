# `skipState` Not Gating Protocol STATE Emission

## Problem

`extractResource()` in `packages/extractor/src/commands/extract.ts` emitted the Bobsled Core protocol STATE message unconditionally, even when the caller passed `skipState: true`. The `skipState` flag was only guarding the durable-state persistence path, not the emission itself.

The billable plan runner (`extract-plan.ts`) calls `extractResource` once per seed input row with `skipState: true`. Without the guard, a plan with N seed rows emitted N STATE messages interspersed with its RECORD messages. A test expecting `['SCHEMA', 'RECORD', 'RECORD']` received `['SCHEMA', 'RECORD', 'STATE', 'RECORD', 'STATE']`.

## Root Cause

The `emitState` call and the durable-save block were structurally adjacent, but only the save was inside the `if (!skipState)` guard:

```typescript
// BEFORE (bug):
let durableBookmark: StreamBookmark | undefined;
await emitter.emitState(resource.name, bookmarkData); // always emits

if (!skipState) {
  const shouldAdvanceState = shouldAdvanceDurableState(opts);
  // ... durable save ...
}
```

The param name `skipState` implies "skip state persistence" — the intended meaning of also skipping STATE message emission was never encoded in the structure.

## Fix

Move `emitState` inside the `if (!skipState)` block so emission and persistence are gated together:

```typescript
// AFTER:
let durableBookmark: StreamBookmark | undefined;

if (!skipState) {
  await emitter.emitState(resource.name, bookmarkData);
  const shouldAdvanceState = shouldAdvanceDurableState(opts);
  // ... durable save ...
}
```

## Why This Is Non-Obvious

- The symptom only appears in billable plan runs (multi-row seeds), not single-resource extractions, so ordinary unit tests against `extractResource` never exercise the affected path.
- The name `skipState` is ambiguous — "skip state" could mean skip the message, skip the persistence, or both. Decoupling the two made it look intentional.
- The plan runner's contract — emit one schema upfront, stream records, no per-row STATE — is implicit. There is no comment at the call site explaining why `skipState: true` must suppress emission.
