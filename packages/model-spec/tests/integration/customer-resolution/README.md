# Customer Resolution Integration Example

This directory is a runnable, warehouse-backed integration example for Bobsled Core's agent-native Entity Graph flow. It uses synthetic B2C customer data across Shopify, HubSpot, and Zendesk, then exercises the full lifecycle:

1. Load seeds into `raw.*`
2. Run entity resolution into `entity_graph_test.customer__*`
3. Propose and apply agent-review decisions
4. Cluster merged records
5. Refresh survivorship outputs
6. Regress thresholds against a committed truthset

The same YAML specs run on both DuckDB and BigQuery.

## Data Shape

Sources:

- `ecom.shopify_customers` (`gold`)
- `crm.hubspot_contacts` (`silver`)
- `support.zendesk_users` (`bronze`)

Each source carries:

- source PK
- `email`
- `first_name`
- `last_name`
- `phone`
- `country`

The synthetic records intentionally cover:

- exact-email auto-merges
- email-typo / nickname agent-review pairs
- human-review same-name collisions
- non-match collisions that share blocking keys

## Files

Core assets:

- `model-spec.yml` points at sources, seeds, integrations, and Entity Graph specs
- `integrations/` stores DuckDB connection defaults for the source handles
- `sources/` registers the `raw.*` warehouse tables
- `seeds/` defines and stores the synthetic CSV source data
- `entity-graph/` contains the resolution, survivorship, truthset, and agent-profile specs
- `runner.duckdb.js` persists to `customer_resolution.db`
- `runner.bigquery.js` uses `runner.config.json`
- `scripts/run.sh` is the single entrypoint for walkthrough and test execution

Generated artifacts:

- `review/customer_agent_bundle.yml`
- `review/artifacts/*.json`
- `customer_resolution.db` in DuckDB mode

## Prerequisites

Install workspace dependencies first:

```bash
pnpm install
```

`scripts/run.sh` executes the `model-spec` CLI directly from source with `tsx`, so it does not require a prior package build.

The runners resolve runtime dependencies from other workspace packages:

- DuckDB comes from `packages/bobsled-core`
- BigQuery comes from `packages/loader`

## Run It

Illustrative DuckDB walkthrough:

```bash
cd packages/model-spec/tests/integration/customer-resolution
bash scripts/run.sh
```

Explicit illustrative DuckDB run:

```bash
bash scripts/run.sh --mode illustrative --dialect duckdb
```

Idempotent DuckDB test mode:

```bash
bash scripts/run.sh --mode test --dialect duckdb
```

Latest unified CLI path from the current checkout:

```bash
bash scripts/install-and-run-latest-cli.sh
```

That script installs workspace dependencies, builds the current `bobsled` CLI, and runs the same end-to-end example through `bobsled model ...` instead of the source-only `tsx` shortcut.

## BigQuery

Copy the config template, then fill in your project, key file, and dataset location:

```bash
cp runner.config.json.example runner.config.json
```

Example:

```json
{
  "projectId": "my-project",
  "keyFilename": "service-account-key.json",
  "location": "US"
}
```

The runner will create the `raw` and `entity_graph_test` datasets automatically if they do not exist.

Illustrative BigQuery run:

```bash
bash scripts/run.sh --mode illustrative --dialect bigquery
```

BigQuery test mode:

```bash
bash scripts/run.sh --mode test --dialect bigquery
```

## Notes

- `customer__golden_record` is attribute-grain output, not one row per cluster.
- The dedupe assertion uses `COUNT(DISTINCT cluster_id)` from `customer__clusters`, because the status command reports raw table row counts.
- The truthset uses stable `pair_id` values derived from the synthetic source IDs, so it works as a committed regression harness.
- The committed `entity-graph/agent/customer_review_batch.yml` is an apply-mode profile for one-shot autonomous execution, but `scripts/run.sh` intentionally shows the safer propose-then-apply flow.

## One-Shot Agent Apply

After a DuckDB resolve run, you can let the bounded agent workflow apply decisions, cluster, and refresh survivorship in one call:

```bash
../../../../../node_modules/.bin/tsx ../../../src/index.ts agent review-batch \
  --profile entity-graph/agent/customer_review_batch.yml \
  --runner ./runner.duckdb.js \
  --dialect duckdb \
  --json
```

## Spot Checks

DuckDB:

```bash
duckdb customer_resolution.db -c "
  SELECT COUNT(DISTINCT cluster_id) AS distinct_clusters FROM entity_graph_test.customer__clusters;
  SELECT COUNT(*) AS golden_rows FROM entity_graph_test.customer__golden_record;
"
```
