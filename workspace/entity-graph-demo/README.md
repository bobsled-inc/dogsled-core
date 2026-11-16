# Entity Graph Demo

Self-contained demo workspace for the Bobsled Core Explorer entity graph surface. Not a production artifact — a fixture the UI and devs can drive end-to-end against DuckDB.

## What's here

- `model-spec.yml` — project config (DuckDB, schema `entity_graph_demo`, sources/seeds/entity graph spec dirs).
- `runner.duckdb.js` — `@duckdb/node-api` runner. Creates `company_resolution.db` on first use and bootstraps `raw` / `entity_graph_demo` schemas.
- `sources/` — four `warehouse_table` source specs (`shopify`, `hubspot`, `zendesk`, `crm` namespaces) pointing at `raw.*` seed tables.
- `seeds/` — four seed specs + their CSVs. Loading them populates `raw.*`.
- `entity-graph/company_resolution.yml` — resolution spec wired to the four source refs.
- `entity-graph/company_survivorship.yml` — survivorship spec that picks golden record attributes.

## Driving it from the CLI

```bash
cd workspace/entity-graph-demo
pnpm --filter @bobsled-inc/model-spec exec model seed load --runner ./runner.duckdb.js
pnpm --filter @bobsled-inc/entity-graph exec entity-graph resolve run company --runner ./runner.duckdb.js
pnpm --filter @bobsled-inc/entity-graph exec entity-graph resolve cluster company --runner ./runner.duckdb.js
pnpm --filter @bobsled-inc/entity-graph exec entity-graph resolve profile company --runner ./runner.duckdb.js
pnpm --filter @bobsled-inc/entity-graph exec entity-graph survivorship refresh company --runner ./runner.duckdb.js
```

The `bobsled` binary (`packages/bobsled-core`) wraps both — `bobsled model seed load ...` and `bobsled entity-graph resolve run ...` work identically when installed.

## Agent review walkthrough

The seeds include two deliberate gray-zone pairs (`Lumen Data Works` ↔ `Lumen
Dataworks Inc`, `Vandelay Industries Group` ↔ `Vandelay Industry Grp`) that
score inside the review band, so `resolve run` leaves them in
`company__review_queue`. The resolution spec enables `agent_policy` with
`model: reviewer` (resolved against `platform.models` in this directory's
`bobsled.yml`) plus an `entity_semantics` block that shapes the judge's prompt.

```bash
cd workspace/entity-graph-demo
export ANTHROPIC_API_KEY=sk-ant-...   # the reviewer role's key (env indirection)

# 1. Judge only — inspect the decision bundle, nothing written:
pnpm --filter @bobsled-inc/entity-graph exec entity-graph resolve review company --runner ./runner.duckdb.js --dry-run --json

# 2. Write gated decisions (confidence ≥ auto_apply_threshold → applied,
#    below → proposed for human confirmation, defer → deferred):
pnpm --filter @bobsled-inc/entity-graph exec entity-graph resolve review company --runner ./runner.duckdb.js

# 3. Fold applied merges into clusters + golden records:
pnpm --filter @bobsled-inc/entity-graph exec entity-graph resolve cluster company --runner ./runner.duckdb.js
```

Without `ANTHROPIC_API_KEY`, the review is fail-soft: the run stays green, the
pairs are written as `deferred` (routed to the human review queue), and a
warning explains why. Re-running `resolve review` reports `queue_empty` —
pairs with any decision are never re-judged. Programmatic hosts use
`reviewResolveProject(...)` from `@bobsled-inc/entity-graph/api`, optionally
injecting their own `llmClient` instead of configuring a model role.

To route the review through an **external reviewer** instead of the model
role (no API key needed), uncomment the `reviewer:` block in
`entity-graph/company_resolution.yml` — it pipes each batch to the bundled
`sample-reviewer.mjs` over stdin and applies its `{decisions}` through the
same confidence gate, written with `decision_source: 'agent'`. The wire
contract for bringing your own agent (HTTP or command) is documented in
[`docs/reference/advanced/entity-graph-reviewer-contract.md`](../../docs/reference/advanced/entity-graph-reviewer-contract.md).

## Driving it from the Explorer UI

`/entity-graph/resolve` calls `POST /api/entity-graph/run`. The route spawns the sequence above via the Bobsled Core CLI, streaming stdout/stderr over SSE. It's idempotent — every run overwrites the `entity_graph_demo.company__*` tables.
