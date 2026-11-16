# Mention Extraction — Linking Unstructured Text to Resolved Entities

<!-- last-reviewed: 2026-05-13 -->

Mention extraction is the bridge between unstructured ingest (PDFs, transcripts, threads, knowledge-base pages) and the typed entity graph. It produces `__document_mentions` — one row per detected mention of an entity inside a document chunk, with a resolved `entity_id` when extraction is confident enough.

Mentions are what make `customer.documents()` a single typed call instead of a manual `JOIN` between full-text search results and CRM rows.

## Read This If

- You have documents flowing through `format: document` ingest and want them linked to resolved entities.
- You need to review or audit auto-resolved mentions before they propagate downstream.
- You're writing a custom dialect adapter or a programmatic batch job that calls the extraction runtime.

## Prerequisites

- Resolved entities materialized in `__entity_profile` (run `bobsled entity-graph resolve profile <entity...>` first — see the [Entity graph](../../guides/entity-graph.md)).
- Chunks materialized in `<resource>__chunks` from document ingest.
- A configured `mention_disambiguation_v1` model role with a per-call budget (see [Embeddings and AI providers](../../guides/embeddings-and-ai.md)).

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

Bobsled Core ships a common `CandidateRetrievalStrategy` interface with dialect-specific SQL builders:

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
bobsled entity-graph mentions inspect \
  --runner ./runner.js \
  --schema entity_graph \
  --chunk-id <chunk_id> \
  --include-chunk \
  --json
```

The command returns source URI, document and chunk IDs, chunk index, excerpt or full chunk text, mention spans, `resolution_method`, confidence, resolved profile IDs/names, and same-chunk relationship evidence when `__entity_relationship_evidence` is present. It also accepts `--mention-id`, `--entity-type`, `--resolution-method`, `--limit`, `--json`, and `--yaml`.

## Review Queue Export

```bash
bobsled entity-graph mentions review export \
  --runner ./runner.js \
  --schema entity_graph \
  --csv \
  > review/document_mentions.csv
```

The CSV header is **byte-for-byte parity** with `bobsled model review export`, with mention-specific columns appended:

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

Run `bobsled doctor --json` before and after a chunker config change to confirm.

## Operational Health Checks

`bobsled doctor` runs this check for this surface today:

| Check                          | What it verifies                                                |
| ------------------------------ | --------------------------------------------------------------- |
| `mcp_unfiltered_in_production` | `BOBSLED_CORE_MCP_ALLOW_UNFILTERED=1` is not set in production. |

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

- [Entity graph](../../guides/entity-graph.md) — full workflow context.
- [SDK Codegen](sdk-codegen.md) — query mentions back through `customer.documents()`.
- [MCP `read_source`](mcp-read-source.md) — agent-side reads of the underlying chunks.
- [Embeddings and AI providers](../../guides/embeddings-and-ai.md) — set `mention_disambiguation_v1` and its budget.
- [Entity Graph Authoring Guide](entity-graph-authoring-guide.md) — the resolve / cluster / profile loop.
