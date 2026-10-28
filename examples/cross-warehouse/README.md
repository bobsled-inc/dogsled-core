# Cross-Warehouse Publish

This example shows Model Spec models that read from Databricks and Snowflake, then publish into Databricks with `publish: databricks`.

```sh
cp secrets.example.yml secrets.yml
dogsled model validate --integration databricks
dogsled model run customer_event_revenue --integration databricks --secrets secrets.yml --dry-run
```

Fill `secrets.yml` or export the same variables in your shell and omit `--secrets` before running without `--dry-run`.

## Models

- `customer_event_revenue` - full table publish.
- `customer_event_revenue_incremental` - incremental merge publish with `cursor_field: event_ts` source pruning after the first successful run.
- `customer_event_revenue_snapshot` - SCD-2 snapshot publish tracking enrichment changes.

## Staging

The integration YAMLs include `cross_warehouse_staging.uri: ${{ env.XWH_SHARED_STAGING_URI }}` to demonstrate the native UNLOAD substrate. Use a shared object-store prefix that the source warehouse can write and the destination can read. Remove those blocks to force the streaming fallback.

Native UNLOAD writes Parquet to the staging URI. Streaming fallback writes bounded temp chunks under `$TMPDIR/dogsled-xwh-<model>-*`, then loads destination-side staging tables before the destination evaluates the model SELECT.
