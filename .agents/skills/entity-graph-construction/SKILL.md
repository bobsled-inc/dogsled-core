---
name: entity-graph-construction
description: Build a managed entity graph from unstructured documents — author the relationship_ontology, mention_extraction, and relationship_extraction specs that link document chunks to resolved entities and extract typed, evidence-cited relationships under an ontology. Use when the user wants to extract entities or relationships from documents/text, build a knowledge graph from unstructured data, link documents to resolved entities, define a relationship ontology, do mention extraction, or produce cited graph edges — AFTER entity resolution has produced golden records.
exposed: true
triggers:
  - build an entity graph from documents
  - extract entities from text
  - extract relationships from documents
  - mention extraction
  - relationship ontology
  - typed relationships with evidence
  - link documents to entities
  - knowledge graph from unstructured data
  - entity graph construction
  - cited graph edges
---

# Entity Graph Construction (documents → mentions → typed relationships)

Use this skill when the user wants to turn **unstructured documents** into a
typed entity graph — "extract entities/relationships from these PDFs", "build a
knowledge graph", "link documents to my resolved customers", "define a
relationship ontology", "get cited edges between entities". It covers the three
construction spec kinds: **`relationship_ontology`**, **`mention_extraction`**,
and **`relationship_extraction`**.

> **Hard prerequisites — construction runs LAST, in strict order.** Each phase
> consumes the prior phase's materialized output:
>
> 1. **Documents chunked** — `<resource>__chunks` exist. Author this with
>    **`add-file-storage-source`** (parse + token-chunk + embed). Mention
>    candidate retrieval needs the chunk embeddings.
> 2. **Entities resolved** — `__entity_profile` materialized. Author + run this
>    with **`entity-resolution`** (`resolve → cluster → profile`). Mentions
>    resolve a surface form to an `entity_id` against this table.
> 3. **Mentions extracted** — `__document_mentions` (this skill). REQUIRES
>    `__entity_profile`.
> 4. **Relationships extracted** — `__entity_relationship_evidence` → review →
>    compact → public `__entity_relationship` (this skill). REQUIRES resolved
>    `__document_mentions` (pairs are built only from resolved same-chunk
>    mentions).
>
> Authoring or running a phase before its input exists produces zero rows.

Managed destinations use `type: bobsled_managed` and `bobsled_connection_ref` to
name a connection supplied by an orchestrator. Core validates these hooks but
cannot load into a managed destination. For local execution, configure a concrete
destination and run the work with `dogsled entity-graph build`.
See [Dogsled Cloud and Core](../../../docs/guides/dogsled-cloud.md).

## Shape

All construction specs are **flat** under `entity-graph/` (never nested),
alongside the resolution specs. Discriminant is the `type:` field.

```text
entity-graph/
  <entity>_resolution.yml          # from entity-resolution (prerequisite)
  relationship_ontology.yml        # type: relationship_ontology
  <Entity>_mention_extraction.yml  # type: mention_extraction
  <Entity>_relationship_extraction.yml  # type: relationship_extraction
bobsled.yml                          # platform.models roles + entity-graph pipeline
```

Use the inline examples below, which mirror the canonical
`examples/entity-resolution-sdk/entity_graph/` project. Core's strict schemas
reject unknown fields, so keep specs to the fields shown.

## Steps

1. Confirm prerequisites 1–2 above are done (`__chunks` + `__entity_profile`).
2. Author **`relationship_ontology.yml`** — the allowed vocabulary of typed
   edges (Step A).
3. Author one **`<Entity>_mention_extraction.yml`** per entity type to detect
   in text (Step B).
4. Author one **`<Entity>_relationship_extraction.yml`** (Step C).
5. Declare the **`platform.models`** roles the runtime calls (Step D).
6. Validate the specs, then run the construction phases (Step E).

### Step A — `relationship_ontology.yml`

One spec naming every relation the extractor may emit. `relations[]` fields:
`relation_type` (lower_snake_case, unique), `description`, `left_entity` /
`right_entity` (must be existing entity-graph entity types), `direction`
(`directed` | `symmetric`), `cardinality` (`one_to_one` | `one_to_many` |
`many_to_one` | `many_to_many`), `temporal` (`stateful` | `event` | `static`),
`review_thresholds` (`auto_confirm` / `review` / `auto_reject`), optional
`aliases` / `exclusive_with` (must be symmetric), and optional
`relationship_semantics` (`definition`, `positive_examples`,
`negative_examples`, `signal_phrases`) that calibrates the extractor.

```yaml
spec_version: '0.2'
type: relationship_ontology
name: default_relationships
relations:
  - relation_type: customer_has_deal
    description: A customer owns or is commercially associated with a deal.
    left_entity: Customer
    right_entity: Deal
    direction: directed
    cardinality: one_to_many
    aliases: []
    exclusive_with: []
    temporal: stateful
    review_thresholds:
      auto_confirm: 0.92
      review: 0.55
      auto_reject: 0.3
    relationship_semantics:
      definition: A customer owns, sponsors, or is commercially associated with a deal.
      positive_examples:
        - 'Acme owns the Project Atlas renewal.'
      negative_examples:
        - "Project Atlas uses Acme's API."
      signal_phrases: [owns, associated with, renewed, signed]
```

### Step B — `<Entity>_mention_extraction.yml`

