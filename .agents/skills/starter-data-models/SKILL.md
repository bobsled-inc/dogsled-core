---
name: starter-data-models
description: Overview of Dogsled's curated starter data models — the canonical three-layer Model Spec bundles (bronze source, silver staging, gold mart) shipped for 23 popular integrations. Explains the suggested shape, the mechanical source+staging recipe, naming conventions, and how to adapt the gold marts to a user's actually-loaded tables. Entry point that routes to the per-integration starter-models-<integration> skills.
exposed: true
triggers:
  - starter data models
  - suggested data models
  - prebuilt models for my source
  - curated models for this integration
  - build the standard analytics models
  - starter marts
  - what models should i build
  - recommended models after loading
  - canonical analytics shape
  - bootstrap models for stripe / hubspot / salesforce / langsmith
---

# Starter data models

Dogsled ships a curated set of **starter data models** — pre-built Dogsled
Model Spec (Model Spec) bundles that turn a freshly loaded integration into an
analytics-ready warehouse with no modeling from scratch. Bundles can include
named metrics and declared relationships alongside their models. They exist for
23 popular sources (Stripe, HubSpot, Salesforce, Linear, GitHub, LangSmith, Vercel, …; full
list below).

Each bundle is the **canonical analytics shape** for that source: the
tables an experienced analyst would build on top of the raw extract.
Use them as the _suggested shape_ you propose and adapt — **not** a
mechanical file-copy. The user's real loaded tables will differ (a
subset of resources, extra or missing columns, a different raw schema
name), so every bundle gets fitted to what's actually in their
warehouse.

## When to offer this

Offer starter data models **proactively, right after an extract+load
pipeline for a supported source has been onboarded** and the raw tables
have landed. The natural pitch:

> "I've loaded your Stripe data into `raw`. Dogsled ships a curated set of
> Stripe analytics models — customers, charges, invoices, subscription
> status, daily overview. Want me to stand those up on top of your
> loaded tables?"

Also reach for this skill when a user asks "what models should I build
for X?", "are there prebuilt models for Stripe?", or "give me the
standard analytics shape for this source".

If the source is **not** one of the 23 below, there is no starter
bundle — author models from scratch with `dogsled-author-model-spec-model` instead.

## The three layers

A starter bundle is a standard bronze → silver → gold Model Spec stack, one
slice per integration **resource** (e.g. Stripe `charges`, `customers`):

| Layer  | Model Spec shape                   | Name pattern                    | Materialization | Shipped as a file?                                            |
| ------ | ---------------------------------- | ------------------------------- | --------------- | ------------------------------------------------------------- |
| Bronze | `type: source` (`warehouse_table`) | `raw_<resource>`                | n/a (raw table) | **No — you author it**                                        |
| Silver | `type: model` (staging view)       | `stg_<integration>__<resource>` | `view`          | **No — you author it**                                        |
| Gold   | `type: model` (analytics table)    | `<integration>__<name>`         | `table`         | **Yes — `starter-models-<integration>` ships these verbatim** |

The per-integration skills ship the gold marts, curated Model Spec metrics, and
relationships. `dogsled model models install <integration>` writes the semantic
files under `metrics/<integration>/` and `relationships/<integration>/` with
the source, staging, and mart files. The bronze sources and silver staging
models are derived mechanically from the integration's resource schema. The
recipe for building them is below, and it is identical for every integration.

## Critical: a suggested shape, not a copy

The gold marts reference staging columns by name (`expr:
stg_<int>__<resource>.<col>`). For a mart to compile, the staging model
it references must exist and expose those columns. So before promising a
mart:

1. **Confirm which resources were actually loaded.** A bundle assumes
   the full resource set; the user may have extracted a subset. Only
   build the bronze/silver/gold slices for resources that landed.
2. **Map columns to reality.** If a loaded table is missing a column a
   mart expects, drop that column from the mart (or the whole mart if
   its grain column is gone). If the warehouse has useful columns the
   canonical shape omits, you may add them.
3. **Match the real raw schema and table names.** The recipe defaults to
   schema `raw` and table `raw_<int>__<resource>`, but use whatever the
   extract pipeline actually wrote.
4. **Prune marts whose staging dependency is absent.** A mart that
   references `stg_stripe__disputes` is dead weight if disputes weren't
   extracted — don't ship it.
5. **Prune semantic metadata with its models.** Remove a bundled metric when
   its model is unavailable, and remove a relationship when either referenced
   model is unavailable.

Treat the shipped marts as a high-quality starting point an analyst
reviews and adjusts, not a guaranteed-correct artifact.

## Supported integrations

Fetch `starter-models-<integration>` to get one source's full set of
gold marts (each mart inlined verbatim). Available bundles:

`asana`, `chargebee`, `freshdesk`, `github`, `gong`, `hubspot`,
`intercom`, `jira`, `klaviyo`, `langsmith`, `linear`, `notion`, `pipedrive`,
`pylon`, `quickbooks`, `salesforce`, `shopify`, `slack`, `smartlead`,
`stripe`, `vantage`, `vercel`, `zendesk`.

Example: `starter-models-stripe` ships `stripe__customers`,
`stripe__charges`, `stripe__invoice_details`, `stripe__payment_intents`,
`stripe__subscription_details`, `stripe__subscription_status_summary`,
`stripe__balance_transactions`, `stripe__refund_details`,
`stripe__dispute_impact`, `stripe__customer_lifetime_value`,
`stripe__customer_overview`, `stripe__daily_overview`.

## Naming conventions

For an integration `linear` with a resource `issues`:

| Thing                | Value                                              |
| -------------------- | -------------------------------------------------- |
| Connection           | `linear` (the integration name unless overridden)  |
| Raw warehouse table  | `raw.raw_linear__issues`                           |
| Bronze source `name` | `raw_issues`                                       |
| Silver model `name`  | `stg_linear__issues`                               |
| Silver `source.ref`  | `linear.raw_issues` (`<connection>.<source-name>`) |
| Gold mart `name`     | `linear__issues`                                   |
| Gold `source.ref`    | `stg_linear__issues` (the staging model name)      |

## Build flow

1. **Fetch the bundle** — load `starter-models-<integration>` to see the
   gold marts on offer.
2. **List loaded resources** — inspect the warehouse (or the extract
   pipeline config) to learn which `raw_<int>__<resource>` tables exist
   and their columns.
3. **Author one bronze source per loaded resource** — see recipe below.
4. **Author one silver staging model per loaded resource** — see recipe.
5. **Drop in the gold marts**, pruning any whose staging dependency
   wasn't built and trimming any columns whose staging field is absent.
6. **Materialize** — run a model pipeline to build the views and tables
   (`pipeline` skill).

## The source + staging recipe (you author these two layers)

This is the deterministic recipe Dogsled uses to derive bronze and silver
from an integration resource's output schema. Apply it per resource.

### Bronze source (`raw_<resource>`)

```yaml
spec_version: '0.2'
name: raw_<resource> # e.g. raw_issues
type: source
source_type: warehouse_table
connection: <connection> # integration name unless overridden
table: <schema>.raw_<integration>__<resource> # default schema: raw
description: Raw <integration> <resource> records as extracted by Dogsled.
trust_tier: bronze
schema:
  columns:
    - name: <field>
      type: <WAREHOUSE_TYPE> # mapped from the resource field type
      description: <field description>
```

**Column type map** (resource field type → warehouse type):

| Field type        | Warehouse type |
| ----------------- | -------------- |
| `integer`         | `BIGINT`       |
| `number`          | `NUMERIC`      |
| `boolean`         | `BOOLEAN`      |
| `timestamp`       | `TIMESTAMP`    |
| `array`, `object` | `JSON`         |
| anything else     | `VARCHAR`      |

### Silver staging (`stg_<integration>__<resource>`, a view)

```yaml
spec_version: '0.2'
name: stg_<integration>__<resource>
type: model
description: Staged <resource> records from the <connection> integration.
grain: <pk_column> # single PK col, or a list for composite keys
source:
  ref: <connection>.raw_<resource> # references the bronze source by name
columns:
  - name: <renamed_field>
    expr: t0.<source_field> # base alias is always t0; may be a cast (below)
    description: <field description>
    type: <CAST_TYPE> # only present when expr casts the value
    primary_key: <true on the PK column>
    not_null: <true on the PK column>
    semantic_role: <entity_id|event_timestamp|time_dimension|measure|categorical>
    references: <other_staging.col> # only for foreign-key-like columns
    tags: [<pii?>, <financial?>]
    business_rule: <set when a cast applies>
tags: [<connection>, staging]
trust_tier: silver
materialization:
  type: view
```

For a **composite primary key** (more than one PK column), set
`grain` to the list of columns, mark each PK column `not_null: true`,
and add a custom uniqueness test:

```yaml
tests:
  - type: custom
    sql: SELECT <pk1>, <pk2>, COUNT(*) AS duplicate_count FROM {name} GROUP BY <pk1>, <pk2> HAVING COUNT(*) > 1
```

**Column renames** (raw field name → staging column name):

- `id` → `<singular_resource>_id` (e.g. resource `issues` → `issue_id`)
- `created` → `created_at`, `updated` → `updated_at`, `deleted` → `deleted_at`
- fields ending `_id`, `_token`, `_uuid` → kept as-is
- a `string`/`integer` field whose description reads like an identifier
  ("id of …", "uuid of …", ends in " id") → `<field>_id`
- everything else → unchanged

