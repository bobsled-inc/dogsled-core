---
name: lineage
description: Inspect and reason about Bobsled Core lineage for Model Spec models and Entity Graph attributes. Use when changing source schemas, model columns, joins, filters, resolution inputs, survivorship rules, or when a PR needs lineage risk notes.
---

# Lineage

Use this skill to answer "what depends on this?" before changing data contracts.

## Quick Triage

1. Identify the change surface:
   - Model Spec model/source change: use `bobsled model lineage`.
   - Entity profile/survivorship change: use `bobsled entity-graph lineage`.
   - Both: run model lineage first, then entity graph lineage.
2. Prefer structured output for agent work: JSON for strict automation, YAML for human-reviewed agent notes.
3. Treat `isComplete=false` as a risk signal, not as a failure.

## Model Spec Model Lineage

Run these from the Bobsled Core project root:

```bash
bobsled model lineage --integration <handle> --json
bobsled model lineage --integration <handle> --column <model.column> --json
bobsled model lineage --integration <handle> --yaml
bobsled model lineage --integration <handle> --column <model.column> --yaml
```

Inspect:

- `integrations[].models[]` for model/source dependency shape
  - `name`, `refs`, `source_refs` — model identity and DAG edges
  - `trust_tier` — declared tier in the YAML spec
  - `effective_trust_tier` — actual tier after upstream downgrades; `null` when no override applies
  - `materialization` — view, table, incremental, etc.
- `integrations[].column_lineage[]` for output-column upstream refs
- `isComplete` for opaque expressions or reshape operations

In CI, non-TTY, or when `BOBSLED_CORE_OUTPUT_FORMAT=json` is set, JSON emits automatically without `--json`.

Lineage includes explicit expressions, `include_all_columns` passthrough when source schemas are known, join predicates for joined-table outputs, and filter predicates for all output columns.

## Entity Graph Lineage

Preview before writing:

```bash
bobsled entity-graph lineage compile --dry-run --json
```

Persist after pipeline/schema changes:

```bash
bobsled entity-graph lineage compile --runner ./runner.js --json
```

Query one attribute:

```bash
bobsled entity-graph lineage --entity <entity> --attribute <attribute> --runner ./runner.js --json
```

Inspect:

- `source_table` and `source_column` for upstream contract dependencies
- `transform_ref` and `transform_step` for standardization provenance
- `is_complete=false` rows for missing aliases or opaque transformations

## Change Safety Checklist

Before approving a data-contract change:

- [ ] Run model lineage for every changed model or column.
- [ ] Run entity graph lineage for every affected mastered attribute when entity graph specs exist.
- [ ] Confirm no removed/renamed column appears in an `isComplete=true` or `is_complete=true` row.
- [ ] Explain any new incomplete lineage rows in the PR.
- [ ] Add or update tests if lineage behavior changes.

Escalate as a blocking issue when a removed or renamed column appears in complete lineage for a downstream model or entity attribute.

## References

- `docs/reference/advanced/lineage-guide.md`
- `packages/model-spec/docs/lineage-quickstart.md`
- `docs/reference/advanced/entity-graph-lineage-guide.md`
