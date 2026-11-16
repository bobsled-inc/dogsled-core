# Secret redaction

Prerequisites: Node.js 24+, an installed `bobsled` CLI and OpenSSL. Run the automated walkthrough from a built checkout with `pnpm e2e:secret-redaction`.

1. From the checkout root, start the fictional HTTPS API in one terminal:

   ```bash
   node scripts/e2e/mock-api.mjs secret-redaction
   ```

   Copy the five printed `export` commands into a second terminal. They select a
   loopback URL, a synthetic local token, the temporary certificate and the explicit
   private-host opt-in. Keep the server running until the walkthrough ends.

2. In that second terminal, copy the committed project and enter it:

   ```bash
   cp -R examples/secret-redaction /tmp/bobsled-secret-redaction
   cd /tmp/bobsled-secret-redaction
   ```

3. Load one fictional event using environment-based authentication:

   ```bash
   bobsled pipeline --integration shop_api --resource events --dest duckdb --db-path data.duckdb --verbose --log-format json
   bobsled query 'SELECT * FROM events' --db-path data.duckdb
   ```

   Expect one row. The integration stores the environment-variable reference,
   never the resolved token. Stop the API with Ctrl-C.

4. Run `pnpm e2e:secret-redaction` from the checkout root for the adversarial check.
   It replaces the local token and a failing Postgres password with random
   synthetic canaries, exercises success and failure, then scans stdout, stderr,
   state, config and every persisted file as bytes (including DuckDB and WAL files).
   Neither canary may appear. No real credentials are used.
