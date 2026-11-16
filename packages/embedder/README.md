# @bobsled-inc/embedder

This workspace is bundled inside `@bobsled-inc/bobsled-core` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

Protocol-aware embedding for Bobsled Core streams. Run it with `bobsled embed`.

## What It Does

- Reads Bobsled Core protocol messages from stdin
- Adds `vector` columns to `SCHEMA` messages for configured fields
- Enriches `RECORD` messages with embedding arrays
- Rewrites JSONL and JSONL+gzip `BATCH` payloads with embedded columns
- Emits structured `LOG` and `METRIC` messages on stderr

## Config Shape

```json
{
  "provider": "openai",
  "model": "text-embedding-3-small",
  "api_key": "$OPENAI_API_KEY",
  "streams": {
    "issues": [{ "field": "body" }, { "field": "title", "as": "title_embedding" }]
  }
}
```

Notes:

- `api_key` may be a literal or an env placeholder like `$OPENAI_API_KEY`
- `as` is optional; omitted fields default to `<field>_embedding`
- output columns use protocol type `vector` and inherit their `dimension` from the configured model

## Quick Start

### Standalone extract -> embed -> load

```bash
bobsled extract run --integration github issues \
  | bobsled embed --config ./embedder.json \
  | bobsled load run --dest duckdb --db-path ./dev.duckdb
```

`bobsled embed` delegates to this package. If you are invoking the package binary directly, use:

```bash
bobsled embed run --config ./embedder.json
```

### One-step pipeline with embedding

```bash
bobsled pipeline \
  --integration github \
  --resource issues \
  --dest duckdb \
  --db-path ./dev.duckdb \
  --output-dir ./output \
  --embed-config-json '{"provider":"openai","model":"text-embedding-3-small","api_key":"$OPENAI_API_KEY","streams":{"issues":[{"field":"body"}]}}'
```

When `bobsled pipeline --embed-config-json` is used, Bobsled Core validates the JSON and writes it to a `0600` temp file before spawning the embed subprocess, so secrets are not exposed in argv.

For reusable repo-local configs, prefer checking in a file like `embedder.json` and composing the explicit `extract | embed | load` pipeline shown above.

## Output And Runtime Behavior

- Supported batch encodings: `jsonl` and `jsonl+gzip`
- Unsupported batch encoding: `parquet` (fails with actionable validation guidance)
- Output modes: `--json`, `--verbose`, `--quiet`, `--log-format json|pretty`
- Non-targeted streams and untouched fields pass through unchanged
- `STATE` messages are preserved

## Testing And Local Smoke Runs

Use the stub mode to exercise the pipeline without calling OpenAI:

```bash
BOBSLED_CORE_EMBED_STUB=1 \
bobsled extract run --integration github issues \
  | bobsled embed --config ./embedder.json \
  | bobsled load run --dest duckdb --db-path ./dev.duckdb
```

Stub mode emits zero-filled vectors with the correct model dimension.

## Development

```bash
pnpm --filter @bobsled-inc/embedder build
pnpm --filter @bobsled-inc/embedder typecheck
pnpm --filter @bobsled-inc/embedder lint
pnpm --filter @bobsled-inc/embedder test
```
