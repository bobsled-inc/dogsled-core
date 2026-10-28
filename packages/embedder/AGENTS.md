# @bobsled-inc/embedder — Agent Guide

<!-- last-reviewed: 2026-07-27 -->

`@bobsled-inc/embedder` enriches Dogsled protocol streams with vector embeddings. It is exposed directly as `dogsled embed` and through the unified CLI as `dogsled embed`.

---

## Responsibilities

- Parse embedder config from `--config` or `--config-json`
- Resolve `api_key` literals and `$ENV_VAR` placeholders
- Append `vector` columns to `SCHEMA` messages for configured fields
- Enrich `RECORD` messages plus JSONL and JSONL+gzip `BATCH` manifests
- Emit structured `LOG` and `METRIC` stderr messages in `json` or `pretty` format

## Config Contract

The config shape is:

```json
{
  "provider": "openai",
  "model": "text-embedding-3-small",
  "api_key": "$OPENAI_API_KEY",
  "streams": {
    "issues": [{ "field": "body", "as": "body_embedding" }]
  }
}
```

Key rules:

- `streams.<stream>[]` entries require `field`
- `as` is optional; default output column name is `<field>_embedding`
- vector columns must include a `dimension`, and the embedder derives it from the selected model
- prefer env placeholders in checked-in configs; literal API keys are acceptable only for one-off local invocations

## Command Surface

- `dogsled embed run --config ./embedder.json`
- `dogsled embed --config ./embedder.json`
- `dogsled embed run --config ./embedder.json`
- `dogsled embed --config-json '{"provider":"openai",...}'`

Output controls:

- `--json` forces structured stderr logs
- `--log-format json|pretty` controls log rendering
- `--verbose` enables extra runtime detail
- `--quiet` suppresses non-error logs

## Runtime Invariants

- Non-target streams are byte-for-byte pass-through
- `STATE` messages are forwarded unchanged
- Sparse records with no embeddable values flush immediately instead of accumulating in memory
- Rewritten batch manifests sanitize stream names and use collision-resistant filenames
- Only JSONL and JSONL+gzip batch rewriting is supported; reject Parquet with a validation error
- Route provider calls through `@bobsled-inc/ai`; do not add provider SDK clients here
- Shared helpers used by runtime code belong in shared modules, not command modules

## Setup And Pipeline Guidance

- For reusable project workflows, check in an embed config file and compose `extract | embed | load`
- For one-off composed runs, `dogsled pipeline --embed-config-json` is supported; Dogsled rewrites validated config JSON to a `0600` temp file before spawning the embedder
- Choose destinations that support protocol `vector` columns before enabling embeddings downstream
- For CI and smoke tests, set `DOGSLED_EMBED_STUB=1` to emit zero vectors with the correct dimension
- `DOGSLED_EMBEDDER_TMP_DIR` overrides the temp directory used for rewritten batch files

## Package Layout

- `src/index.ts`: CLI entrypoint, output-mode inference, Commander wiring
- `src/commands/run.ts`: config parsing, secret resolution, CLI plumbing
- `src/runtime/processor.ts`: protocol pass-through for `SCHEMA`, `RECORD`, `STATE`, and `BATCH`
- `src/runtime/batch-rewriter.ts`: JSONL and JSONL+gzip `BATCH` rewriting
- `src/runtime/tokenizer.ts`: token counting and truncation helpers
- `src/output-column.ts`: shared output-column naming helper

## Development

```bash
pnpm --filter @bobsled-inc/embedder build
pnpm --filter @bobsled-inc/embedder typecheck
pnpm --filter @bobsled-inc/embedder lint
pnpm --filter @bobsled-inc/embedder test:unit
```