**Expression casts** (chosen from the field type + description):

| Condition                                                           | `expr`                                       | `type`           |
| ------------------------------------------------------------------- | -------------------------------------------- | ---------------- |
| `integer` whose description says "unix timestamp"                   | `TO_TIMESTAMP(t0.<f>)`                       | `TIMESTAMP`      |
| `integer`/`number` currency in the "smallest currency unit"/"cents" | `CAST(t0.<f> / 100.0 AS NUMERIC(16, 2))`     | `NUMERIC(16, 2)` |
| `string` numeric measure stored as a "numeric string"               | `CAST(NULLIF(t0.<f>, '') AS NUMERIC(16, 2))` | `NUMERIC(16, 2)` |
| `string` date "YYYY-MM-DD" whose column name ends `_date`           | `CAST(t0.<f> AS DATE)`                       | `DATE`           |
| otherwise                                                           | `t0.<f>` (no `type`, no `business_rule`)     | —                |

**`semantic_role`** (first match wins): `entity_id` if PK or name ends
`_id`/`_token`; else `event_timestamp` if type `timestamp` or name ends
`_at`/`_timestamp`; else `time_dimension` if name ends `_date` or it's a
date string; else `measure` if numeric or the name looks financial
(`amount|price|cost|revenue|total|tax|fee|balance|spend|budget|value`) or
a count/quantity measure; else `categorical`.

**`tags`**: add `pii` for `email`/`phone`/name columns; add `financial`
for financial-looking names. Omit `tags` when neither applies.

**Embedding columns** (when the pipeline has an `embed:` block):

A pipeline's `embed:` block adds one `<field>_embedding` column per
configured field to the extracted stream. These columns must propagate
through the bronze source and silver staging. Two places to mention:

- **Bronze source**: the extractor's `dogsled pipeline … --emit-model-spec-source`
  scaffold pre-fills these columns with `type: VECTOR`, `dimension`, and
  `embedded_from`. Copy the scaffold output verbatim into the
  handcrafted source YAML.
- **Silver staging**: re-project the column with the same name, declare
  `type: VECTOR`, `dimension`, and re-author `embedded_from` so the
  host agent has a single place to look up provenance for the
  silver-layer model.

```yaml
# In stg_linear__issues — propagating an embedded description column
- name: description_embedding
  expr: t0.description_embedding
  type: VECTOR
  dimension: 1024
  description: Vector embedding of description (amazon-bedrock/cohere.embed-english-v3)
  embedded_from:
    column: description
    provider: amazon-bedrock
    model: cohere.embed-english-v3
```

`dimension` is required when `type: VECTOR`; `embedded_from` is required
semantically — without it, the host agent cannot generate a query
embedding in the same model family at vector-search time.

## Worked example — Linear `issues`

**Bronze** `raw_issues` (illustrative columns; mirror the real loaded
table):

```yaml
spec_version: '0.2'
name: raw_issues
type: source
source_type: warehouse_table
connection: linear
table: raw.raw_linear__issues
description: Raw linear issues records as extracted by Dogsled.
trust_tier: bronze
schema:
  columns:
    - name: id
      type: VARCHAR
      description: Unique Linear issue identifier.
    - name: title
      type: VARCHAR
      description: Issue title.
    - name: estimate
      type: BIGINT
      description: Issue estimate in points.
    - name: created
      type: TIMESTAMP
      description: Timestamp when the issue was created.
```

**Silver** `stg_linear__issues` (renames `id`→`issue_id`,
`created`→`created_at`; plain `t0.` exprs since no cast applies):

```yaml
spec_version: '0.2'
name: stg_linear__issues
type: model
description: Staged issues records from the linear integration.
grain: issue_id
source:
  ref: linear.raw_issues
columns:
  - name: issue_id
    expr: t0.id
    description: Unique Linear issue identifier.
    primary_key: true
    not_null: true
    semantic_role: entity_id
  - name: title
    expr: t0.title
    description: Issue title.
    semantic_role: categorical
  - name: estimate
    expr: t0.estimate
    description: Issue estimate in points.
    semantic_role: measure
  - name: created_at
    expr: t0.created
    description: Timestamp when the issue was created.
    semantic_role: event_timestamp
tags:
  - linear
  - staging
trust_tier: silver
materialization:
  type: view
```

**Gold** `linear__issues` — the canonical mart, shipped verbatim by
`starter-models-linear` and inlined here as the reference shape:

{{include: packages/models/marts/linear/linear__issues.yml}}

## Validate

After authoring, compile the bundle against the target dialect
(`dogsled model compile` or the unified CLI equivalent) to catch broken
`source.ref`s and missing columns before running a model pipeline. For
materialization choices and the full Model Spec authoring grammar, see
`dogsled-author-model-spec-model`.
