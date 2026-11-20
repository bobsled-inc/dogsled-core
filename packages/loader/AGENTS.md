# @bobsled-inc/loader — Agent Guide

<!-- last-reviewed: 2026-11-12 -->

Reads Dogsled protocol messages from stdin and loads data into destinations (files or databases).

---

## Adding a New File Destination

Use the `/add-file-destination` skill for the full workflow. See root AGENTS.md Builder's Skill Index.

Condensed checklist:

1. Implement `FileDestination` in `runtime/destinations/<name>.ts` (DI interface, dynamic SDK import, lazy caching, `normalizeDestinationPath()`, `publish()` returns URI)
2. Add Zod config variant to `schemas/config.ts` (discriminated union on `dest`)
3. Add to factory in `runtime/destinations/index.ts` (`DestinationKind`, `DestinationConfig`, `createDestination()`)
4. Add check function in `commands/check.ts` (DI pattern with `CheckDependencies`)
5. Write tests in `tests/unit/destinations/<name>.test.ts` (mock client, validation, traversal rejection)

**Reference impl**: `s3.ts` (85 lines), `local.ts`, `gcs.ts`

## Adding a New Database Destination

Use the `/add-database-destination` skill for the full workflow. See root AGENTS.md Builder's Skill Index.

Condensed checklist:

1. Implement `DatabaseDestination` in `runtime/destinations/<name>.ts` (all 6 interface methods: `initialize`, `ensureTable`, `loadAndFinalize`, `close`, `getTruncatedTables`, `setTruncatedTables`)
2. Add type mapping function (protocol `ColumnType` to target DB types)
3. Add Zod config variant to `schemas/config.ts` (discriminated union on `dest`)
4. Wire into factory in `commands/run.ts` (`isDatabaseDestConfig`, `createDefaultDatabaseDestination`)
5. Add check function in `commands/check.ts` (connect + `SELECT 1`)
6. Write tests in `tests/unit/destinations/<name>.test.ts` (all 3 strategies, schema evolution, staging cleanup)

**Reference impls**: `duckdb.ts` (simpler), `bigquery.ts` (complex)

## Key Behaviors

- **Two loader paths**: `runFileLoader` (local/gcs/s3) and `runDatabaseLoader` (duckdb/bigquery)
- **System columns**: `_time_extracted` (set by extractor), `_dogsled_loaded_at` (set by loader at merge time). Constants in `database.ts` as `SYSTEM_COLUMNS`
- **Load strategies**: append (insert), merge (staging + MERGE by key_properties), full_refresh (truncate-on-first-flush)
- **Per-stream strategy resolution**: CLI `--load-strategy` overrides all > SCHEMA `load_strategy` per-stream > fallback `append`
- **Schema evolution**: New columns auto-added via ALTER TABLE; type conflicts error
- **Staging table pattern**: Prefix `_dogsled_stg_` unified across all destinations
- **RECORD enrichment**: `_time_extracted` added in `run.ts` before buffering
- **BATCH passthrough**: Points at extractor-created files; skips JS-level parsing
- **STATE forwarding**: Forwarded to stdout after flushing buffered records
- **Config validation**: Zod discriminated union on `dest` field. `loadStrategy` is optional (per-stream from protocol is the normal path)
- **Error handling**: `handleRunError` uses `process.exitCode` instead of `process.exit()` for clean event loop drain
- **RecordBuffer**: Sanitizes stream names (non-alphanumeric replaced) for safe temp file paths
- **Temp dir**: Caller-provided `tempRootDir` is never deleted by the loader
- **Vector contract**: Protocol `vector` columns require a `dimension`; dimension changes should be treated as schema conflicts, not silent evolutions

## Database Destination Notes

