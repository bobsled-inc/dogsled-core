---
name: entity-graph-resolve
description: Run the current Bobsled Core OSS entity graph workflow end to end. Use when executing resolve, review, cluster, profile, survivorship, truthset, or bounded model-agent routines against an existing entity graph project.
---

# Agent-Native Entity Graph

Bobsled Core's OSS entity graph workflow is repo-native and CLI-first. Use this skill for end-to-end execution and bounded `entity-graph agent` routines. For spec authoring and command selection, also read [`../entity-graph-authoring/SKILL.md`](../entity-graph-authoring/SKILL.md). For document mentions and SDK generation, use [`../entity-graph-sdk/SKILL.md`](../entity-graph-sdk/SKILL.md).

The expected lifecycle is:

```bash
bobsled model seed validate
bobsled model seed load --runner ./runner.js
bobsled entity-graph resolve validate
bobsled entity-graph resolve run --runner ./runner.js
bobsled entity-graph review export company --template --runner ./runner.js --output ./review/company_queue.csv
bobsled entity-graph review apply --input ./review/company_queue.csv --entity company --runner ./runner.js
bobsled entity-graph resolve cluster company --runner ./runner.js
bobsled entity-graph resolve profile company --runner ./runner.js
bobsled entity-graph survivorship run company --runner ./runner.js
bobsled entity-graph truthset score company --runner ./runner.js
bobsled entity-graph truthset tune company --runner ./runner.js
bobsled entity-graph mentions extract company --runner ./runner.js --fallback compromise --json
bobsled entity-graph mentions review export --runner ./runner.js --schema entity_graph --json
bobsled entity-graph relationships extract company --runner ./runner.js --fallback compromise --json
bobsled entity-graph relationships review export --runner ./runner.js --schema entity_graph --yaml
bobsled entity-graph relationships review apply relationship_decisions.yml --runner ./runner.js --json
bobsled entity-graph relationships compact --runner ./runner.js --schema entity_graph --json
bobsled sdk generate --lang ts --out ./generated/bobsled-sdk --json
```

## Operating Rules

- Prefer `--json` whenever another agent or script needs to consume the results.
- Treat `packages/entity-graph/src/commands/` as the source of truth for shipped Entity Graph commands.
- Use `packages/model-spec/src/commands/` only for model/seed command behavior.
- Do not assume proposed roadmap commands already exist.
- Use `review export --template` for editable CSVs. It includes blank decision columns and excludes already-decided pairs by default.
- Use `review list` and `review show` before making decisions programmatically.
- Use `review decide` for one-off agent actions and `review apply --batch-id <value>` for batch imports.
- Use `resolve status`, `resolve estimate`, and `resolve inspect pair|cluster` to understand state before editing specs.
- Run `resolve profile` after `resolve cluster` when downstream consumers need `__entity_profile` and `__entity_quality`.
- Run `mentions extract` before `mentions review export` when downstream agents need the document-mention review queue.
- Run `relationships extract` before `relationships review export/apply` and `relationships compact` when document-derived relationships need to become public `__entity_relationship` rows.
- Run `bobsled sdk generate --lang ts` only after profiles are fresh; generated SDK keys match entity spec names.
- Use `survivorship inspect` to verify golden-record output and audit/history trails.
- Keep truthsets in the repo and use `truthset score` plus `truthset tune` to regress threshold changes before opening a PR.

## One-shot Agent Tasks

- Start with `bobsled entity-graph agent triage company --runner ./runner.js --json` to get one recommended next action without stitching multiple commands together.
- Prefer `bobsled entity-graph agent review-batch --entity company --mode propose --runner ./runner.js --json` for unattended review proposals.
- Use `bobsled entity-graph agent review-batch --profile ./entity-graph/agent/company_review_batch.yml --runner ./runner.js --json` when the repo already carries task policy and output paths.
- Use `bobsled entity-graph agent review-batch --mode apply --post-apply cluster,survivorship --runner ./runner.js --json` only when the task explicitly allows writes.
- Use `bobsled entity-graph agent truthset-regress company --runner ./runner.js --json` for one-shot threshold regression and `bobsled entity-graph agent survivorship-refresh company --runner ./runner.js --json` after clustering.
- Run one `entity-graph agent` task per routine invocation. Default to `--mode propose` unless the task explicitly says to apply writes.

## Artifact Layout

```text
project/
├── seeds/
│   ├── reference_data.yml
│   └── data/reference_data.csv
├── sources/
├── entity-graph/                # Entity graph spec directory
│   ├── agent/company_review_batch.yml
│   ├── company_resolution.yml
│   ├── company_survivorship.yml
│   ├── company_truthset.yml
│   └── data/company_truthset.csv
└── model-spec.yml
```

## Minimal Workflow

### 1. Resolution

- Every `inputs[]` entry must declare `id_fields`.
- Blocking keys can be bare standardized columns or SQL expressions like `LEFT(standardized_company_name, 6)`.
- `record_id` is the canonical runtime identifier. Do not build downstream logic on `_source_entity_id`.

### 2. Review

- Pending queue: `bobsled entity-graph review list company --runner ./runner.js --json`
- Pair inspection: `bobsled entity-graph review show --entity company --pair-id <pair_id> --runner ./runner.js --json`
- Single decision: `bobsled entity-graph review decide --entity company --pair-id <pair_id> --decision merge --runner ./runner.js --json`

### 3. Survivorship

- Survivorship specs live beside resolution specs in the current spec directory (`entity-graph/` by default).
- Attribute rules choose the winning value per cluster and write `__golden_record`, `__golden_history`, and `__survivorship_audit`.

### 4. Truthsets

- Truthset CSVs require `pair_id,label` columns with labels in `{merge, not_match}`.
- `truthset score` reports current-threshold precision and recall characteristics.
- `truthset tune` recommends new thresholds from labeled scores. Treat those recommendations as inputs to a reviewed spec change, not an automatic rewrite.
