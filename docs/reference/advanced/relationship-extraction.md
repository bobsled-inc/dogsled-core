# Relationship Extraction — Document Evidence to Public Entity Edges

<!-- last-reviewed: 2026-05-13 -->

Relationship extraction turns resolved document mentions into ontology-validated graph evidence. It is intentionally append-only until the final compaction step: extraction writes evidence, review writes decisions, and compaction rebuilds the public current-state `__entity_relationship` table.

Use this guide when you need document-derived predicates such as `competes_with`, `partners_with`, `works_with`, or `mentioned_in_contract` between already-resolved entities.

## Shipped Flow

```text
__document_mentions
  → candidate pairs from mentions in the same chunk
  → ontology-constrained LLM extraction
  → append-only __entity_relationship_evidence
  → relationships review export/apply
  → append-only __entity_relationship_decisions
  → relationships compact
  → public __entity_relationship
```

`__entity_relationship_edge` is an internal staging surface used by relationship/profile compilation. App code, BI, generated SDK executors, and MCP readers should use public `__entity_relationship`.

## Specs

Define the allowed vocabulary with `type: relationship_ontology`, then opt chunks into extraction with `type: relationship_extraction`.

```yaml
spec_version: '0.2'
type: relationship_ontology
name: default
ontology_version: v1
relations:
  - relation_type: competes_with
    description: Two customers sell into the same market.
    left_entity: customer
    right_entity: customer
    direction: symmetric
    cardinality: many_to_many
    exclusive_with: [partners_with]
    temporal: stateful
    review_thresholds:
      auto_confirm: 0.92
      review: 0.55
      auto_reject: 0.30
```

```yaml
spec_version: '0.2'
type: relationship_extraction
name: business_relations
ontology_ref: default
extraction:
  role: relationship_extraction_v1
  prompt_version: v1
```

Rules:

- `relation_type` values are lower_snake_case predicates from the ontology.
- `exclusive_with` should be symmetric. If `competes_with` excludes `partners_with`, the inverse relation should exclude `competes_with`.
- Ontology endpoint types must exist as entity graph entity types before extraction runs.
- `relationship_extraction.ontology_ref` must point at a known ontology spec.

## Candidate-Pair Discipline

Extraction is pair-first. Bobsled Core only asks the model about candidate pairs built from already-resolved mentions in a chunk:

- unresolved mentions are excluded;
- self-relations are rejected;
- allowed relation types come from the ontology;
- candidate entity IDs are enumerated in the prompt;
- the model is not allowed to invent IDs, endpoints, or predicates.

The same untrusted-chunk defenses used by mention extraction apply here: chunk text is neutralized before prompt insertion, candidate IDs are escaped, and the response is post-validated before any evidence row is inserted.

## Evidence and Review Tables

| Table                             | Contract    | Purpose                                                                                                     |
| --------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `__entity_relationship_evidence`  | Append-only | Raw accepted evidence from LLM extraction, profile joins, mention links, truthsets, or review-derived rows. |
| `__entity_relationship_decisions` | Append-only | Human or agent decisions: `confirm`, `reject`, `supersede`, `conflicted`.                                   |
| `__entity_relationship`           | Rebuilt     | Public current-state relationship table after compaction.                                                   |
| `__entity_relationship_edge`      | Internal    | Compiler staging surface; do not treat it as a public contract.                                             |

Evidence rows carry `relation_type`, endpoint IDs, `evidence_kind`, source document/chunk IDs, span offsets, exact evidence excerpt, confidence, ontology version, model metadata, review flag, and timestamps.

## Validation and Rejection Reasons

The runtime rejects model output before persistence when any invariant fails:

| Reason                      | What failed                                                                  |
| --------------------------- | ---------------------------------------------------------------------------- |
| `missing_extractions_array` | Response did not contain `extractions: []`.                                  |
| `schema_violation`          | A row is missing required fields or wrong types.                             |
| `invalid_confidence`        | Confidence is not finite or outside `[0, 1]`.                                |
| `self_relationship`         | Left and right entity IDs are identical.                                     |
| `candidate_pair_mismatch`   | Endpoint pair or `relation_type` was not in the allowed candidate set.       |
| `invalid_span`              | Span offsets are non-integer, inverted, or outside the chunk.                |
| `evidence_excerpt_mismatch` | The excerpt does not exactly match `chunk_text.slice(span_start, span_end)`. |

Rejected rows are audit material; they should not be patched into the evidence table manually.

## Review and Compaction

Export review rows:

```bash
bobsled entity-graph relationships review export \
  --runner ./runner.js \
  --schema entity_graph \
  --yaml
```

The export classifies evidence into review labels with fallback thresholds:

| Label           | Default threshold      |
| --------------- | ---------------------- |
| `auto_merge`    | `confidence >= 0.92`   |
| `agent_applied` | `confidence >= 0.75`   |
| `agent_review`  | `confidence >= 0.55`   |
| `unresolved`    | below review threshold |

The persisted `review_flag` from extraction wins when present; numeric thresholds are fallback classification for older or manually loaded rows.

Apply reviewed decisions:

```bash
bobsled entity-graph relationships review apply ./review/relationship_decisions.yml \
  --runner ./runner.js \
  --json
```

Decision files are YAML or JSON arrays, or `{ rows: [...] }`:

```yaml
rows:
  - relationship_id: customer_42:competes_with:customer_77
    evidence_id: ev_001
    decision: confirm
    decided_by: human:ops
    rationale: Same market and explicit wording in contract addendum.
```

Rebuild the public table:

```bash
bobsled entity-graph relationships compact \
  --runner ./runner.js \
  --schema entity_graph \
  --json
```

Use dry-run mode to inspect generated SQL before mutating warehouse state:

```bash
bobsled entity-graph relationships compact \
  --schema entity_graph \
  --dry-run \
  --json
```

Compaction performs log-odds aggregation over accepted evidence, applies review decisions, caps per-source diversity, preserves conflicts with `rank='conflicted'`, and writes public `__entity_relationship`.

## See Also

- [Entity graph](../../guides/entity-graph.md) — public contracts and end-to-end flow.
- [Mention Extraction](mention-extraction.md) — the `__document_mentions` rows used as relationship inputs.
- [SDK Codegen](sdk-codegen.md) — typed relationship traversal through generated clients.
