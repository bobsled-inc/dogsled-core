---
name: entity-resolution
description: Set up entity resolution / golden records — author an entity-graph
  resolution spec, run it on an entity-graph pipeline, then review and apply the
  borderline-pair decisions.
---

# Entity Resolution

Use this skill to configure, run, review, or operate Dogsled entity resolution.

## Workflow

1. Read the nearest package guide and inspect the existing implementation and tests.
2. Resolve the decisions below before editing.
3. Use the established schemas, interfaces, security helpers, and error contracts.
4. Implement the smallest compatible change with regression coverage.
5. Run the focused checks, then the repository gate.

## Decisions

- Confirm source grain, identifiers, standardization, blocking, scoring, and review thresholds.
- Choose full versus incremental operation and preserve review and inbox durability.
- Apply privacy controls to identifiers and keep write-capable access explicitly gated.

## Completion

- Validate and compile the resolution spec before execution.
- Exercise resolve, review, cluster, incremental-state, and privacy-sensitive behavior as applicable.
- Run Entity Graph package gates and the repository precommit gate.

## Detailed Reference

Load the full reference only when the task needs its schemas, command tables, examples,
or troubleshooting detail:

# Entity Resolution / Golden Records

Use this skill when the user wants to **resolve / dedupe / merge / match**
real-world entities across already-loaded tables — "build a customer (or
company) golden record", "deduplicate accounts across Salesforce + HubSpot",
"set up entity resolution / an entity graph".

Entity resolution in Dogsled is **two files authored together**:

1. a `type: resolution` **spec** per entity, at
   `entity-graph/<name>_resolution.yml`, that declares HOW to collapse
   duplicates; and
2. a `type: entity-graph` **pipeline** in `dogsled.yml` that RUNS that spec on
   a schedule and writes the outputs back to a warehouse connection.

A resolution spec does nothing on its own — the pipeline is what executes it.

> **Hard prerequisite — inputs must already be loaded.** Resolution reads
> existing warehouse tables; it does **not** extract. If the source tables
> aren't loaded, author and run the `type: extract` pipeline(s) first (or
> confirm the user already loaded them), then point the spec's `inputs` at
> those tables. A run against empty/missing tables produces no clusters.

## 1. The resolution spec — `entity-graph/<name>_resolution.yml`

Use the resolution schema and examples in `docs/reference/advanced/entity-graph-authoring-guide.md`,
then validate with `dogsled entity-graph resolve validate <name>`.
Do not hand-author the shape from memory. The file is **flat** under
`entity-graph/` (never nested) and its discriminant is `type: resolution`.

The spec is a deterministic standardize → block → score → threshold flow:

- **`inputs`** — the already-loaded warehouse tables to resolve across, each
  with its `id_fields` (the source primary key, used to build crosswalk
  lineage). Reference each as `connection.table`.
- **`standardize`** — per-field cleaning applied before matching (lowercase,
  trim, `normalize_email`, `strip_legal_suffixes`, …). **Load the
  `dogsled-model-spec-cleaning` skill** for the transform catalog — don't guess transform
  names; an unknown transform fails validation.
  For privacy-preserving match keys, use `normalize_email_uid2` before
  `hmac_sha256`, set `DOGSLED_MATCH_KEY_SECRET` in the runtime environment, and
  treat the hashed output as a terminal exact-match key only. `pre_hashed: true`
  is available when the source already supplies a digest.
- **`blocking`** — candidate-pair narrowing (only compare records that share
  a blocking key, e.g. `standardized_email`). Keeps the pairwise comparison
  tractable on large inputs. For address entities, prefer
  `normalize_street` + `normalize_postal` standardizers and block on
  `standardized_street` (or a street/postal expression when the warehouse
  profile supports it); use exact postal scoring to keep the block precise.
- **`scoring`** — how each pair's `composite_score` is produced. Two methods:
  `weighted_features` (a weighted average of fuzzy similarities — the simplest
  default) or `fellegi_sunter` (calibrated probabilistic match weights — see
  **Probabilistic scoring** below). Supported weighted comparators are `exact`,
  `jaro_winkler`, `edit_distance`, `soundex`, `numeric_distance`,
  `date_proximity`, and `token_cosine`; MySQL does not support
  `token_cosine`/`jaro_winkler`/`edit_distance` in v1.
  Use `dogsled entity-graph resolve validate --verbose` to show dialect notes
  for approximate Jaro-Winkler implementations and token-cosine support.
