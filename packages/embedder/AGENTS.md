# @bobsled-inc/embedder — Agent Guide

<!-- last-reviewed: 2026-11-25 -->

`@bobsled-inc/embedder` enriches Dogsled protocol streams with vector embeddings. It is exposed through the unified CLI as `dogsled embed`.

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
- vector columns must include a `dimension`; the embedder uses the configured `dimension` or the default of a known model. With `provider: host` it uses the host's, and a configured `dimension` must equal it
- `provider: host` takes `streams`, an optional `dimension`, and `auth_env_vars`, which it does not
  use. The host application names the model, at the endpoint in `DOGSLED_HOST_EMBEDDING_URL`
- `streams` keys are exact protocol stream names; a run of a project's pipeline resolves Resource
  names to streams before it starts the embedder, so never guess a stream from a suffix here
- `src/config.ts` is the `/schema` entry that config validation imports: keep it to zod and
  `@bobsled-inc/protocol`
- prefer env placeholders in checked-in configs; literal API keys are acceptable only for one-off local invocations

## Command Surface

- `dogsled embed run --config ./embedder.json`
- `dogsled embed --config ./embedder.json`
- `dogsled embed --config-json '{"provider":"openai",...}'`

Output controls:

- `--json` forces structured stderr logs
- `--log-format json|pretty` controls log rendering
- `--verbose` enables extra runtime detail
- `--quiet` suppresses non-error logs

## Runtime Invariants

- Non-target streams pass through without embeddings; messages are parsed and re-serialized, not copied byte for byte
- `STATE` values are forwarded unchanged
- Sparse records with no embeddable values flush immediately instead of accumulating in memory
- Rewritten batch manifests sanitize stream names and use collision-resistant filenames
- Only JSONL and JSONL+gzip batch rewriting is supported; reject Parquet with a validation error
- Route provider calls through `@bobsled-inc/ai`; do not add provider SDK clients here
- Every vector must have the declared length and finite numbers, in `RECORD` and `BATCH` alike,
  whatever the provider
- A provider may return a null vector only for an input it reported as refused, and the totals
  must match. A value with nothing to embed gets a null vector without a call
- The token limit is for the other providers. Text for a host-supplied model is only cut to the
  characters its host allows, and never reaches the tokenizer, which is not that model's
- A host stage asks for the model before it writes a `SCHEMA` and before it sends text. Only that
  stage may read the two host variables, and `dogsled embed run` removes them from `process.env`
- Warnings and errors about records name streams, lines, fields, counts and codes, never a text or an
  input id; only the message of another package is passed on. A JSON error quotes its input, so never
  forward one from a protocol line or a `BATCH` file
- Shared helpers used by runtime code belong in shared modules, not command modules

## Setup And Pipeline Guidance

- For reusable project workflows, check in an embed config file and compose `extract | embed | load`
- For one-off composed runs, `dogsled pipeline --embed-config-json` is supported; Dogsled rewrites validated config JSON to a `0600` temp file before spawning the embedder
- Choose destinations that support protocol `vector` columns before enabling embeddings downstream
- For CI and smoke tests, set `DOGSLED_EMBED_STUB=1` to emit zero vectors with the correct dimension; `provider: host` then needs a `dimension`
- `DOGSLED_EMBEDDER_TMP_DIR` overrides the temp directory used for rewritten batch files

## Package Layout

- `src/index.ts`: CLI entrypoint, output-mode inference, Commander wiring
- `src/commands/run.ts`: config parsing, secret resolution, CLI plumbing
- `src/commands/host-stage.ts`: the stage for `provider: host`, and the stub stage
- `src/runtime/processor.ts`: protocol pass-through for `SCHEMA`, `RECORD`, `STATE`, and `BATCH`
- `src/runtime/read-messages.ts`: protocol input, without the text of a line that is not JSON
- `src/runtime/embedding-text.ts`: what is embedded for a value, within the limits
- `src/runtime/embed-result.ts`: the result of one embedding call and its checks
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
