# Entity graph

The entity graph resolves records from several sources into one entity each: one
customer, one company, one contact. It finds candidate pairs, scores them, merges
the confident ones, queues the uncertain ones for review, and builds a profile for
every entity with a stable ID. You can then query the profiles with SQL, read them
through a generated TypeScript SDK, or serve them to applications and agents.

This guide continues the `shop` project from [Build models](build-models.md), which
has the `warehouse` integration and the `runner.mjs` module.

## Two lists of the same customers

The CRM and the billing system both know Ada Labs, with different capitalization:

```bash
dogsled query "CREATE OR REPLACE TABLE raw.crm_contacts AS SELECT * FROM (VALUES ('c1','Ada Labs','Ada@AdaLabs.example'), ('c2','Grace Corp','ops@grace.example')) t(contact_id, name, email); CREATE OR REPLACE TABLE raw.billing_accounts AS SELECT * FROM (VALUES ('b1','Ada Labs Ltd','ada@adalabs.example '), ('b2','Linus Ltd','billing@linus.example')) t(account_id, name, email); CREATE SCHEMA IF NOT EXISTS entity_graph" \
  --db-path .bobsled/bobsled.duckdb
```

Declare both tables as sources.

Create `sources/crm_contacts.yml`:

```yaml
spec_version: '0.2'
type: source
name: crm_contacts
source_type: warehouse_table
connection: warehouse
table: raw.crm_contacts
schema:
  columns:
    - { name: contact_id, type: VARCHAR }
    - { name: name, type: VARCHAR }
    - { name: email, type: VARCHAR }
```

Create `sources/billing_accounts.yml`:

```yaml
spec_version: '0.2'
type: source
name: billing_accounts
source_type: warehouse_table
connection: warehouse
table: raw.billing_accounts
schema:
  columns:
    - { name: account_id, type: VARCHAR }
    - { name: name, type: VARCHAR }
    - { name: email, type: VARCHAR }
```

## Describe how to resolve them

A resolution spec lists the inputs, how to clean fields before comparing them, how to
find candidate pairs (blocking), how to score them, and the thresholds for merging.
Cleaned fields get a `standardized_` prefix.

Create `entity-graph/Customer_resolution.yml`:

```yaml
spec_version: '0.2'
name: Customer
type: resolution
description: One customer per company across the CRM and billing.
inputs:
  - ref: warehouse.crm_contacts
    role: internal
    id_fields: [contact_id]
  - ref: warehouse.billing_accounts
    role: internal
    id_fields: [account_id]
standardize:
  - field: email
    transforms: [lowercase, trim]
blocking:
  rules:
    - name: email_block
      key: standardized_email
deterministic_rules:
  - name: exact_email
    conditions:
      - field: standardized_email
        operator: exact
        both_not_null: true
    action: auto_merge
    confidence: 1.0
scoring:
  method: weighted_features
  features:
    - field: standardized_email
      algorithm: exact
      weight: 1.0
thresholds:
  auto_merge: 0.95
  review: 0.6
  auto_reject: 0.4
profile:
  display_name:
    field: name
    source_precedence: [warehouse.crm_contacts, warehouse.billing_accounts]
  attributes:
    - field: email
```

Scoring also offers fuzzy algorithms such as `jaro_winkler`, and the transforms
include `strip_legal_suffixes`, `strip_www`, `digits_only` and others. Pairs that
score between `review` and `auto_merge` go to a review queue.

## Build the graph

`entity-graph build` runs resolution, clustering and profiles for one or more
entities. It writes its tables to the schema you pass, prefixed with the entity
name:

```bash
dogsled entity-graph resolve validate Customer
dogsled entity-graph build Customer --runner ./runner.mjs --dialect duckdb --schema entity_graph
dogsled query "SELECT display_name, source_diversity FROM entity_graph.customer__entity_profile ORDER BY display_name" \
  --db-path .bobsled/bobsled.duckdb
```

```text
✔ Customer (2 inputs, 1 blocking rules)
✔ Validated 1 resolution spec(s).
...
display_name	source_diversity
Ada Labs	2
Grace Corp	1
Linus Ltd	1
```

Four records became three customers. Ada Labs comes from both systems, and its
display name comes from the CRM because the CRM is first in `source_precedence`.
Other tables in the schema hold the candidate pairs, scores, clusters, the review
queue, crosswalks from each source record to its entity, and an audit log.
`dogsled entity-graph status --runner ./runner.mjs --dialect duckdb` counts the rows
in the shared tables.

