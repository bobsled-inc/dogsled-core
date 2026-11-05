---
name: entity-graph-construction
description: Build a managed entity graph from unstructured documents — author
  the relationship_ontology, mention_extraction, and relationship_extraction
  specs that link document chunks to resolved entities and extract typed,
  evidence-cited relationships under an ontology. Use when the user wants to
  extract entities or relationships from documents/text, build a knowledge graph
  from unstructured data, link documents to resolved entities, define a
  relationship ontology, do mention extraction, or produce cited graph edges —
  AFTER entity resolution has produced golden records.
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

Managed destinations use `type: dogsled_managed` and `dogsled_connection_ref` to
name a connection supplied by an orchestrator. Core validates these hooks but
cannot load into a managed destination. For local execution, configure a concrete
destination and run the work with `dogsled entity-graph build`.
See [Dogsled Cloud and Core](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/guides/dogsled-cloud.md).

## Shape

All construction specs are **flat** under `entity-graph/` (never nested),
alongside the resolution specs. Discriminant is the `type:` field.

```text
entity-graph/
  <entity>_resolution.yml          # from entity-resolution (prerequisite)
  relationship_ontology.yml        # type: relationship_ontology
  <Entity>_mention_extraction.yml  # type: mention_extraction
  <Entity>_relationship_extraction.yml  # type: relationship_extraction
dogsled.yml                          # platform.models roles + entity-graph pipeline
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

### Step D — `platform.models` roles (`dogsled.yml`)

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

# Mention Extraction — Linking Unstructured Text to Resolved Entities

<!-- last-reviewed: 2026-05-13 -->

Mention extraction is the bridge between unstructured ingest (PDFs, transcripts, threads, knowledge-base pages) and the typed entity graph. It produces `__document_mentions` — one row per detected mention of an entity inside a document chunk, with a resolved `entity_id` when extraction is confident enough.

Mentions are what make `customer.documents()` a single typed call instead of a manual `JOIN` between full-text search results and CRM rows.

## Read This If

- You have documents flowing through `format: document` ingest and want them linked to resolved entities.
- You need to review or audit auto-resolved mentions before they propagate downstream.
- You're writing a custom dialect adapter or a programmatic batch job that calls the extraction runtime.

## Prerequisites

- Resolved entities materialized in `__entity_profile` (run `dogsled entity-graph resolve profile <entity...>` first — see the [Entity graph](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/guides/entity-graph.md)).
- Chunks materialized in `<resource>__chunks` from document ingest.
- A configured `mention_disambiguation_v1` model role with a per-call budget (see [Embeddings and AI providers](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/guides/embeddings-and-ai.md)).

## Two-Stage Pipeline

```text
<resource>__chunks
   │
   ▼
[ Stage 1 — Candidate Lookup ]
   per-dialect similarity over __entity_profile
   (DuckDB jaro_winkler, Postgres pg_trgm,
    Snowflake JAROWINKLER_SIMILARITY,
    BigQuery shingled ML.NGRAMS join)
   │
   ▼ top-K candidates per surface form
   │
   ▼
[ Stage 2 — Resolve ]
   sim > 0.95  → exact_match (auto-link, no LLM call)
   else        → LLM disambiguation (constrained generation)
   else        → compromise NER fallback (no LLM, deterministic)
   │
   ▼
__document_mentions
   │
   ▼
