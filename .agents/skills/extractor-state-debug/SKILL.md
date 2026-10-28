---
name: extractor-state-debug
description: Debug incremental extraction state and cursor issues. Use when troubleshooting duplicate data, re-extraction, stale cursors, or state reset questions.
---

# Debug Incremental Extraction State

Debug and fix incremental state issues in `@bobsled-inc/extractor`. Incremental state is stored in `.extractor/state.json` and tracks cursor positions per resource stream.

## Step 1: Read Current State

Examine the state file:

```bash
cat .extractor/state.json
```

State structure:

```json
{
  "streams": {
    "integration/resource": {
      "cursor_field": "updated_at",
      "cursor_value": "2024-01-15T10:30:00Z",
      "cursor_type": "timestamp",
      "last_run_at": "2026-04-07T14:30:00Z"
    }
  }
}
```

Each stream is keyed as `integration/resource`. Check:

- Does the stream entry exist?
- Is `cursor_value` current or stale?
- Does `cursor_type` match the resource config?

## Step 2: Diagnose the Issue

| Symptom                   | Likely Cause                 | Diagnosis                                                                  |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| Re-extracting all records | Missing state entry          | Stream key missing from `bookmarks` — first run or state was deleted       |
| Re-extracting all records | Missing `incremental` config | Resource spec has no `incremental` block — extractor does full extraction  |
| Duplicate records         | Stale cursor                 | `cursor_value` is old — records between old cursor and now get re-fetched  |
| No new records extracted  | Cursor too far ahead         | `cursor_value` is in the future or at latest record — nothing new to fetch |
| Type errors               | cursor_type mismatch         | Resource config says `timestamp` but state has an integer, or vice versa   |
| State not updating        | cursor_field not in response | The field specified in `cursor_field` isn't in the API response data       |

## Step 3: Fix Actions

**Full refresh** (re-extract everything, ignore the saved bookmark for this run):

```bash
dogsled extract run {resource} --integration {name} --full-refresh
```

**Durable incremental run** (advance the saved bookmark):

```bash
dogsled extract run {resource} --integration {name} --advance-state
```

**Preview run** (emit `STATE`, but leave the saved bookmark unchanged):

```bash
dogsled extract run {resource} --integration {name} --limit 5
```

**Topup from a specific date** (incremental from a given point):

```bash
dogsled extract topup --integration {name} --resource {resource} --since 2024-01-01
```

**Manual state edit** (advanced — use with caution):
Edit `.extractor/state.json` directly to adjust `cursor_value`. Ensure:

- The value matches the `cursor_type` (ISO 8601 for timestamp, integer for integer, string for string)
- The field name matches `cursor_field` in the resource config

**Add incremental config** (if missing):

```yaml
incremental:
  cursor_field: updated_at # Must be an existing column name
  cursor_param: since # API query parameter for filtering
  cursor_type: timestamp # timestamp | integer | string
```

## Cursor Behavior

Three cursor types:

- **timestamp**: ISO 8601 strings, compared chronologically
- **integer**: Numeric IDs, compared numerically
- **string**: Lexicographic comparison

If `cursor_type` is omitted, it is auto-detected from the first value seen. The cursor advances monotonically — it only moves forward, tracking the maximum value seen. On `topup`, the cursor is temporarily overridden with the `--since` value but the saved state is not modified until new records are emitted.

## State Advancement Rules

- `run` and `topup` emit `STATE` messages for incremental resources.
- Durable bookmarks only advance when `--advance-state` is passed.
- `--limit` runs are preview-only and never persist durable state.
- In `dogsled pipeline` multi-destination fan-out mode, Dogsled captures extractor `STATE` messages and runs `dogsled extract commit-state` only after every destination loader succeeds.

If a fan-out pipeline appears to re-extract data after one destination failed, that is expected: extractor state intentionally stayed behind so the failed destination can catch up on retry.

## Guardrails

- **Never delete the entire state file** — this forces full re-extraction of ALL streams
- **Warn before cursor reset** — resetting a cursor means re-extracting potentially large volumes of data
- **Validate cursor_field** — ensure it references a real output field in the resource spec
- State writes are atomic (write-to-temp-then-rename) — safe to interrupt
