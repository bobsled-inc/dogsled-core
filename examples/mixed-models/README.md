# Mixed models

A **mixed model** joins sources that live in different engines in a single model:
a live/lazy **API** source plus warehouse tables in **two different warehouses**.

This example defines model **D** (`signup_account_events`) over:

- **A** — `signups`, a live/lazy `api_resource` source (`sources/signups.yml`)
- **B** — `accounts`, a Snowflake (W1) warehouse table (`sources/accounts.yml`)
- **C** — `events`, a BigQuery (W2) warehouse table (`sources/events.yml`)

## The two execution engines

A mixed model declares the engine the join runs in via `execution.engine` (an
integration handle). The engine is where every input is co-located before the
join.

### Materialized (default in this example)

```yaml
execution:
  engine: bigquery # a warehouse handle
  staging: ephemeral
materialization:
  type: table
```

The foreign leaves are staged into BigQuery — `signups` is fetched from the API
and loaded, `accounts` is moved Snowflake → object store → BigQuery, `events` is
already there — then `D` materializes as a table in BigQuery. `publish: bigquery`
is an equivalent alias for `execution.engine: bigquery`.

```sh
cp secrets.example.yml secrets.yml   # fill in
bobsled model run --secrets secrets.yml --integration bigquery
```

Set `XWH_SHARED_STAGING_URI` to a bucket both warehouses can reach for the native
UNLOAD substrate; remove it to force host-side streaming.

### Live (recompute on read)

Point the engine at the local DuckDB integration and make the model a view:

```yaml
execution:
  engine: lake # the duckdb integration
materialization:
  type: view
```

Every run pulls A, B, and C into `./data/lake.duckdb`, builds `D` as a view, and
recomputes from a fresh API fetch (live) or cache (lazy) — nothing is persisted.

```sh
bobsled model run --secrets secrets.yml      # auto-selects the lake engine
bobsled query "SELECT * FROM signup_account_events LIMIT 5"
```

> A source read by both a warehouse-engine model and the live (lake) model can't
> be staged two ways at once — keep one engine per source, or split into
> per-engine staging models.

## Notes

- `sources/signups.yml` `integration`/`resource` name a bundled
  `@bobsled-inc/integrations` catalog entry — swap in your real API source. Its
  `connection: lake` is the DuckDB cache the fetched rows land in.
- `D` can never be fresher than B and C are in their own warehouses; "live" means
  live on A, as-of-last-refresh on B and C.