__entity_relationship (Document --mentions--> Entity)
review queue + decision journal
```

The pipeline is **fail-soft** at every stage. A missing LLM provider, exhausted cost cap, or schema violation routes the row to the agent/eval queue instead of crashing the run. Rows that should not auto-link land in the review queue with `notes.review_route`.

## Confidence Bands

| Band              | `resolution_method`  | Behavior                                                                           |
| ----------------- | -------------------- | ---------------------------------------------------------------------------------- |
| > 0.95            | `exact_match`        | Auto-link. No LLM call.                                                            |
| 0.85 – 0.95       | `llm_disambiguation` | Linked with `notes.review_route: agent_applied`.                                   |
| 0.55 – 0.85       | `llm_disambiguation` | Linked with `notes.review_route: agent_review` for agent/eval follow-up.           |
| < 0.55            | `unresolved`         | Not linked. Surfaced in the review queue.                                          |
| (LLM unavailable) | `compromise_ner`     | Deterministic NER fallback. `resolved_entity_id` NULL unless candidate sim > 0.95. |
| (LLM bad output)  | `schema_violation`   | Unresolved. Prompt + validator notes preserved in `notes` for audit.               |

These are extraction thresholds. Review export labels are separate and mirror the review envelope: `auto_merge` at `confidence >= 0.92`, `agent_applied` at `confidence >= 0.75`, `agent_review` at `confidence >= 0.55`, and `unresolved` below that. Keep those two threshold sets distinct when debugging a row.

## The `mention_id` Primary Key

```text
mention_id = sha256(JSON.stringify([chunk_id, entity_type, entity_name, span_start, span_end]))
```

Computed in TypeScript at extract time (no dialect SHA support required). `span_end` is in the key — overlapping mentions of the same surface form, sharing a start offset, would otherwise collide.

The canonical JSON array encoding is length-prefixed at the serializer level, so a literal `::` separator embedded in `chunk_id` or `entity_name` cannot create cross-row collisions.

## Programmatic Runtime

`extractChunk` is the public entrypoint. Use it from background-task handlers, batch jobs, and test fixtures.

```ts
import { createCompromiseFallback, extractChunk } from '@bobsled-inc/entity-graph/runtime/mention';
import { DuckDbCandidateRetrieval } from '@bobsled-inc/entity-graph/runtime/candidate-retrieval';

const lookupOptions = {
  query: (sql, params) => duckdb.query(sql, params),
  profileTable: 'entity_graph.__entity_profile',
};
const strategy = new DuckDbCandidateRetrieval(lookupOptions);

