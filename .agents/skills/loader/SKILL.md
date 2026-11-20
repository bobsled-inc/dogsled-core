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

# Dogsled loader — Data Loading Reference

Load Dogsled protocol data into analytical stores.

## Quick Reference

**Prefer `dogsled pipeline`** for extract+load workflows — it handles subprocess orchestration automatically:

```bash
# Extract + load into local parquet files
dogsled pipeline --integration github --format parquet

# Extract + load into DuckDB
dogsled pipeline --integration github --dest duckdb --db-path ./data.duckdb

# Extract + load into BigQuery
dogsled pipeline --integration vantage costs \
  --dest bigquery \
  --project-id my-project \
  --dataset-id raw \
  --key-filename ~/path/to/key.json \
  --table-prefix vantage__

# Extract + load into GCS
dogsled pipeline --integration github --dest gcs --gcs-bucket my-bucket --format parquet
```

For standalone loader operations (checking connectivity, querying loaded data):

```bash
# Check destination connectivity
dogsled load check --dest duckdb --db-path ./data.duckdb
dogsled load check --dest bigquery --project-id my-project --dataset-id raw

# Query loaded data
dogsled load query "SELECT * FROM repos LIMIT 10" --db-path ./data.duckdb
dogsled load query "SELECT * FROM raw.repos LIMIT 10" --dest bigquery --project-id my-project --dataset-id raw
```

For advanced use cases, you can pipe extract and load manually:

```bash
dogsled extract run --integration github repos | dogsled load run --dest duckdb --db-path ./data.duckdb
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
2. Loaded into `_dogsled_stg_<stream>` staging table
3. `MERGE INTO <stream> USING <staging>` on `key_properties`
4. Matched rows: UPDATE all non-key columns
5. Unmatched rows: INSERT
6. Staging table dropped

## System Columns

The loader automatically adds these columns:

| Column               | Source                     | Description                                     |
| -------------------- | -------------------------- | ----------------------------------------------- |
| `_time_extracted`    | Extractor (RECORD message) | When the record was extracted from the API      |
| `_dogsled_loaded_at` | Loader (at merge time)     | When the record was loaded into the destination |

## Output Formats (File Destinations)

| Format  | Flag               | Extension  | Notes                             |
| ------- | ------------------ | ---------- | --------------------------------- |
| JSONL   | `--format jsonl`   | `.jsonl`   | Default, human-readable           |
| CSV     | `--format csv`     | `.csv`     | Tabular, spreadsheet-compatible   |
| Parquet | `--format parquet` | `.parquet` | Columnar, efficient for analytics |
| Arrow   | `--format arrow`   | `.arrow`   | IPC format, zero-copy reads       |

All formats are produced via DuckDB `COPY` (except Arrow which uses IPC buffers). Arrays and objects are serialized as VARCHAR for cross-format portability.

### Folders (optional)

`local`, `gcs` and `s3` destinations write rows to `<prefix><stream>/<stream>-<n>.<ext>`, and each copied file (a `FILE` message) to `<prefix><stream>/<relative_key>`. One optional setting changes both. It is off by default, and without it the files are exactly the same as before.

| `dogsled.yml` field | `load run` flag             | Effect                                                                                                                                                                                                                               |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stream_subfolder`  | `--stream-subfolder <path>` | Adds a folder inside each stream's folder: `orders/<path>/orders-0.parquet`, or `drops/<path>/<relative_key>` for a copied file. A relative path of letters, digits, dots, dashes, equals signs and underscores, with no `.` or `..` |

### Copied files

A file Resource with `source.kind: copy` sends one `FILE` message per file, not rows. A file destination writes the message's temp file as it is, with no content type, to `<prefix><stream>/[<stream_subfolder>/]<relative_key>`, then deletes the temp file. `--format` does not change a copied file. Only `local`, `s3` and `gcs` take a copy, and database destinations fail on `FILE`.

A copy takes one destination. A `dogsled.yml` pipeline with a copy Resource and more than one destination is refused when the project is validated, and a pipeline with one destination works. `--destinations-json` is refused for any list, even one entry, when the extractor starts.

A copy to S3 or GCS stores `dogsled-source` (the file's key in the source) and `dogsled-source-modified` as metadata on each file. An `s3` or `gcs` destination can add its own entries with `object_metadata` (`--object-metadata '<json object>'`): text values, stored percent-encoded. The loader takes them as text and expands no `$NAME` in them. Keys use lowercase letters, digits and dashes, and the whole is at most 2,048 bytes, counting 11 more for each key. The loader leaves `dogsled-source` off a file whose key would not fit, with a warning. A `local` destination keeps none.

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
dogsled extract run --integration github repos | dogsled load run --dest duckdb --db-path ./data.duckdb --dry-run
```

Shows the strategy table (stream name, load strategy, key properties) without writing data.

A dry run cannot preview a copy. It fails on a `FILE` message, because a dry run never deletes the temp file and the extractor would wait for it. Load a copy into a disposable `local` folder instead.
