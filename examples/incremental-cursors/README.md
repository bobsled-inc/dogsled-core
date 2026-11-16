# Incremental cursors

Prerequisites: Node.js 24+, an installed `dogsled` CLI and OpenSSL. Run the automated walkthrough from a built checkout with `pnpm e2e:incremental-cursors`.

1. From the checkout root, start the fictional HTTPS API in one terminal:

   ```bash
   node scripts/e2e/mock-api.mjs incremental-cursors
   ```

   Copy the five printed `export` commands into a second terminal. They select a
   loopback URL, a synthetic local token, the temporary certificate and the explicit
   private-host opt-in. Keep the server running until the walkthrough ends.

2. In that second terminal, copy the committed project and enter it:

   ```bash
   cp -R examples/incremental-cursors /tmp/bobsled-incremental-cursors
   cd /tmp/bobsled-incremental-cursors
   ```

3. Load the first 100 events and inspect the persisted cursor:

   ```bash
   dogsled pipeline --integration shop_api --resource events --dest duckdb --db-path data.duckdb --log-format json
   cat .extractor/state.json
   ```

   Expect 100 extracted records and `cursor_value: "100"` under `shop_api/events`.
   The committed resource declares the integer `id` cursor and append strategy.

4. Add the next 50 fictional events to the running server, then repeat the same load:

   ```bash
   curl --cacert "$NODE_EXTRA_CA_CERTS" -X POST -H 'Authorization: Bearer showcase-local-key' "$SHOWCASE_API_URL/advance"
   dogsled pipeline --integration shop_api --resource events --dest duckdb --db-path data.duckdb --log-format json
   dogsled query 'SELECT count(*) AS n, count(DISTINCT id) AS unique_ids FROM events' --db-path data.duckdb
   ```

   Expect `advanced: true`, then 50 extracted records. Both query values are 150.
   The second extraction sends `since=100`; it does not fetch the first 100 again.
   Stop the API with Ctrl-C. Restart from a fresh copy to repeat the walkthrough.