const rows = await extractChunk(
  {
    chunk_id: 'chunk_01',
    chunk_text: 'Acme asked about renewal timing on Monday.',
    document_id: 'doc_01',
    document_version_id: 'doc_01_v1',
  },
  {
    strategy,
    fallback: createCompromiseFallback(),
    extractionRole: 'mention_disambiguation_v1',
    mode: 'primary', // 'primary' | 'fallback'
    llmCall: callMentionDisambiguationModel,
  }
);
```

Use `mode: 'fallback'` (or pass `--fallback compromise` at the CLI) when Bedrock / OpenRouter / your provider is unavailable, your cost cap is exhausted, or you want a deterministic local run. Fallback rows still preserve spans and route to review.

The function returns an array of `MentionRow`s ready to insert into `__document_mentions`.

## Candidate Lookup Strategies

Dogsled ships a common `CandidateRetrievalStrategy` interface with dialect-specific SQL builders:

| Dialect   | Strategy                                                                                    |
| --------- | ------------------------------------------------------------------------------------------- |
| DuckDB    | `jaro_winkler` executor — the canonical parity baseline.                                    |
| Postgres  | `pg_trgm` `%` operator with `set_limit()` pushed into the CTE; runner via `pg` pool.        |
| Snowflake | `JAROWINKLER_SIMILARITY` normalized to 0–1; runner via the official driver.                 |
| BigQuery  | Shingled `ML.NGRAMS` join (no Jaro-Winkler in BQ SQL); runner via `@google-cloud/bigquery`. |

The parity helper `topKEquivalent` compares top-K IDs across dialect-specific builders with a similarity drift tolerance `1e-3`. DuckDB, Postgres, Snowflake, and BigQuery retrieval runner adapters are wired through the common runner interface.

If you write your own dialect adapter, implement `buildCandidateSelect(input)` returning a parameterized SQL string + binds, then plug it into your caller-provided execution layer.

## Prompt Safety

Chunk text is **untrusted input**. The prompt builder treats it as such:

- Trusted instructions appear both **before** and **after** the untrusted block.
- The untrusted block is wrapped in XML-style tags.
- Literal `</chunk>`, `<system>`, and `<instructions>` substrings in chunk text are neutralized before substitution.
- The candidate set is XML-attribute-escaped — `entity_id` and `canonical_name` are not `JSON.stringify`'d into the prompt.
- The LLM response is post-validated: `resolved_entity_id` **must** be in the candidate set. Out-of-set responses are rejected and the row is marked `unresolved`.
- Unicode homograph candidates (NFKC + `unicode-confusables`) are detected and fail closed — the row gets `notes.injection_marker: 'unicode_homograph'` and is not auto-linked.

Three marker types land in `__document_mentions.notes`:

| Marker                 | Trigger                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `instruction_override` | Chunk text contained instruction-override patterns. LLM still ran on neutralized input; mention only persists if the validator approves.   |
| `unicode_homograph`    | Surface form matches a planted profile via NFKC + confusable-character check. Row is `unresolved` unless the operator explicitly resolves. |
| `literal_tag_strip`    | Chunk text contained literal `</chunk>` / `<system>` / `<instructions>`. Stripped before substitution.                                     |

A 27-test regression suite exercises every marker path on each run; see `packages/entity-graph/tests/unit/mention-extract.test.ts`.

## Constrained Generation

The LLM call is **constrained**, not free-form. The disambiguator's allowed output is:

- One `entity_id` value from the candidate set, **or**
- The literal token sequence for "unresolved".

This is enforced two ways:

1. The LLM provider's structured-output / tool-use mode is used when available (`generateStructured` in `@bobsled-inc/ai`).
2. Post-hoc validation rejects any response whose `resolved_entity_id` is not in the candidate set, regardless of provider quirks.

Confidence must be a finite number in `[0, 1]`. Anything else is rejected as `schema_violation`.

## Per-Source Rate Limits

`PerSourceRateLimiter` is a token bucket keyed on integration handle. Default is 60 requests per minute; configurable via `platform.budget.per_source_rpm`. Negative or non-integer request counts are rejected with a typed error rather than silently masking as zero.

The limiter sits in front of the LLM call. Pair it with the `mode: 'fallback'` path in `extractChunk` (or `--fallback compromise` at the CLI) when you want the pipeline to keep producing rows under sustained pressure rather than blocking on the rate limit.

## Chunk And Mention Inspection

Use `mentions inspect` when a count, review export row, or demo story row needs a source-level explanation:

```bash
dogsled entity-graph mentions inspect \
  --runner ./runner.js \
  --schema entity_graph \
  --chunk-id <chunk_id> \
  --include-chunk \
  --json
```

The command returns source URI, document and chunk IDs, chunk index, excerpt or full chunk text, mention spans, `resolution_method`, confidence, resolved profile IDs/names, and same-chunk relationship evidence when `__entity_relationship_evidence` is present. It also accepts `--mention-id`, `--entity-type`, `--resolution-method`, `--limit`, `--json`, and `--yaml`.

## Review Queue Export

```bash
dogsled entity-graph mentions review export \
  --runner ./runner.js \
  --schema entity_graph \
  --csv \
  > review/document_mentions.csv
```

The CSV header is **byte-for-byte parity** with `dogsled model review export`, with mention-specific columns appended:

```csv
review_id,decision,confidence,mention_id,chunk_id,document_id,entity_type,entity_name,resolved_entity_id,resolution_method,notes
```

| Flag                | Use                                                                            |
| ------------------- | ------------------------------------------------------------------------------ |
| `--csv`             | Default for spreadsheet review.                                                |
| `--json` / `--yaml` | Agent-consumable. Auto-selected in CI / non-TTY.                               |
| `--all`             | Include auto-merges (≥ 0.92) as well as review-only rows.                      |
| `--limit <n>`       | Cap row count.                                                                 |
| `--table <fqn>`     | Use a non-default mentions table (default `entity_graph.__document_mentions`). |
| `--schema <name>`   | Schema prefix when `--table` is not supplied.                                  |

Default decision filter (no `--all`):

```sql
WHERE superseded_at IS NULL
  AND (
       resolved_entity_id IS NULL
    OR COALESCE(resolution_confidence, confidence, 0) < 0.92
    OR resolution_method IN ('compromise_ner', 'schema_violation', 'unresolved')
  )
