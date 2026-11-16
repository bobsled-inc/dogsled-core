# Mock API pipeline

Prerequisites: Node.js 24+, an installed `dogsled` CLI and OpenSSL. Run the automated walkthrough from a built checkout with `pnpm e2e:mock-api-pipeline`.

1. From the checkout root, start the fictional HTTPS API in one terminal:

   ```bash
   node scripts/e2e/mock-api.mjs mock-api-pipeline
   ```

   Copy the five printed `export` commands into a second terminal. They select a
   loopback URL, a synthetic local token, the temporary certificate and the explicit
   private-host opt-in. Keep the server running until the walkthrough ends.

2. In that second terminal, copy the committed project and enter it:

   ```bash
   cp -R examples/mock-api-pipeline /tmp/bobsled-mock-api-pipeline
   cd /tmp/bobsled-mock-api-pipeline
   ```

3. Validate the integration and its first resource, then load all three streams:

   ```bash
   dogsled extract validate shop_api
   dogsled extract health-check shop_api --resource products
   dogsled pipeline --integration shop_api --dest duckdb --db-path data.duckdb --batch --batch-format jsonl --batch-size 100 --log-format json
   dogsled query 'SELECT count(*) AS n FROM orders' --db-path data.duckdb
   ```

   Expect 20 products, 500 orders and 30 customers: 550 extracted records across
   three streams, five pages for orders, JSONL batch files and zero failed streams.
   The query returns `n = 500`.

4. Select just one resource into a separate database:

   ```bash
   dogsled pipeline --integration shop_api --resource products --dest duckdb --db-path selected.duckdb --log-format json
   ```

   Expect one stream and 20 products. Stop the API with Ctrl-C.