Each entity keeps its `entity_id` across rebuilds, when new records arrive, and when
entities merge or split, so that downstream tables can join on it.

## Read an entity

```bash
ID=$(dogsled query "SELECT entity_id FROM entity_graph.customer__entity_profile WHERE display_name = 'Ada Labs'" \
  --db-path .bobsled/bobsled.duckdb --yaml | sed -n 's/.*entity_id: //p')
dogsled entity-graph get --entity Customer --id "$ID" \
  --runner ./runner.mjs --dialect duckdb --schema entity_graph --json
```

```text
"entity_type": "Customer",
...
"email": "ada@adalabs.example",
"crm_contacts_id": "c1",
"has_crm_contacts": true,
"billing_accounts_id": "b1",
"has_billing_accounts": true,
...
"trust_band": "trusted"
```

The result has the golden record (`profile`), quality scores, and a crosswalk entry
for each source record.

`entity-graph match --entity Customer --input record.json` looks up which entity a
new record belongs to; `--mode assign` and `--mode stage` write the match.

## Generate a typed SDK

```bash
dogsled sdk generate --lang ts --out ./generated/bobsled-sdk
```

```text
Generated 5 TypeScript file(s) from 1 entity type(s).
```

The SDK has a typed client for each entity with `findBy(...)`, `withDocuments()`,
`withRelationship(...)`, `all()` and `first()`. It does not connect to a database
itself: your application passes an executor that runs the requests. See
[SDK generation](../reference/advanced/sdk-codegen.md).

## Serve entities to agents

- `dogsled entity-graph serve` starts a read-only HTTP API on 127.0.0.1 with
  `/healthz`, `/entities/<entity>` (search) and `/entities/<entity>/<id>`. It does not
  check who is calling, so it binds to loopback only; `--allow-remote` also needs
  `BOBSLED_CORE_ENTITY_GRAPH_ALLOW_REMOTE=1`. `--allow-writes` enables match writes.
- `dogsled mcp serve --transport stdio --principal-id <id> --runner ./runner.mjs
--dialect duckdb --schema entity_graph` serves the tools `entity_search`,
  `entity_get`, `entity_match`, `entity_relationships`, `entity_explain` and
  `read_source` (document and chunk rows with citations) to an MCP client. Every call
  runs as the principal you pass; unfiltered reads need both `--allow-unfiltered`
  and `BOBSLED_CORE_MCP_ALLOW_UNFILTERED=1`. See [MCP read_source](../reference/advanced/mcp-read-source.md).

## Everything else in the entity graph

| Command                                                                        | What it does                                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolve init`, `scaffold`, `quickstart`                                       | Create starter specs.                                                                                                                                  |
| `resolve run`, `cluster`, `profile`, `estimate`, `inspect`, `report`, `status` | Run or inspect each resolution stage on its own.                                                                                                       |
| `review export`, `apply`, `list`, `show`, `decide`, `unmerge`, `feedback`      | Work through the review queue in CSV, JSON or YAML.                                                                                                    |
| `survivorship`                                                                 | Rules that pick each golden-record attribute from the best source.                                                                                     |
| `truthset`                                                                     | Labeled pairs to score and tune thresholds; `suggest thresholds` proposes them.                                                                        |
| `mentions`                                                                     | Find entity mentions in document chunks and link them to entities. See [Mention extraction](../reference/advanced/mention-extraction.md).              |
| `relationships`, `relate`, `object`                                            | Relationships between entities, extracted from documents or declared. See [Relationship extraction](../reference/advanced/relationship-extraction.md). |
| `explain`, `lineage`, `audit`                                                  | Why an entity looks the way it does, where each attribute came from, and the audit log.                                                                |
| `forget`                                                                       | Remove a source record from every entity-graph table.                                                                                                  |
| `pii`, `policy`                                                                | Scan for personal data and suggest policies; validate and evaluate policy specs.                                                                       |
| `activate`                                                                     | Send entity records to external systems through action specs (also `dogsled activate`).                                                                |
| `agent`                                                                        | Bounded tasks for coding agents: triage, review batches, onboarding.                                                                                   |
| `diff`                                                                         | Compare entity-graph specs with a Git ref.                                                                                                             |

The [CLI reference](../reference/cli.md#bobsled-entity-graph) lists every flag.