```

That mirrors the model-review surface: rows that need attention.

## Chunker-Config Migrations

Chunker configuration is part of the chunk identity (`chunkerConfigHash` + `CHUNKER_VERSION`). When config drifts:

1. New chunks have new `chunk_id`s.
2. Existing mentions are orphaned (their `chunk_id` no longer exists).
3. A follow-up worker or batch job marks orphans `superseded_at = now()` via parameterized SQL with identifier validation.
4. Re-extraction lands on the new chunks once the cache-substrate manifest read paths complete.

Run `dogsled doctor --json` before and after a chunker config change to confirm.

## Operational Health Checks

`dogsled doctor` runs this check for this surface today:

| Check                          | What it verifies                                           |
| ------------------------------ | ---------------------------------------------------------- |
| `mcp_unfiltered_in_production` | `DOGSLED_MCP_ALLOW_UNFILTERED=1` is not set in production. |

Structured output includes the check names above. User-facing docs and runbooks should describe those names directly rather than relying on internal runner prefixes.

## A Worked Example

```text
chunk text: "We followed up with Acme Corp this week. Their CFO Sarah Lin
            asked about renewal pricing for the Q3 contract."

Stage 1 retrieves:
  entity_id=company_001 canonical_name="Acme Corp" observed_aliases=["Acme Corp", "Acme Incorporated"]
  entity_id=person_042 canonical_name="Sarah Lin" observed_aliases=["Sarah Lin", "S. Lin"]

Stage 2:
  Acme Corp → exact_match @ 0.98 → resolved_entity_id=customer_42
  Sarah Lin → llm_disambiguation @ 0.87 → resolved_entity_id=person_117
              notes={review_route: agent_applied}

Outputs:
  __document_mentions rows for both surface forms
  __entity_relationship: Document(doc_01) --mentions--> Customer(customer_42)
                              Document(doc_01) --mentions--> Person(person_117)
  __document_mentions__quality: aggregated quality view per resolved entity
```

## See Also

- [Entity graph](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/guides/entity-graph.md) — full workflow context.
- [SDK Codegen](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/reference/advanced/sdk-codegen.md) — query mentions back through `customer.documents()`.
- [MCP `read_source`](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/reference/advanced/mcp-read-source.md) — agent-side reads of the underlying chunks.
- [Embeddings and AI providers](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/guides/embeddings-and-ai.md) — set `mention_disambiguation_v1` and its budget.
- [Entity Graph Authoring Guide](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/reference/advanced/entity-graph-authoring-guide.md) — the resolve / cluster / profile loop.

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

Extraction is pair-first. Dogsled only asks the model about candidate pairs built from already-resolved mentions in a chunk:

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
dogsled entity-graph relationships review export \
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
dogsled entity-graph relationships review apply ./review/relationship_decisions.yml \
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
dogsled entity-graph relationships compact \
  --runner ./runner.js \
  --schema entity_graph \
  --json
```

Use dry-run mode to inspect generated SQL before mutating warehouse state:

```bash
dogsled entity-graph relationships compact \
  --schema entity_graph \
  --dry-run \
  --json
```

Compaction performs log-odds aggregation over accepted evidence, applies review decisions, caps per-source diversity, preserves conflicts with `rank='conflicted'`, and writes public `__entity_relationship`.

## See Also

- [Entity graph](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/guides/entity-graph.md) — public contracts and end-to-end flow.
- [Mention Extraction](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/reference/advanced/mention-extraction.md) — the `__document_mentions` rows used as relationship inputs.
- [SDK Codegen](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/reference/advanced/sdk-codegen.md) — typed relationship traversal through generated clients.

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