Detects mentions of `entity_types` in chunks and resolves each to an
`entity_id`. `candidate_retrieval.strategy` is `profile_exact` | `profile_fts`
| `profile_vector` | `hybrid` (default), with `k` (top-K candidates) and
`min_similarity`. Optional `surface_filters` (`stopwords`, `exclude_regex`,
`min_chars`, `max_words`) cut noise. `extraction_role` names the
`platform.models` role for disambiguation. `ontology_ref` ties it to the
ontology.

```yaml
spec_version: '0.2'
type: mention_extraction
name: Customer_mentions
entity_types: [Customer]
ontology_ref: default_relationships
candidate_retrieval:
  strategy: hybrid
  k: 10
  min_similarity: 0.55
extraction_role: mention_disambiguation_v1
```

### Step C — `<Entity>_relationship_extraction.yml`

Builds candidate pairs from resolved same-chunk mentions and asks the model for
ontology-valid edges. `chunk_filter.has_resolved_mentions_min` gates which
chunks are processed (default 2). `candidate_pair_rules` caps pairs
(`max_pairs_per_chunk`, `same_chunk_only`, `max_pair_span_distance_chars`).
`extraction` sets the `role`, `prompt_version`, `constrained_decoding` (keep
`true` — the model may not invent IDs/predicates), and `require_span_evidence`
(keep `true` — every edge must cite an exact chunk span).
`review.use_ontology_thresholds: true` applies the ontology's per-relation
`review_thresholds`.

```yaml
spec_version: '0.2'
type: relationship_extraction
name: Customer_relationships
ontology_ref: default_relationships
chunk_filter:
  has_resolved_mentions_min: 2
candidate_pair_rules:
  max_pairs_per_chunk: 8
  same_chunk_only: true
extraction:
  role: relationship_extraction_v1
  prompt_version: v1
  constrained_decoding: true
  require_span_evidence: true
review:
  use_ontology_thresholds: true
```

### Step D — `platform.models` roles (`bobsled.yml`)

The two roles named by `extraction_role` / `extraction.role` must exist under
`platform.models`. Keep a `platform.budget` cap so a runaway run can't burn the
account.

```yaml
platform:
  models:
    mention_disambiguation_v1:
      provider: openrouter
      model: moonshotai/kimi-k2
      api_key: $OPENROUTER_API_KEY
    relationship_extraction_v1:
      provider: openrouter
      model: moonshotai/kimi-k2
      api_key: $OPENROUTER_API_KEY
  budget:
    ai_cost_daily_usd: 5
    per_source_rpm: 60
```

Roles are swappable (`provider: anthropic` / `openai` / `bedrock`) with no spec
changes — `moonshotai/kimi-k2` via OpenRouter is the documented default for
extraction. Secrets are env-var indirection (`$OPENROUTER_API_KEY`), never raw.

On Dogsled-managed connections the chunk/embedding feed and warehouse are
supplied by the platform; author the specs as above and the platform wires the
runner — no local credentials needed.

### Step E — Validate → run the construction phases

`validate` resolves refs + runs the strict schema. After commit + deploy, run
the phases in order (CLI shown; on the managed agent these map to the
entity-graph run surface — mentions before relationships):

```bash
dogsled entity-graph mentions extract Customer --schema entity_graph        # → __document_mentions
dogsled entity-graph relationships extract Customer --schema entity_graph   # → __entity_relationship_evidence (append-only)
dogsled entity-graph relationships review export --schema entity_graph --yaml
dogsled entity-graph relationships review apply ./review/decisions.yml      # confirm/reject/supersede
dogsled entity-graph relationships compact --schema entity_graph            # rebuild public __entity_relationship
```

`mentions extract` writes `__document_mentions` (one row per detected mention,
with `resolved_entity_id` + `resolution_method`/confidence). `relationships
extract` appends evidence to `__entity_relationship_evidence`; review decisions
land in `__entity_relationship_decisions`; `compact` rebuilds the public
current-state `__entity_relationship` table (log-odds aggregation over accepted
evidence). Read public edges from `__entity_relationship`, never the internal
`__entity_relationship_edge` staging surface.

## Deep runtime detail (transcluded)

{{include: docs/reference/advanced/mention-extraction.md}}

{{include: docs/reference/advanced/relationship-extraction.md}}

## Quality checklist

- Prerequisites met: `<resource>__chunks` exist (with embeddings) and
  `__entity_profile` is materialized **before** running construction.
- Every spec is `spec_version: '0.2'`, flat under `entity-graph/`, with the
  right `type:` discriminant.
- `relationship_ontology`: each `relation_type` is unique lower_snake_case;
  `left_entity`/`right_entity` are real entity-graph entity types;
  `exclusive_with` is symmetric.
- `mention_extraction`: `ontology_ref` matches the ontology `name`;
  `extraction_role` matches a `platform.models` role.
- `relationship_extraction`: `ontology_ref` matches; `extraction.role` matches a
  `platform.models` role; `constrained_decoding` and `require_span_evidence`
  stay `true`.
- `platform.models` declares both roles; `platform.budget` caps cost/RPM.
- Run order is mentions → relationships → review → compact; consumers read
  public `__entity_relationship` / `__document_mentions`.

## Related skills

- **`add-file-storage-source`** — upstream: parse, token-chunk, and embed
  documents into `<resource>__chunks`, the input for mention extraction.
- **`entity-resolution`** — upstream: resolve entities into `__entity_profile`,
  the table mentions resolve against. Construction runs only after this.
- **`dogsled-model-spec`** — the broader data-model reference for the tables involved.