- **`thresholds`** — the `auto_merge` / `review` / `auto_reject` bands.
  Comparisons are **inclusive at the bottom of each band**: a pair
  auto-merges when `composite_score >= auto_merge` (so a deterministic rule
  with `confidence: 1.0` always merges even at `auto_merge: 1.0`); the
  review queue holds `review <= composite_score < auto_merge`.
  `agent_review` is accepted as an alias but must equal `review` when both
  are set.

  **To disable score-driven auto-merge entirely**, set `auto_merge: null` —
  then only `deterministic_rules` produce merges and every scored pair at or
  above `review` routes to the review queue. This is the preferred layout
  when the user wants agent/human review of all fuzzy matches:

  ```yaml
  deterministic_rules:
    - name: exact_email_and_name # exact evidence merges directly
      conditions:
        - { field: standardized_email, operator: exact, both_not_null: true }
        - { field: standardized_name, operator: exact, both_not_null: true }
      action: auto_merge
      confidence: 1.0
  thresholds:
    auto_merge: null # scoring never auto-merges
    review: 0.55
    auto_reject: 0.3
  ```

  Requires at least one deterministic rule (validation rejects `null`
  otherwise — nothing could ever merge). On engines without `null` support
  yet, the closest equivalent is `auto_merge: 0.99` with deterministic-rule
  confidences ≥ 0.99.

- **`deterministic_rules[].action`** — what happens when a rule's exact
  conditions all fire:
  - `auto_merge` — the pair merges directly; the rule's `confidence`
    becomes its `composite_score`.
  - `flag_for_review` — the pair routes to `<entity>__review_queue`
    **regardless of score band** (`threshold_band: deterministic_review`,
    `rule_name` populated) and never merges on its own, no matter how high
    `confidence` is — only an applied review decision merges it. This is
    the cautious default for strong-but-not-certain signals: same name but
    different domain, same phone but different address, same tax ID but
    different name. Prefer it over auto-merge + patched `not_match`
    decisions when false merges are costly (KYC, patient records), and
    over lowering `review` when the fuzzy scorer would dilute the signal.
    Flagged pairs are excluded from semantic-triage promotion and from
    embedding spend; the agent/human review flow adjudicates them like any
    other queued pair. If a pair matches both an `auto_merge` and a
    `flag_for_review` rule, it merges AND stays queued — an applied
    `not_match` decision then splits it on the next run.

  ```yaml
  deterministic_rules:
    - name: exact_domain_and_name # certain evidence merges directly
      conditions:
        - { field: standardized_domain, operator: exact, both_not_null: true }
        - { field: standardized_name, operator: exact, both_not_null: true }
      action: auto_merge
      confidence: 1.0
    - name: same_name_no_domain # strong signal — a human/agent confirms
      conditions:
        - { field: standardized_name, operator: exact, both_not_null: true }
      action: flag_for_review
      confidence: 0.85
  ```

**Start deterministic.** The resolution spec itself stays a deterministic
standardize → block → score → threshold flow — do **not** add `agent_policy` /
`semantic_triage` blocks to it; borderline pairs are reviewed **out-of-band
after the run** (see "Review the queue" below). LLM/embedding-driven
construction phases (mention + typed-relationship extraction) are supported,
but they're authored as **separate** `mention_extraction` /
`relationship_extraction` specs that run **after** resolution — not inside the
resolution spec. See **`entity-graph-construction`**.

> **After resolution:** to link unstructured documents to these resolved
> entities and extract typed relationships, see **`entity-graph-construction`**
> (it consumes the `__entity_profile` this skill materializes).

Illustrative shape:

