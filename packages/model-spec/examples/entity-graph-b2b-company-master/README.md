# B2B Company Master Example

Made-up but realistic use case: a wholesale brand sells through Shopify B2B, works accounts in Salesforce, and enriches records from Enrichment vendor. The goal is a single company master so revenue, pipeline, and account ownership all roll up to the same entity.

For the broader operator and agent workflow, see [`docs/reference/advanced/entity-graph-authoring-guide.md`](../../../../docs/reference/advanced/entity-graph-authoring-guide.md) and the skills under [`.agents/skills/entity-graph-authoring/`](../../../../.agents/skills/entity-graph-authoring/) and [`.agents/skills/entity-graph-resolve/`](../../../../.agents/skills/entity-graph-resolve/).

## Why This Example

- Salesforce has the cleanest account ownership and DUNS coverage.
- Shopify has the freshest commercial activity.
- Enrichment vendor improves long-tail coverage but introduces duplicate companies.

This is the kind of problem the current entity-resolution feature is well suited for: company-level dedupe across a small number of warehouse tables with clear deterministic anchors and a review queue for the ambiguous middle.

## Project Layout

```text
entity-graph-b2b-company-master/
├── model-spec.yml
├── sources/
│   ├── commerce/shopify_b2b_companies.yml
│   ├── marketing/enrichment_vendor_companies.yml
│   └── revops/
│       ├── salesforce_accounts.yml
│       └── salesforce_contacts.yml
└── entity-graph/
    ├── company_resolution.yml
    ├── contact_resolution.yml
    ├── agent/company_review_batch.yml
    ├── relationships/
    │   ├── works_at.entity-relationship.yml
    │   └── subsidiary_of.entity-relationship.yml
    ├── objects/
    │   ├── company.object.yml
    │   └── contact.object.yml
    ├── company_survivorship.yml
    ├── company_truthset.yml
    └── data/company_truthset.csv
```

## Workflow

```bash
bobsled model seed validate
bobsled model seed diff --runner ./runner.js --json
bobsled entity-graph resolve validate company
bobsled entity-graph resolve compile company -o ./sql
bobsled entity-graph resolve run company --runner ./runner.js
bobsled entity-graph resolve status company --runner ./runner.js --json
bobsled entity-graph resolve estimate company --runner ./runner.js --json
bobsled entity-graph resolve run contact --runner ./runner.js
bobsled entity-graph resolve cluster contact --runner ./runner.js
bobsled entity-graph review export company --template --format csv --runner ./runner.js --output ./review/company_queue.csv
bobsled entity-graph review list company --runner ./runner.js --json
# Open ./review/company_queue.csv, fill in the decision column with merge, not_match, or defer, then save it.
bobsled entity-graph review apply --input ./review/company_queue.csv --entity company --runner ./runner.js
bobsled entity-graph resolve cluster company --runner ./runner.js
bobsled entity-graph survivorship run company --runner ./runner.js
bobsled entity-graph survivorship inspect company --runner ./runner.js --json
bobsled entity-graph relate validate --json
bobsled entity-graph relate compile works_at -o ./sql/relationships
bobsled entity-graph relate run works_at --runner ./runner.js
bobsled entity-graph relate review works_at --runner ./runner.js --json
bobsled entity-graph object validate --json
bobsled entity-graph object compile -o ./sql/objects
bobsled entity-graph build company --runner ./runner.js
bobsled entity-graph explain --subject entity --id company-1 --runner ./runner.js --format=json
bobsled entity-graph truthset score company --runner ./runner.js
bobsled entity-graph truthset tune company --runner ./runner.js
```

## One-Shot Agent Workflow

```bash
bobsled entity-graph agent triage company --runner ./runner.js --json
bobsled entity-graph agent review-batch --entity company --mode propose --runner ./runner.js --output-bundle ./review/company_agent_bundle.yml --json
bobsled entity-graph agent review-batch --profile ./entity-graph/agent/company_review_batch.yml --runner ./runner.js --json
bobsled entity-graph agent survivorship-refresh company --runner ./runner.js --json
bobsled entity-graph agent truthset-regress company --runner ./runner.js --json
```

- The low-level `resolve`, `review`, `survivorship`, and `truthset` commands remain the canonical primitives.
- The `entity-graph agent` commands are bounded orchestration wrappers for coding agents and unattended routines.
- `review apply` accepts `--input -`, so proposal bundles can be piped straight into the CLI when another agent already has the JSON in memory.
- Start from `agent triage`, default `agent review-batch` to `--mode propose`, and only move to `--mode apply` when policy allows writes.

## Runner Notes

- `resolve run`, `review apply`, `seed load`, `resolve cluster`, and `survivorship run` need a runner module with a `run(sql)` export.
- `query(sql)` is optional; provide it for inspection and export commands such as `review export --runner`, `review list --runner`, `review show --runner`, `resolve status --runner`, `resolve estimate --runner`, `resolve inspect --runner`, `survivorship inspect --runner`, `truthset score --runner`, and `truthset tune --runner`.
- `entity-graph agent` commands need a runner module with `query(sql)`. `agent review-batch --mode apply` and `agent survivorship-refresh` also need `run(sql)`.

## What Good Looks Like

After `cluster`, the main output tables should tell a clean story:

- `company__pair_scores`: every candidate pair with deterministic or fuzzy scores
- `company__review_queue`: only the ambiguous pairs
- `company__review_decisions`: append-only record of human or agent decisions
- `company__clusters`: final record-to-cluster assignments
- `company__crosswalks`: source-system IDs mapped to unified company IDs
- `works_at__relationship_edges`: contact-to-company edges backed by email/domain evidence
- `entity_graph.relationship_edges`: the cross-relation edge contract for agents and Explorer
- `entity_graph.object_types`: typed object metadata for company/contact pages

After `survivorship run`, the golden-record outputs should be populated:

- `company__golden_record`: golden-record attribute winners by cluster
- `company__golden_history`: append-only history of golden-record changes
- `company__survivorship_audit`: field-level provenance for the current golden record
