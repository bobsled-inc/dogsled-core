# @bobsled-inc/protocol

This workspace is bundled inside `@bobsled-inc/dogsled` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

Dogsled protocol message types shared between `@bobsled-inc/extractor` (producer) and `@bobsled-inc/loader` (consumer).

This package is the leaf dependency of the Dogsled data pipeline — zero external dependencies.

## Message Protocol

Data flows as newline-delimited JSON between the extractor (stdout) and loader (stdin). Control messages go to stderr.

### Data Messages (stdout)

#### SCHEMA

Declares the structure of a stream before any records are sent.

```json
{
  "_v": 1,
  "type": "SCHEMA",
  "stream": "repos",
  "schema": {
    "columns": [
      { "name": "id", "type": "integer", "primary_key": true },
      { "name": "name", "type": "string" },
      { "name": "stargazers_count", "type": "integer" },
      { "name": "created_at", "type": "timestamp" }
    ]
  },
  "key_properties": ["id"],
  "load_strategy": "merge",
  "cursor_field": "updated_at"
}
```

#### RECORD

A single data record for a stream.

```json
{
  "_v": 1,
  "type": "RECORD",
  "stream": "repos",
  "record": {
    "id": 1,
    "name": "dogsled",
    "stargazers_count": 42,
    "created_at": "2024-01-15T00:00:00Z"
  },
  "time_extracted": "2025-03-31T12:00:00Z"
}
```

#### STATE

Checkpoint for incremental extraction. Emitted after processing a batch of records.

```json
{
  "_v": 1,
  "type": "STATE",
  "stream": "repos",
  "value": {
    "cursor_field": "updated_at",
    "cursor_value": "2025-03-31T12:00:00Z",
    "record_count": 150
  }
}
```

#### BATCH

Pointer to pre-created batch files (for large datasets). JSONL remains the default; Parquet is opt-in.

```json
{
  "_v": 1,
  "type": "BATCH",
  "stream": "repos",
  "encoding": { "format": "parquet" },
  "manifest": ["file:///tmp/batch/repos/001.parquet", "file:///tmp/batch/repos/002.parquet"]
}
```

### Control Messages (stderr)

#### LOG

```json
{
  "_v": 1,
  "type": "LOG",
  "level": "info",
  "message": "Extracting repos page 3",
  "time": "2025-03-31T12:00:01Z"
}
```

#### METRIC

```json
{
  "_v": 1,
  "type": "METRIC",
  "stream": "repos",
  "metrics": { "records_emitted": 150, "api_calls": 3, "duration_ms": 1200 },
  "time": "2025-03-31T12:00:02Z"
}
```

## Column Types

| Type        | Description                     |
| ----------- | ------------------------------- |
| `string`    | Text                            |
| `integer`   | Whole numbers                   |
| `number`    | Floating point                  |
| `boolean`   | True/false                      |
| `timestamp` | ISO 8601 datetime               |
| `array`     | JSON array                      |
| `object`    | JSON object                     |
| `vector`    | Fixed-dimension embedding array |

## Vector Columns

Vector columns are used for embedding workflows and must include a `dimension` on the `SchemaColumn`.

Example:

```json
{
  "name": "body_embedding",
  "type": "vector",
  "dimension": 1536
}
```

The optional `embedded_from` of a vector column records the source `column`, the `provider` and
`model` that produced it, and an optional `dimension`, which must equal the column's.

Vector columns are typically added by `@bobsled-inc/embedder` or `dogsled embed`, then consumed by vector-aware loader destinations.

## Load Strategies

| Strategy       | Description                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `append`       | Insert all records (duplicates possible)                                     |
| `merge`        | Upsert on `key_properties` (deduplicated)                                    |
| `full_refresh` | Replace the stream's rows; destination schema repair is destination-specific |

Schema evolution is controlled separately with the optional `schema_behavior`
field. `evolve` adds compatible columns, while `strict` and `freeze` apply the
destination contract for drift. Snowflake's default `evolve` behavior may
replace a drifted table during `full_refresh`; this is a destination behavior,
not a protocol schema mode.

## Exit Codes

| Code | Constant          | Meaning                 |
| ---- | ----------------- | ----------------------- |
| 0    | `EXIT_SUCCESS`    | Success                 |
| 1    | `EXIT_ERROR`      | Runtime/system error    |
| 2    | `EXIT_VALIDATION` | User input/schema error |
| 3    | `EXIT_DRIFT`      | Changes detected (plan) |

## Usage

```typescript
import type { SchemaMessage, RecordMessage, StdoutMessage } from '@bobsled-inc/protocol';
import { CommandError, EXIT_VALIDATION, isColumnType, isLoadStrategy } from '@bobsled-inc/protocol';

// Type guard usage
if (isColumnType(value)) {
  // value is narrowed to ColumnType
}

// Error handling
throw new CommandError('Invalid configuration', EXIT_VALIDATION);
```

## Development

```bash
pnpm --filter @bobsled-inc/protocol build
pnpm --filter @bobsled-inc/protocol typecheck
pnpm --filter @bobsled-inc/protocol test
```

## License

[MIT](../../LICENSE)
