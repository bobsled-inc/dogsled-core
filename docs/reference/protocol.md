# Protocol

Extractors and loaders exchange newline-delimited JSON. Data messages go to
standard output and control messages to standard error, so you can pipe, capture
or replay an extraction. Every message has `"_v": 1` and a `type`.

These examples are real output from `dogsled extract run`.

## Data messages (standard output)

`SCHEMA` declares a stream's columns, primary key and load strategy before its
records:

```json
{
  "_v": 1,
  "type": "SCHEMA",
  "stream": "orders",
  "schema": {
    "columns": [
      { "name": "order_id", "type": "integer", "primary_key": true },
      { "name": "customer", "type": "string" },
      { "name": "amount", "type": "number" },
      { "name": "ordered_at", "type": "timestamp" }
    ]
  },
  "key_properties": ["order_id"],
  "load_strategy": "full_refresh"
}
```

`RECORD` is one row:

```json
{
  "_v": 1,
  "type": "RECORD",
  "stream": "orders",
  "record": {
    "order_id": 1,
    "customer": "ada",
    "amount": 120.5,
    "ordered_at": "2026-01-03T00:00:00.000Z"
  },
  "time_extracted": "2026-10-22T00:19:34.543Z"
}
```

`STATE` records where the extraction stopped. Incremental streams carry the cursor:

```json
{
  "_v": 1,
  "type": "STATE",
  "stream": "tickets",
  "value": {
    "record_count": 7,
    "cursor_field": "updated_at",
    "cursor_type": "timestamp",
    "cursor_value": "2026-01-07T00:00:00.000Z",
    "last_run_at": "2026-10-21T23:13:46.661Z"
  }
}
```

`BATCH` points at files of records instead of inlining them, for large extractions
(`extract run --batch`):

```json
{
  "_v": 1,
  "type": "BATCH",
  "stream": "users",
  "encoding": { "format": "jsonl" },
  "manifest": ["file:///home/me/shop/batch/users/users-0.jsonl"]
}
```

`REPLACE` replaces a slice of a stream's rows. The loader deletes the rows whose
`key` column equals one of `values`, then writes the rows that follow for them. It
also deletes them when no rows follow. Incremental document Resources send one per
changed file and stream, so a file that now has fewer chunks leaves none behind:

```json
{
  "_v": 1,
  "type": "REPLACE",
  "stream": "handbook__chunks",
  "key": "document_id",
  "values": ["4b1c5e0f9a2d7c3b8e6f1a0d9c2b7e4f5a3c8d1e6b0f9a2c7d4e1b8f3a6c5d0e"]
}
```

A REPLACE follows the stream's `SCHEMA` and comes before any `RECORD` of its
values. `key` must be a column of the stream, and `values` holds 1 to 1,000
strings. Table destinations apply it. File destinations write each run's rows as
new files and ignore it.

## Control messages (standard error)

`LOG` carries a level (`debug`, `info`, `warn`, `error`) and a message; `METRIC`
carries counters such as records emitted and API calls:

```json
{
  "_v": 1,
  "type": "METRIC",
  "stream": "orders",
  "metrics": {
    "files_listed": 1,
    "files_skipped": 0,
    "files_processed": 1,
    "bytes_downloaded": 159,
    "records_emitted": 5
  },
  "time": "2026-10-21T23:03:45.332Z"
}
```

`--log-format pretty` prints the same information for people.

## Column types

`string`, `integer`, `number`, `boolean`, `timestamp`, `array`, `object` and
`vector` (added by `dogsled embed`).

## Load strategies

`append`, `merge` (upsert on the primary key) and `full_refresh`. See
[Load data](../guides/load-data.md#load-strategies).

## Exit codes

`0` success, `1` runtime failure, `2` validation failure, `3` detected drift (for
example, `dogsled model seed diff` when the table and the CSV differ).
