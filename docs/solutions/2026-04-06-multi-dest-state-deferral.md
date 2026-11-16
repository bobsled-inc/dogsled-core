# Multi-Destination State Deferral

## Problem

`bobsled pipeline` historically coupled extraction and loading in a single stream. That meant extractor state advanced as soon as extraction finished. With multi-destination fan-out, that behavior is unsafe: one destination can fail after another succeeds, and PostgreSQL CDC has an external side effect in replication-slot advancement that cannot be rolled back by just restoring `state.json`.

## Solution

Split state advancement into two phases for the multi-destination path:

1. Run the extractor with `--no-state-write` so it still emits `STATE` messages but does not persist bookmarks or advance CDC slots.
2. Capture the extractor stdout protocol to a temp JSONL file and replay that file into all loaders in parallel.
3. Only after every loader exits successfully, run `bobsled extract commit-state --integration <name> --capture-file ...` to merge captured `STATE` messages into durable state and advance PostgreSQL CDC slots.

This keeps retries correct for normal incremental bookmarks and preserves the existing CDC ordering guarantee of "save bookmark before advancing slot", but now only after all destinations have confirmed success.

## Why This Matters

Fan-out changes the failure model from "one extract, one load" to "one extract, many independent loads". Deferring state writes until after replay makes the extractor protocol the source of truth for successful progress and avoids partial-success data loss on retry. The extra `commit-state` step also isolates state persistence into an explicit operation that other orchestration layers can reuse later.
