# @bobsled-inc/protocol — Agent Guide

<!-- last-reviewed: 2026-08-28 -->

Shared Dogsled protocol message types plus metadata-safe configuration contracts.
Packages that only validate manifests or configuration should depend on this
package instead of a connection runtime.

---

## What This Package Exports

| Export                                           | When to use it                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `SchemaMessage`                                  | Emit before records for a stream — declares columns, key properties, load_strategy, cursor_field   |
| `RecordMessage`                                  | Emit one per extracted row                                                                         |
| `StateMessage`                                   | Emit after flushing records — incremental bookmark for a stream                                    |
| `BatchMessage`                                   | Reference extractor-created JSONL or Parquet files (skip JS-level parsing)                         |
| `ReplaceMessage`                                 | Replace a slice of a stream's rows (`key` in `values`) before the slice's new rows are written     |
| `LogMessage`                                     | Structured log entry (stderr only)                                                                 |
| `MetricMessage`                                  | Extraction run metrics (stderr only)                                                               |
| `StdoutMessage`                                  | Union of SCHEMA, RECORD, STATE, BATCH, LINEAGE, REPLACE — data channel                             |
| `StderrMessage`                                  | Union of LOG, METRIC — control channel                                                             |
| `SchemaColumn`                                   | Column definition (name, type, optional `primary_key`; vector columns also require `dimension`)    |
| `ColumnType`                                     | `'string' \| 'integer' \| 'number' \| 'boolean' \| 'timestamp' \| 'array' \| 'object' \| 'vector'` |
| `COLUMN_TYPES` / `COLUMN_TYPE_SET`               | Canonical tuple and O(1) membership set                                                            |
| `LoadStrategy`                                   | `'append' \| 'merge' \| 'full_refresh'`                                                            |
| `LOAD_STRATEGIES` / `LOAD_STRATEGY_SET`          | Canonical tuple and O(1) membership set                                                            |
| `isLoadStrategy`                                 | Type guard narrowing string to `LoadStrategy`                                                      |
| `BatchEncoding`                                  | Encoding metadata for batch files (format + optional compression)                                  |
| `CommandError`                                   | CLI error class with `exitCode` (default 2) — use for all user-facing errors                       |
| `EnvPlaceholderSchema`                           | Require `$VARNAME` or `${{ env.VARNAME }}` for secret-valued configuration                         |
| `ModelConnectionSchema` / `PlatformConfigSchema` | Validate shared model roles and platform metadata without loading connection drivers               |
| `validateSqlIdentifier` / `isValidSqlIdentifier` | Validate unquoted identifiers, optionally dot-qualified; bind SQL values separately                |

## Protocol Rules

- **stdout = data**: SCHEMA, RECORD, STATE, BATCH, LINEAGE, REPLACE messages
- **stderr = control**: LOG, METRIC messages
- Every message carries `_v: 1` version field
- SCHEMA must be emitted before any RECORD or REPLACE for that stream
- REPLACE for a value must come before every RECORD of that value in the run
- STATE is emitted after flushing buffered records

## Key Conventions

- **Use `CommandError`** for user-facing errors across extractor and loader — it carries an `exitCode` (default 2 for validation errors)
- **Exit codes**: `0` success, `1` runtime error, `2` validation error, `3` drift detected
- **Never use `process.exit()`** — set `process.exitCode` and return
- **Column types are the canonical set** — do not invent new types; map source types to the supported protocol set (`string`, `integer`, `number`, `boolean`, `timestamp`, `array`, `object`, `vector`)

## Development

```bash
pnpm --filter @bobsled-inc/protocol build
pnpm --filter @bobsled-inc/protocol typecheck
pnpm --filter @bobsled-inc/protocol lint
pnpm --filter @bobsled-inc/protocol test:unit
```
