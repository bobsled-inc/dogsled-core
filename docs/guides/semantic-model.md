# Semantic model

A project's semantic model is what its data means: descriptions and AI context,
metrics, relationships between models, and verified queries. It is not a separate
file. It lives in the model files themselves and in the `metrics/`,
`relationships/` and `vqs/` folders next to them. People and agents read it to
answer questions with the right tables and definitions. Bobsled Core validates it with
your models, exports it for other tools, and runs verified queries. Entities, the
other part of the semantic model, are covered in [Entity graph](entity-graph.md).

This guide continues the `shop` project from [Build models](build-models.md).

## Descriptions and AI context

Sources, models, columns, metrics and relationships each take a `description`, for
people, and an `ai_context`, for agents. `ai_context` is either text or a mapping
with keys you choose, such as instructions and synonyms. Bobsled Core checks that it is
text or a mapping, keeps it in exports, and leaves its meaning to the agent that
reads it.

Add AI context to the `customer_revenue` model:

```bash
cat >> models/customer_revenue.yml <<'EOF'
ai_context:
  instructions: Use this model for questions about customer spend. Amounts are in US dollars.
  synonyms: [spend, revenue per customer]
EOF
```

## Synonyms

Synonyms are other names people use for a source, model, column or metric. Write
them in `synonyms`:

```yaml
schema:
  columns:
    - name: parcel_number
      type: VARCHAR
      synonyms: [APN, parcel id]
```

Synonyms in `ai_context.synonyms`, the Ossie location, also count. Bobsled Core merges
the two lists: `synonyms` first, then `ai_context.synonyms`, without repeats that
differ only in case or spacing. Ossie export writes the merged list to
`ai_context.synonyms`. Ossie import moves it back to `synonyms`, so exporting again
writes the same document.

Bobsled Core warns about keys a source or model file declares that it does not use, such
as a misspelled `synonym`. The file still loads.

## Metrics

A metric is a named aggregate over one model.

Create `metrics/total_revenue.yml`:

```yaml
spec_version: '0.2'
type: metric
name: total_revenue
description: Total order amount across customers.
ai_context: Revenue before refunds. Prefer this metric over summing orders yourself.
model: customer_revenue
expression: SUM(total_amount)
```

## Relationships

A relationship says how two models join.

Create `relationships/top_to_revenue.yml`:

```yaml
spec_version: '0.2'
type: relationship
name: top_to_revenue
left_model: top_customers
right_model: customer_revenue
join_columns:
  - left: customer
    right: customer
relationship_type: many_to_one
```

`bobsled model validate` checks that each metric and relationship points at models
and columns that exist:

```bash
bobsled model validate --integration warehouse
```

```text
✓ metadata: 1 metric(s), 1 relationship(s), 0 entity relationship(s), 0 VQ(s)
...
Validated 3 model(s): 3 passed
```

`bobsled model compile --output build --include-metadata` writes the metrics and
relationships to `build/metrics.json` and `build/relationships.json` for other tools.
Bobsled Core does not compute metrics itself.

## Verified queries

A verified query (`type: vq`) pairs a question with SQL that is known to answer it,
with typed parameters. Agents use them as worked examples, and `bobsled vq <name>`
runs them. See [Query data](query-data.md#run-a-verified-query).

## Exchange models with Apache Ossie

[Apache Ossie](https://ossie.apache.org/) is a vendor-neutral interchange format
for semantic models. Bobsled Core exports sources, models, metrics and relationships,
and verified queries (with `0.2.0.dev0`), to one Ossie YAML document, and imports
Ossie documents into Bobsled Core files.

```bash
bobsled model ossie export --all --name shop --ossie-version 0.2.0.dev0 \
  --out ../shop.ossie.yaml --human
bobsled model ossie import ../shop.ossie.yaml --project . --out ../imported --human
grep "ai_context: Revenue" ../shop.ossie.yaml
```

```text
Ready: 1 generated file(s)
...
Ready: 6 generated file(s)
...
    ai_context: Revenue before refunds. Prefer this metric over summing orders yourself.
```

Keep exported documents and imported files outside the project folder until you
review them: `bobsled model validate` reads every file in the project, and an
exported Ossie document or a second copy of a model there makes it fail.

The default version, `0.1.1`, is the released standard; it cannot carry everything
a Bobsled Core model needs, so the export lists what it dropped. `0.2.0.dev0` keeps the
extra Bobsled Core fields so that a round trip produces equivalent models. Import never
overwrites files: `--out` must be a new directory, and without `--out` it only
previews. Pass `--strict` to fail instead of dropping information, and
`--connection`, `--bind` or `--map-connection` to attach imported datasets to your
integrations.

With `0.2.0.dev0`, the export also carries the project's verified queries in a
`BOBSLED` extension, and import writes them back as `type: vq` files under
`verified_queries/`. A query goes in only when every model or source it refers to
is exported; a query that refers to none goes in only with `--all`. `0.1.1` leaves
verified queries out and warns. See
[OSI import and export](../../packages/model-spec/docs/ossie-interchange.md#verified-queries)
for the full rules.

## Guidance for agents

A project can also carry an `AGENTS.md` file that explains the data, and skills
that teach agents specific tasks. See [Project guide and skills](project-skills.md).

See the [customer ontology guide](customer-ontologies.md) for business concepts and mappings.
