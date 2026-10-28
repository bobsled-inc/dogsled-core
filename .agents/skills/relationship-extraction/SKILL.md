---
name: relationship-extraction
description: Configure, validate, review, and compact document-derived entity relationships.
---

# Relationship Extraction

Use this skill when work involves `relationship_ontology`, `relationship_extraction`, `__entity_relationship_evidence`, `__entity_relationship_decisions`, or the public `__entity_relationship` table.

## Checklist

1. Confirm entity profiles and `__document_mentions` are fresh.
1. Add or update `relationship_ontology` specs with lower_snake_case `relation_type` values and symmetric `exclusive_with` rules.
1. Add `relationship_extraction` specs that reference the ontology by `ontology_ref`.
1. Validate ontology endpoints against declared entity types.
1. Run relationship extraction:

```bash
dogsled entity-graph relationships extract --runner ./runner.js --schema entity_graph --yaml
```

1. Export review rows:

```bash
dogsled entity-graph relationships review export --runner ./runner.js --schema entity_graph --yaml
```

1. Apply reviewed decisions and re-compact:

```bash
dogsled entity-graph relationships review apply relationship_decisions.yml --runner ./runner.js
dogsled entity-graph relationships compact --runner ./runner.js
```

## Rules

- Do not allow free-form relation names. They must come from `relationship_ontology`.
- Do not persist LLM evidence unless `evidence_excerpt` exactly matches the chunk span.
- Rejected rows should stay rejected when validation reports `candidate_pair_mismatch`, `self_relationship`, `invalid_span`, `invalid_confidence`, or `evidence_excerpt_mismatch`; fix the source spec or prompt rather than patching evidence by hand.
- Keep evidence append-only; use `__entity_relationship_decisions` for review state.
- Query consumers should traverse `__entity_relationship`; treat `__entity_relationship_edge` as internal staging.
