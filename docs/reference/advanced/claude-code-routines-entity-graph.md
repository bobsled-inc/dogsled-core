# Claude Code Routines for OSS Entity Graph

Claude Code routines are a good fit for bounded, one-shot entity graph tasks. The `dogsled entity-graph agent` surface is designed to keep that workflow repo-native and provider-neutral.

## Routine Pattern

1. Read the shared [`entity-graph-resolve` skill](../../../.agents/skills/entity-graph-resolve/SKILL.md). If the task is authoring or debugging specs, also read [`entity-graph-authoring`](../../../.agents/skills/entity-graph-authoring/SKILL.md).
2. Run exactly one `dogsled entity-graph agent ... --json` command.
3. Prefer `--mode propose` unless the routine prompt explicitly authorizes writes.
4. If writes are allowed, use a repo-native profile under `entity-graph/agent/*.yml` so limits, post-apply behavior, and bundle output paths are versioned in Git.

## Recommended Commands

```bash
dogsled entity-graph agent triage company --runner ./runner.js --json
dogsled entity-graph agent review-batch --entity company --mode propose --runner ./runner.js --json
dogsled entity-graph agent review-batch --profile ./entity-graph/agent/company_review_batch.yml --runner ./runner.js --json
dogsled entity-graph agent survivorship-refresh company --runner ./runner.js --json
dogsled entity-graph agent truthset-regress company --runner ./runner.js --json
```

## Prompt Guidance

- Ask the routine to run only one task per invocation.
- Tell it to prefer `--json` and repo-native profiles.
- Tell it to default to proposal mode and only switch to apply mode when the prompt explicitly allows writes.
- Keep post-apply chaining explicit: `none`, `cluster`, or `cluster,survivorship`.
