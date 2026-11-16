# One extraction, three destinations

Prerequisites: Node.js 24+, an installed `dogsled` CLI and OpenSSL. Run the automated walkthrough from a built checkout with `pnpm e2e:fan-out`. Docker is also required.

1. From the checkout root, start the fictional HTTPS API in one terminal:

   ```bash
   node scripts/e2e/mock-api.mjs fan-out
   ```

   Copy the five printed `export` commands into a second terminal. They select a
   loopback URL, a synthetic local token, the temporary certificate and the explicit
   private-host opt-in. Keep the server running until the walkthrough ends.

2. In that second terminal, copy the committed project and enter it:

   ```bash
   cp -R examples/fan-out /tmp/dogsled-fan-out
   cd /tmp/dogsled-fan-out
   ```

3. Start disposable Postgres on a random loopback port and configure the copied project:

   ```bash
   docker compose up -d --wait
   export SHOWCASE_PG_PORT=$(docker compose port postgres 5432 | sed 's/.*://')
   export SHOWCASE_PG_PASSWORD=unused-local-only
   node configure-postgres.mjs
   docker compose exec postgres psql -U postgres -d showcase -c 'CREATE SCHEMA IF NOT EXISTS fanout'
   cat destinations.json
   ```

   The committed JSON declares DuckDB, Postgres and a local JSONL archive. Only the
   generated local Docker port changes; the password is synthetic and authentication
   is trust-only inside this disposable loopback service.

4. Replay one extraction to all three destinations:

   ```bash
   dogsled pipeline --integration shop_api --resource customers --destinations-json "$(cat destinations.json)" --output-dir archive --log-format json
   dogsled query 'SELECT count(*) AS n FROM customers' --db-path data.duckdb
   docker compose exec postgres psql -U postgres -d showcase -c 'SELECT count(*), count(_bobsled_loaded_at) FROM fanout.customers'
   ```

   Expect zero failed streams and 200 rows in each destination, including the
   JSONL files under `archive/`. Postgres has 200 non-null load timestamps. The API
   serves two pages total; destinations do not cause repeated extraction.

5. Stop the API with Ctrl-C and remove this example's database service:

   ```bash
   docker compose down --volumes
   ```

Known limitation: named fan-out destinations do not support DuckLake. The golden-path quickstart covers the
direct DuckLake loader.