```yaml
spec_version: '0.2'
type: resolution
name: customer_resolution
description: 'Resolve customers across CRM and ecommerce sources.'
inputs:
  - ref: warehouse.salesforce_accounts
    id_fields: [account_id]
  - ref: warehouse.shopify_customers
    id_fields: [customer_id]
standardize:
  - field: email
    transforms: [lowercase, trim, normalize_email]
blocking:
  rules:
    - name: by_email
      key: standardized_email
scoring:
  method: weighted_features
  features:
    - field: standardized_email
      algorithm: exact
      weight: 0.6
    - field: standardized_name
      algorithm: jaro_winkler
      weight: 0.3
    - field: standardized_name
      algorithm: token_cosine
      weight: 0.1
thresholds:
  auto_merge: 0.9
  review: 0.7
  auto_reject: 0.4
```

### Probabilistic scoring (Fellegi–Sunter)

`scoring.method: fellegi_sunter` is an alternative to `weighted_features` that
produces a **calibrated match probability** instead of a weighted-average
similarity. Each comparison declares ordered **levels** (most-strict first); the
first matching level contributes its **match weight** `log2(m / u)` in bits, the
weights sum with a prior, and a sigmoid turns the total into
`composite_score ∈ (0, 1)`.

**Which to choose.** Default to `weighted_features` — fewer parameters and fine
for most dedupe. Reach for `fellegi_sunter` when you need calibrated
probabilities you can threshold defensibly, your fields differ a lot in evidence
strength (an email agreement should outweigh a first-name agreement), or you can
train `m`/`u` estimates from a labeled truthset. Fellegi–Sunter assumes
comparison levels are conditionally independent given match status; correlated
fields (for example, email domain and company domain) should be modeled
sparingly or validated with holdout truthset metrics.

- **`prior`** — base rate of a true match among candidate pairs
  (`0 < prior < 1`), e.g. `0.0001`.
