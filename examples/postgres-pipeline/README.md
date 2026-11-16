# Postgres pipeline and models

Prerequisites: Node.js 24+, an installed `dogsled` CLI and OpenSSL. Run the automated walkthrough from a built checkout with `pnpm e2e:postgres-pipeline`. Docker is also required.

1. From the checkout root, start the fictional HTTPS API in one terminal:

   ```bash
   node scripts/e2e/mock-api.mjs postgres-pipeline
   ```

   Copy the five printed `export` commands into a second terminal. They select a
   loopback URL, a synthetic local token, the temporary certificate and the explicit
   private-host opt-in. Keep the server running until the walkthrough ends.

2. In that second terminal, copy the committed project and enter it:

   ```bash
   cp -R examples/postgres-pipeline /tmp/bobsled-postgres-pipeline
   cd /tmp/bobsled-postgres-pipeline
   ```

3. Start and configure the disposable Postgres service:

   ```bash
   docker compose up -d --wait
   export SHOWCASE_PG_PORT=$(docker compose port postgres 5432 | sed 's/.*://')
   export SHOWCASE_PG_PASSWORD=unused-local-only
   node configure-postgres.mjs
   docker compose exec postgres psql -U postgres -d showcase -c 'CREATE SCHEMA IF NOT EXISTS pipeline'
   ```

4. Load the committed API resources with the same flags as the automated test:

   ```bash
   dogsled pipeline --integration shop_api --dest postgres --postgres-host 127.0.0.1 --postgres-port "$SHOWCASE_PG_PORT" --postgres-database showcase --postgres-user postgres --postgres-schema pipeline --postgres-password '$SHOWCASE_PG_PASSWORD' --log-format json
   docker compose exec postgres psql -U postgres -d showcase -c 'SELECT count(*) FROM pipeline.staff; SELECT count(*) FROM pipeline.departments'
   ```

   Expect 200 staff and 10 departments, both with `_bobsled_loaded_at`, and no
   retired system-column prefixes. All records are synthetic.

5. Use the committed integration, sources, models and expectation runner:

   ```bash
   npm install @bobsled-inc/bobsled-core pg
   dogsled model validate --integration local_pg
   dogsled model run --integration local_pg --json
   dogsled model expect run --integration local_pg --runner ./runner.mjs --json
   docker compose exec postgres psql -U postgres -d showcase -c 'SELECT count(*), sum(headcount) FROM pipeline.department_headcount; SELECT count(*) FROM pipeline.salary_band'
   ```

   The local package install lets `runner.mjs` resolve its public connection
   export. For a pre-release checkout, install your packed CLI tarball in place
   of the package name. Expect ten department rows totalling 200 people,
   200 salary-band rows and passing expectations. Stop the API with Ctrl-C, then
   run `docker compose down --volumes`.
