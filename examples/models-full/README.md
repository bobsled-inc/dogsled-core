# Seeds, models, expectations and lineage

Run `pnpm e2e:models-full` from a built checkout. The suite loads four fictional
CSV seeds (50 customers, 100 orders, 20 products, five categories), compiles and
runs six models, executes expectations, checks lineage, joins a second DuckDB
file, and reruns an incremental merge after adding ten orders. It asserts 110
unique dates and total revenue of 50600 units after the second run.

For a manual walkthrough, copy this directory to a new folder, install
`@bobsled-inc/bobsled-core` locally, then run:

```bash
bobsled model seed load --dialect duckdb --schema main --runner ./runner.mjs --json
bobsled query "CREATE OR REPLACE TABLE benchmarks AS SELECT i AS customer_id, 1000 AS target FROM range(1,51) AS t(i)" --db-path auxiliary.duckdb
bobsled model validate --integration local_duckdb
bobsled model run --integration local_duckdb --json
bobsled model expect run --integration local_duckdb --runner ./runner.mjs --json
bobsled model lineage --integration local_duckdb --json
```

The query command prepares `main.benchmarks` in `auxiliary.duckdb` before the mixed
model runs, using customer IDs 1–50 and target 1000. The executable `prepare`
function in `showcase.mjs` shows the equivalent public connection API call.
`runner.mjs` adapts that same public connection API for seeds and expectations;
it opens and closes a local runner for each statement. `model test` generates
SQL; `model expect run` with a runner actually executes the assertions.

`order_summary` and `top_customers` are views, `product_stats` and
`customer_lifetime` are tables, and `daily_revenue` uses incremental merge.
`cross_engine_report` stages a source from the second file into the chosen engine.

This automated walkthrough verifies DuckDB. On BigQuery, the same fresh project
builds in one run: models that read relations built earlier in the run are
dry-run just before they execute, and source-schema checks still run first.