- **DuckDB**: SQL built with `read_json()` typed columns; staging tables use TEMP tables
- **DuckDB / DuckLake vectors**: `vector` columns map to fixed-length `FLOAT[N]`
- **BigQuery**: Load via `table.load()` API; merge via staging table + MERGE matched on key columns only. Never bound the target by the staging batch's partition dates: a key's partition value can change between loads, and the hidden row is inserted again as a duplicate
- **BigQuery vectors**: `vector` columns map to repeated `FLOAT64`
- **BigQuery auto-optimization**: Tables partitioned by `DATE(partition_by | timestamp cursor_field | _time_extracted)`, clustered by cursor_field + key_properties (up to 4). Clustering updated via `table.setMetadata()` (not ALTER TABLE)
- **BigQuery type normalization**: `normalizeBqType()` maps legacy aliases (`INTEGER` -> `INT64`, etc.) before schema comparison
- **BigQuery `schemaUpdateOptions`**: `ALLOW_FIELD_ADDITION` only valid with `WRITE_APPEND`, not `WRITE_TRUNCATE`
- **Snowflake vectors**: `vector` columns require schema-aware mapping to `VECTOR(FLOAT, N)`
- **Postgres / pgvector**: `vector` columns map to `vector(N)`; standard Postgres destinations must ensure the `pgvector` extension before loading
- **ClickHouse**: vectors map to `Array(Float32)`; merge uses a staging table plus a winners table (`LIMIT 1 BY` deduplication and a `>=` time guard) and synchronous mutations
- **Turbopuffer**: document IDs are strings derived from key columns, merge is an upsert, and `full_refresh` calls `deleteAll()` once per namespace
- **Elasticsearch**: vector mappings must include explicit `dims`, preferably from `SchemaColumn.dimension`
- **Chroma**: expects an `embedding` or `vector` column and treats the rest of the record as metadata/document fields
- **Dynamic imports**: BigQuery and GCS SDKs imported dynamically (optional peer deps)
- **DI interfaces**: `BigQueryClientLike`, `DuckDbDatabaseLike` enable unit testing without real services
- **Both destinations track truncated tables** per-instance for full_refresh idempotency

## Unsupported Vector Destinations

These destinations should fail fast with user-facing validation errors when `vector` columns appear:

- MySQL
- SQLite
- MSSQL
- Databricks

## File Destination Notes

- **local**: Moves converted file into output directory
- **gcs**: Dynamic import of `@google-cloud/storage` (optional peer dep)
- **Path safety**: Destination paths normalized and reject traversal outside configured root/prefix
- **FILE copy**: `runFileLoader` writes each FILE's temp file as it is with `publish(..., { copy: true })`, which sets no content type, then deletes it, because the extractor counts a deleted file as written. A failed write ends the run and the loader stops reading. Database destinations and `--dry-run` fail on FILE. The rules for keys and temp files are in `docs/reference/protocol.md`
- **Stream subfolder**: Opt-in `streamSubfolder` (`--stream-subfolder`, `stream_subfolder`) places files at `<stream>/<subfolder>/<stream>-<n>.<ext>`. Its rule is `isValidStreamSubfolder` in `@bobsled-inc/protocol`, shared with the `dogsled.yml` schema. Unset, the path is exactly `<stream>/<stream>-<n>.<ext>`

## Format Notes

- `jsonl`, `csv`, `parquet` written with DuckDB `COPY`
- `arrow` uses `arrowIPCAll()` and writes IPC buffers to disk
- Arrays and objects mapped to `VARCHAR` for portability across formats

## Commands

| Command | Purpose                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------- |
| `run`   | Main loader — reads protocol, routes to file or database loader. `--dry-run` previews strategy table |
| `check` | Validates destination connectivity (DuckDB writable, BigQuery dataset exists, GCS bucket exists)     |
| `query` | Runs SQL against DuckDB or BigQuery (`--dest duckdb\|bigquery`), outputs TSV                         |

## Development

```bash
pnpm --filter @bobsled-inc/loader build
pnpm --filter @bobsled-inc/loader typecheck
pnpm --filter @bobsled-inc/loader lint
pnpm --filter @bobsled-inc/loader test:unit
```