- **`m`** — P(this level fires | the pair IS a true match).
- **`u`** — P(this level fires | the pair is NOT a match).
- **levels** — ordered, most-strict-first, ending in a required `{ op: else }`
  catch-all. Threshold ops (`jaro_winkler`, `edit_distance`, `numeric_distance`,
  `date_proximity`, `token_cosine`) require a `gte`; `exact` / `soundex` /
  `else` must omit it.
  Same-op levels must use strictly-decreasing `gte`. Each `field` must be a
  `standardized_<field>` produced by `standardize` (or a declared source
  column) — a typo is rejected at compile time, not at warehouse run time.
  Every level needs `m` or `u` non-zero (a level can't set both to `0`), and a
  `field` may appear in at most one comparison (a repeated field would
  double-count its evidence).

Use `dogsled entity-graph truthset train --runner ./runner.mjs --entity company`
to learn `prior`, `m`, and `u` from labeled truthsets. The trainer estimates
`m` from labeled matches with Laplace smoothing, estimates `u` from random
cross-pairs in `__standardized` (not truthset non-match labels), derives the
prior from strict deterministic auto-merge anchors plus
`--deterministic-recall`, reports holdout precision/recall, and emits a
ready-to-paste `scoring.fellegi_sunter` block. Add `--apply` to patch the
resolution spec after reviewing the diagnostics. Because the score is a real
probability, choose thresholds on the probability scale — `auto_merge: 0.9`
means "≥ 90% posterior match probability".

```yaml
scoring:
  method: fellegi_sunter
  prior: 0.0001
  comparisons:
    - field: standardized_email
      levels:
        - { op: exact, m: 0.85, u: 0.0001 } # emails agree
        - { op: else, m: 0.05, u: 0.9989 } # emails disagree
    - field: standardized_name
      levels:
        - { op: exact, m: 0.70, u: 0.0005 }
        - { op: jaro_winkler, gte: 0.9, m: 0.20, u: 0.01 } # near-match
        - { op: token_cosine, gte: 0.8, m: 0.05, u: 0.02 } # token overlap
        - { op: else, m: 0.10, u: 0.9895 }
thresholds:
  auto_merge: 0.9
  review: 0.5
  auto_reject: 0.1
```

## 2. The entity-graph pipeline — `dogsled.yml`

Use the pipeline shape in `docs/reference/project-files.md` and validate with
`dogsled runner validate`.
A `type: entity-graph` pipeline needs:

- **`connection`** — the warehouse where the input tables live AND where the
  outputs land.
- **`schedule`** — a cron expression.
- **`entities`** — `'*'` (all resolution specs) or a list of entity names.
- **`phases`** — defaults to `[resolve, cluster]`.

It must **not** carry `extract`/`models` fields — pipeline arms don't mix.

## Flow

Author the spec(s) + the pipeline block, then:

1. Run `dogsled entity-graph resolve validate` to check the resolution specs.
2. Run `dogsled entity-graph resolve run` to score candidate pairs.
3. Run `dogsled entity-graph resolve cluster` to cluster the reviewed pairs.
4. Run `dogsled entity-graph resolve profile` to materialize entity profiles.

Each run writes these **query-ready** tables back to the pipeline's `connection`:

- `<entity>__golden` — the **wide, query-ready golden record**: one row per
  resolved entity with a named column per `profile.attributes` entry (default
  survivorship uses `inputs[]` precedence; a co-located `<entity>_survivorship.yml`
  can refine per-attribute rules), a `<source>_id` + `has_<source>` column per
  input, `cluster_size`, and `trust_score` / `trust_band`. Emitted automatically
  on every resolve+cluster run — no hand-authored model needed. Join this directly.
- `<entity>__clusters` — the golden entities (grouped duplicates).
- `<entity>__crosswalks` — source-record → cluster lineage.
- `<entity>__review_queue` — borderline pairs (score between `review` and
  `auto_merge`) plus any pairs flagged by a `flag_for_review` deterministic
  rule (`threshold_band: deterministic_review`, `rule_name` set), awaiting
  adjudication. Nothing acts on these until you do.

Backing `<entity>__golden`, but not something you query directly:

- `<entity>__golden_record` — the **internal** EAV (one row per entity ×
  attribute) that `<entity>__golden` is pivoted from; query `__golden` instead
  unless you specifically need the long form.

Each run also writes internal staging and diagnostic tables you normally don't
query directly — `__standardized`, `__candidate_pairs`, `__pair_scores`,
`__components`, `__resolve_state`, `__match_inbox`, the `__entity_id_*` history,
`__entity_quality`, and (only when a co-located `<entity>_survivorship.yml`
refines the rules) `__survivorship_audit`.

## Full vs incremental runs

Start with a normal full resolve run. It creates the per-entity tables, writes
`<entity>__resolve_state`, and records the spec fingerprint plus source
watermarks:

```bash
dogsled entity-graph resolve run company --runner ./runner.js --json
```

After that baseline exists, use `--incremental` for loaded-at delta runs:

```bash
dogsled entity-graph resolve run company --runner ./runner.js --incremental --json
dogsled entity-graph resolve estimate company --runner ./runner.js --incremental --yaml
```

Incremental mode requires a query-capable runner because Dogsled must read
`__resolve_state` and current source watermarks before compiling the delta SQL.
It falls back to a full rebuild when state is missing, a source lacks a usable
watermark, content fingerprints change, or the resolution spec fingerprint
changes. JSON/YAML results include `mode` and `mode_reason`; use those fields in
agent logs instead of inferring from the CLI flags.

`__match_inbox` is the durable ledger for API-ingested records from `match
--mode stage|assign` and the HTTP access plane. Full rebuilds recreate
`__standardized` from warehouse sources only, so the next incremental run drains
pending inbox rows and re-qualifies assigned/drained rows whose standardized
record disappeared during a full rebuild. Do not hand-insert API records into
`__standardized` or `__crosswalks`.

## Live access plane

Use the access-plane commands when an app or agent needs to read or submit a
single entity/record without running the full pipeline:

```bash
dogsled entity-graph get --entity company --id <entity_id> --runner ./runner.js --json
dogsled entity-graph match --entity company --input ./record.json --mode lookup --runner ./runner.js --json
dogsled entity-graph match --entity company --input ./record.json --mode stage --runner ./runner.js --json
dogsled entity-graph match --entity company --input ./record.json --mode assign --runner ./runner.js --json
```

`lookup` is read-only. `stage` writes the record to `__match_inbox` for a later
incremental drain. `assign` writes standardized/crosswalk/cluster rows
immediately when the deterministic match is safe, or queues review when the
matched rule says so. Match records must include the selected input's
`id_fields` as non-null scalar values; include `source_ref` or `_source_ref`
when the entity has multiple inputs and the fields are ambiguous. Invalid
`mode` values are validation errors — never rely on typos falling back to
lookup.

For local HTTP access:

```bash
dogsled entity-graph serve --port 8765 --runner ./runner.js --json
dogsled entity-graph serve --port 8765 --runner ./runner.js --allow-writes --json
```

The server binds to loopback by default and is read-only unless
`--allow-writes` is passed. Remote exposure is intentionally double-gated:
operators must both pass `--allow-remote` and set
`DOGSLED_ENTITY_GRAPH_ALLOW_REMOTE=1`, then put the unauthenticated API behind
trusted access controls. `assign` and `stage` over HTTP share the same
primary-key validation and inbox durability as the CLI.

Dogsled-maintained agents use the same bundled guidance: load `entity-resolution`
for the resolution/access-plane workflow and `dogsled-model-spec-cleaning` for standardization
transforms. The Dogsled MCP entity-graph tools
(`entity_search`, `entity_get`, `entity_match`, `entity_relationships`,
`entity_explain`) are read-only; use CLI/HTTP `match --mode stage|assign` only
when the task explicitly allows warehouse writes.

## Privacy controls

Use hashed match keys when identifiers should be compared without exposing raw
PII in the matching columns:

```yaml
standardize:
  - field: email
    transforms: [normalize_email_uid2, hmac_sha256]
blocking:
  rules:
    - name: by_email_key
      key: standardized_email
scoring:
  method: weighted_features
  features:
    - field: standardized_email
      algorithm: exact
      weight: 1
```

`hmac_sha256` reads `DOGSLED_MATCH_KEY_SECRET` from the process environment and
fails validation/compile closed when the secret is missing. Dogsled deliberately
uses one portable nested keyed SHA-256 construction on every warehouse; it is
not RFC-2104 HMAC and will not interoperate with externally-computed HMACs.
Both parties in a cross-warehouse join must use the same Dogsled transform and
secret. Plain `sha256` is also available, but unsalted hashes remain personal
data and are dictionary-enumerable; prefer keyed match hashes for identifiers.

Hashed fields may be used in blocking keys, exact deterministic rules, and
exact scoring features. Do not use them in fuzzy comparators, semantic triage,
or visible profile attributes unless the attribute is explicitly marked
`hashed: true`. Bloom-filter CLKs, PSI, clean-room matching, and provider-led
identity integrations are out of scope for Dogsled core.

Run `pii scan` to suggest source-column annotations and policy redaction fields:

```bash
dogsled entity-graph pii scan --entity customer --json
dogsled entity-graph pii scan --entity customer --apply --yaml
```

The default backend uses the configured `platform.models` role
`pii_detection`, with deterministic regex/checksum pre-pass for emails, phones,
SSNs, and card numbers. `--backend local --local-endpoint http://localhost:8734`
uses a sidecar detector contract for Privacy Filter or GLiNER-style classifiers.
Scan output is advisory; `--apply` writes reviewable Model Spec `pii: true` patches via
the edit API, and those flags feed policy redaction when the policy has no
explicit `redact_fields_for_agent_review` list.

Use `profile.pii_controls` to define masked golden read surfaces and governance
artifacts:

```yaml
profile:
  attributes:
    - { alias: email_key, field: standardized_email, hashed: true }
    - { alias: full_name, field: standardized_name }
  pii_controls:
    attributes:
      - { field: standardized_email, masking: hash, classification: identifier }
      - { field: standardized_name, masking: partial, classification: person_name }
```

`dogsled entity-graph resolve compile --governance -o build/entity-graph`
emits `<entity>__golden_masked` view SQL for all dialects, Snowflake tag/masking
DDL artifacts, and BigQuery/Databricks guidance manifests. The command only
generates governance artifacts; operators apply warehouse DDL with the
appropriate elevated role. When masking/classification touches mastered
attributes, run an entity-graph lineage check as part of review.

## Right to erasure

When the user needs to erase a source record from entity-graph outputs, use
`entity-graph forget` rather than editing output tables by hand:

```bash
dogsled entity-graph forget --entity company \
  --source-ref crm.accounts \
  --pk '{"account_id":"acct_123"}' \
  --reason "gdpr_erasure" \
  --json
```

The command writes a tombstone to `<entity>__forgotten_records`, purges or
redacts the record from derived entity-graph surfaces, emits PII-free erasure
audit events, and reruns cluster/profile repair so remaining records settle into
valid clusters. Future resolve runs anti-join the tombstone table during
standardization, so the record is not resurrected even if it still exists in the
upstream source table. Deleting or masking the upstream row remains the
customer's responsibility.

Use `--dry-run --json` or `--dry-run --yaml` to inspect the compiled statement
plan before executing. Use `--input requests.csv|json|yaml` for batches; each
request supplies the source ref and primary-key JSON.

For Snowflake schemas that hold entity-graph PII, tell operators to keep
`DATA_RETENTION_TIME_IN_DAYS <= 30`. After any warehouse restore or Time Travel
recovery, run `dogsled entity-graph forget --entity <name> --replay` to reapply
all existing tombstones. Crypto-shredding with per-subject keys is a future
erasure mode, not part of the current implementation.

## Review the queue (out-of-band adjudication)

When the user wants to review / clear the queue:

1. **Read it** — `query_connection` the pipeline's warehouse:
   `SELECT pair_id, record_a_id, record_b_id, composite_score, field_diffs
FROM <entity>__review_queue ORDER BY composite_score DESC`.
2. **Adjudicate each pair** — call `invoke_llm_call` once per row with a
   per-pair schema (`{ pair_id, decision: merge | not_match | defer,
confidence (0..1), reason }`), passing that pair's `field_diffs` + the
   **literal source values** in the prompt. Echo each `pair_id` back
   verbatim. Build the prompt from this template — the two framing blocks
   are what keep the adjudicator calibrated:

   ```text
   You are adjudicating whether two records refer to the same real-world
   entity.

   ENGINE BEHAVIOR — read before scoring:
   - composite_score renormalizes over non-null fields only. A pair can
     score high on name alone when every other field is null on one side.
   - field_scores.X: 0 does NOT mean field X mismatched — it usually means
     X was null on one side and contributed nothing. Judge from the
     literal values below, not from the numeric field scores.

   BASE RATE — in deduplication review queues, most same-name pairs ARE
   the same entity:
   - Exact-equal standardized names + one side mostly null → lean MERGE.
     Missing data is absence of evidence, not evidence of distinctness.
   - Choose NOT_MATCH only on affirmative evidence the records are
     distinct (conflicting domains/addresses, "Inc" vs unrelated "LLC"
     in different regions, different parent orgs, ...).
   - Choose DEFER only when there is ACTIVE evidence pointing both ways —
     not merely because data is missing.

   PAIR <pair_id>:
   field_diffs: <field_diffs JSON>
   record A (literal values): <row A>
   record B (literal values): <row B>

   Return { pair_id, decision: merge | not_match | defer,
   confidence (0..1), reason }.
   ```

3. **Propose, then apply** — summarize the counts for the user, then on
   confirmation call `request_apply_review_decisions(pipeline_name=...,
entity=..., decisions=[...])`. It's approval-gated: high-confidence
   merge/not_match calls are **applied**, low-confidence ones are saved as
   **proposed**, and `defer` calls are **deferred** — nothing is
   force-applied. The writeback records every decision in
   `<entity>__review_decisions` and refreshes `<entity>__not_match_edges`; a
   later resolve/cluster run folds the applied decisions into the clusters.

## Related skills

- **`entity-graph-construction`** — the next stage: link unstructured
  documents to the resolved `__entity_profile` and extract typed, evidence-cited
  relationships (mention + relationship extraction under an ontology).
- **`dogsled-model-spec-cleaning`** — the standardize / cleaning transform catalog used by
  the spec's `standardize` block.
- **`dogsled-model-spec`** — the broader data-model reference (sources, models,
  materializations) for the tables you resolve across.
