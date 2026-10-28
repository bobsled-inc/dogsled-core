# Semantic metadata and verified queries

This example checks two metrics and one relationship over the fictional shop from the models walkthrough,
and executes two verified queries through the supported API-backed VQ CLI. The
warehouse metadata and API query execution are separate checks: metric definitions
are loaded and validated, not computed by a metric CLI.

1. Run the [models walkthrough](../models-full/README.md), then copy this directory's
   `metrics/` and `relationships/` into that project and validate it:

   ```bash
   dogsled model validate --integration local_duckdb
   ```

   The automated `pnpm e2e:semantic-layer-vq` prepares that same shop, copies the
   definitions, and verifies two metrics and one relationship with valid references.

2. To run the queries by hand, start the fictional HTTPS API from the checkout root
   in another terminal:

   ```bash
   node scripts/e2e/mock-api.mjs semantic-layer-vq
   ```

   This serves the four committed CSV datasets from the models walkthrough. Copy its five printed `export`
   commands into your query terminal. They select loopback, a synthetic token, the
   temporary TLS certificate and the explicit private-host opt-in.

3. From the checkout root in that query terminal, copy the complete API project:

   ```bash
   cp -R examples/semantic-layer-vq/api-query /tmp/dogsled-semantic-queries
   cd /tmp/dogsled-semantic-queries
   dogsled vq revenue_by_customer --param start_date=2025-01-01 --param end_date=2025-12-31
   dogsled vq top_products --param category=electronics
   ```

   Expect 50 customer rows totalling 50500 revenue units and four electronics
   products. The committed `sources/`, `resources/`, `integrations/` and `vqs/`
   declare the complete query surface. SQL parameter placeholders are `{name}`;
   Dogsled validates and escapes their values.

4. Check parameter validation, then stop the mock API with Ctrl-C:

   ```bash
   dogsled vq revenue_by_customer --param start_date=not-a-date --param end_date=2025-12-31
   ```

   Expect exit code 2 and a `YYYY-MM-DD date` diagnostic before query execution.

Known limitation: the VQ CLI supports API source materialization, rather than
warehouse-backed model execution. It has no `vq list` or `vq validate` commands.
The automated test also checks the public VQ loader and schema, and serves the
actual seeded warehouse rows through the same local API implementation.
