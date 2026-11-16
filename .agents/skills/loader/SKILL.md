---
name: loader
description: Load extracted data into DuckDB, BigQuery, GCS, or local files. Use when configuring data loading, choosing destinations, debugging load failures, or working with load strategies.
exposed: true
triggers:
  - load data
  - load to duckdb
  - load to bigquery
  - load to gcs
  - load destination
  - configure loader
  - debug load failure
  - set load strategy
  - append merge full refresh
---

# Bobsled Core loader — Data Loading Reference

Load Bobsled Core protocol data into analytical stores.

## Quick Reference

**Prefer `bobsled pipeline`** for extract+load workflows — it handles subprocess orchestration automatically:

```bash
# Extract + load into local parquet files
bobsled pipeline --integration github --format parquet

# Extract + load into DuckDB
bobsled pipeline --integration github --dest duckdb --db-path ./data.duckdb

# Extract + load into BigQuery
bobsled pipeline --integration vantage costs \
  --dest bigquery \
  --project-id my-project \
  --dataset-id raw \
  --key-filename ~/path/to/key.json \
  --table-prefix vantage__

# Extract + load into GCS
bobsled pipeline --integration github --dest gcs --gcs-bucket my-bucket --format parquet
```

For standalone loader operations (checking connectivity, querying loaded data):

```bash
# Check destination connectivity
bobsled load check --dest duckdb --db-path ./data.duckdb
bobsled load check --dest bigquery --project-id my-project --dataset-id raw

# Query loaded data
bobsled load query "SELECT * FROM repos LIMIT 10" --db-path ./data.duckdb
bobsled load query "SELECT * FROM raw.repos LIMIT 10" --dest bigquery --project-id my-project --dataset-id raw
```

For advanced use cases, you can pipe extract and load manually:

```bash
bobsled extract run --integration github repos | bobsled load run --dest duckdb --db-path ./data.duckdb
```

## Destinations

| Destination | Flag              | Required Options               | Notes                             |
| ----------- | ----------------- | ------------------------------ | --------------------------------- |
| `local`     | `--dest local`    | `--format`, `--output-dir`     | Writes files to local filesystem  |
| `gcs`       | `--dest gcs`      | `--format`, `--gcs-bucket`     | Publishes to Google Cloud Storage |
| `duckdb`    | `--dest duckdb`   | `--db-path`                    | Loads into DuckDB database        |
| `bigquery`  | `--dest bigquery` | `--project-id`, `--dataset-id` | Loads into BigQuery dataset       |

## Load Strategies

The loader resolves strategy per-stream with this priority:

1. CLI `--load-strategy` flag (overrides all streams)
2. `load_strategy` field in SCHEMA message (set by extractor per-stream)
3. Default: `append`

| Strategy       | Behavior                                               | When to Use                                |
| -------------- | ------------------------------------------------------ | ------------------------------------------ |
| `append`       | Insert all records (duplicates possible)               | Event/log data, append-only streams        |
| `merge`        | Upsert on `key_properties` using staging table + MERGE | Most API resources (repos, issues, users)  |
| `full_refresh` | Truncate on first flush, then insert                   | Small reference tables, complete snapshots |

### Merge Strategy Detail

1. Records buffered to temp JSONL file
2. Loaded into `_bobsled_stg_<stream>` staging table
3. `MERGE INTO <stream> USING <staging>` on `key_properties`
4. Matched rows: UPDATE all non-key columns
5. Unmatched rows: INSERT
6. Staging table dropped

## System Columns

The loader automatically adds these columns:

| Column               | Source                     | Description                                     |
| -------------------- | -------------------------- | ----------------------------------------------- |
| `_time_extracted`    | Extractor (RECORD message) | When the record was extracted from the API      |
| `_bobsled_loaded_at` | Loader (at merge time)     | When the record was loaded into the destination |

## Output Formats (File Destinations)

| Format  | Flag               | Extension  | Notes                             |
| ------- | ------------------ | ---------- | --------------------------------- |
| JSONL   | `--format jsonl`   | `.jsonl`   | Default, human-readable           |
| CSV     | `--format csv`     | `.csv`     | Tabular, spreadsheet-compatible   |
| Parquet | `--format parquet` | `.parquet` | Columnar, efficient for analytics |
| Arrow   | `--format arrow`   | `.arrow`   | IPC format, zero-copy reads       |

All formats are produced via DuckDB `COPY` (except Arrow which uses IPC buffers). Arrays and objects are serialized as VARCHAR for cross-format portability.

### Folders (optional)

`local`, `gcs` and `s3` destinations write `<prefix><stream>/<stream>-<n>.<ext>`. One optional setting changes that. It is off by default, and without it the files are exactly the same as before.

| `bobsled.yml` field | `load run` flag             | Effect                                                                                                                                                                           |
| ------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream_subfolder`  | `--stream-subfolder <path>` | Adds a folder inside each stream's folder: `orders/<path>/orders-0.parquet`. A relative path of letters, digits, dots, dashes, equals signs and underscores, with no `.` or `..` |

## Schema Evolution

- **New columns**: Automatically added via `ALTER TABLE ADD COLUMN`
- **Type conflicts**: Error (e.g., changing `string` to `integer` is rejected)
- **Missing columns**: Filled with NULL for new records
- **Snowflake full refresh**: With the default `evolve` schema behavior, an
  effective `full_refresh` strategy replaces a drifted table before loading,
  preserves grants with `COPY GRANTS`, and reapplies clustering. `strict` fails
  on drift and `freeze` leaves the physical schema unchanged. Ordinary
  `full_refresh` on other destinations retains their destination-specific
  behavior.

## BigQuery Auto-Optimization

When loading into BigQuery, the loader automatically:

- Partitions by `DATE(_time_extracted)` for efficient time-range queries
- Clusters by `cursor_field` + `key_properties` (up to 4 columns)
- Uses `ALLOW_FIELD_ADDITION` for schema evolution (append mode only)

## Troubleshooting

### Common Issues

**"No SCHEMA message received"** — Extractor must emit SCHEMA before any RECORDs. Check extractor output.

**"Type conflict for column X"** — A column's type changed between runs. For
Snowflake, run a complete extract with the default `schema_behavior: evolve`
and `load_strategy: full_refresh`; `strict` intentionally fails and `freeze`
does not alter the physical schema. For other destinations, reconcile the
table through the destination's migration tooling.

**"Cannot find module @google-cloud/bigquery"** — BigQuery and GCS are optional peer deps. Install: `pnpm add @google-cloud/bigquery @google-cloud/storage`

**DuckDB locking** — DuckDB only allows one writer. Close other connections before loading.

### Dry Run

Preview what the loader would do without actually loading:

```bash
bobsled extract run --integration github repos | bobsled load run --dest duckdb --db-path ./data.duckdb --dry-run
```

Shows the strategy table (stream name, load strategy, key properties) without writing data.
