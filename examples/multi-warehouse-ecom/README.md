# Self-hosted multi-warehouse shop

This public example contains only fictional data: eight customers, six products
and 16 orders worth 1360 units. It loads CSV through the built-in file source to
DuckDB and Postgres, executes models on both warehouses, validates metrics and
relationships, and joins Postgres customers with DuckDB orders through a mixed
model. It needs no hosted application or managed connection references.

Run `pnpm e2e:multi-warehouse-ecom` with Docker available. The script provisions a
disposable local Postgres container on a random port and writes the corresponding
local config. It checks exact counts and revenue on both engines.

1. Copy the committed project to a disposable directory, then start its local database:

   ```bash
   cp -R examples/multi-warehouse-ecom /tmp/bobsled-multi-warehouse-ecom
   cd /tmp/bobsled-multi-warehouse-ecom
   docker compose up -d --wait
   export SHOWCASE_PG_PORT=$(docker compose port postgres 5432 | sed 's/.*://')
   export SHOWCASE_PG_HOST=127.0.0.1 SHOWCASE_PG_USER=postgres SHOWCASE_PG_PASSWORD=unused-local-only
   node configure-postgres.mjs
   docker compose exec postgres psql -U postgres -d showcase -c 'CREATE SCHEMA IF NOT EXISTS ecommerce'
   ```

   Postgres binds a random loopback port, avoiding a local database conflict.
   `configure-postgres.mjs` changes that port in the copied integration and
   `destinations.json`; it leaves the committed fictional project shape intact.

2. Use the same destination JSON and single extraction as the automated test:

   ```bash
   cat destinations.json
   dogsled pipeline --integration local_exports --resource customers products orders --destinations-json "$(cat destinations.json)" --log-format json
   dogsled model validate
   dogsled model run --json
   dogsled query 'SELECT count(*) AS n, SUM(amount) AS total FROM mixed_order_report' --db-path data.duckdb
   docker compose exec postgres psql -U postgres -d showcase -c 'SELECT count(*), SUM(amount) FROM ecommerce.postgres_order_summary'
   ```

   Expect 8 customers, 6 products and 16 orders on each engine. Both summary queries
   return 16 orders and 1360 revenue units. The committed JSON contains:

   ```json
   [
     { "name": "local_db", "type": "duckdb", "db_path": "data.duckdb", "schema": "main" },
     {
       "name": "postgres",
       "type": "postgres",
       "host": "127.0.0.1",
       "port": 5432,
       "database": "showcase",
       "schema": "ecommerce",
       "username": "postgres",
       "password": "$SHOWCASE_PG_PASSWORD"
     }
   ]
   ```

   The port shown above is the initial placeholder; the configure command replaces it.
   `secrets.example.yml` lists only the environment variables used by this local
   example. Install Dogsled in the copied project if its public runner imports
   cannot resolve. No cloud account is configured by these files.

3. Remove this example's service with `docker compose down --volumes`.

Known limitation: the VQ CLI currently queries API sources. The warehouse VQ here
is validated as metadata and its exact SQL is run using `dogsled query`; the verified-query example
separately proves parameterized VQ CLI execution against the local API.
