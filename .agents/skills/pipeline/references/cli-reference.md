# Dogsled Pipeline — End-to-End Extract + Load

The `dogsled pipeline` command runs extractor + loader together. It has two execution modes:

- **Single destination**: extractor stdout is piped directly into one loader subprocess.
- **Multi-destination fan-out**: extractor stdout is captured once, replayed into multiple loader subprocesses, and extractor state is committed only after every destination succeeds.

A third optional middle stage — the **embedder** — slots between extract and
load when a `dogsled.yml` pipeline has an `embed:` block. Dogsled spawns the
embedder subprocess automatically; the extractor pipes through it and each
loaded record gains `<field>_embedding` (`vector`) columns alongside the
originals. See "Embed Stage" below.

## Quick Reference

```bash
# Extract all resources for an integration to local parquet
dogsled pipeline --integration github --format parquet

# Extract specific resources
dogsled pipeline repos issues pull_requests --integration github --format parquet

# Load into DuckDB
dogsled pipeline --integration github --dest duckdb --db-path ./data.duckdb

# Load into BigQuery with table prefix
dogsled pipeline --integration vantage \
  --dest bigquery \
  --project-id my-project \
  --dataset-id raw \
  --key-filename ~/path/to/key.json \
  --table-prefix vantage__ \
  --load-strategy full_refresh

# Write logs to file (also prints to terminal)
dogsled pipeline --integration github --format parquet --log-file ./pipeline.log

# Watch logs live in another terminal
tail -f ./pipeline.log

# Retry only failed/remaining resources (skip already-loaded ones)
dogsled pipeline cost_providers costs dashboards users \
  --integration vantage --dest bigquery ...

# Custom input values
dogsled pipeline repos --integration github --format parquet --input org=bobsled-inc

# Multi-destination fan-out is driven from dogsled.yml via `dogsled runner run`
dogsled runner run stripe
```

## How It Works

```
dogsled pipeline repos --integration github --format parquet
        │
        ▼
┌──────────────────┐     stdout (JSONL)     ┌──────────────────┐
│  dogsled extract │ ──────────────────────▶ │  dogsled load  │
│  (subprocess)    │                         │  (subprocess)    │
└──────────────────┘     stderr (logs)       └──────────────────┘
        │                    │                        │
        ▼                    ▼                        ▼
   API requests         Control msgs           Output files/DB
```

Single-destination pipeline spawns two child processes:

1. **Extractor** — runs `dogsled extract run <resources>` with the specified integration
2. **Loader** — runs `dogsled load run` with the specified destination config

Extractor stdout is piped directly to loader stdin. Both stderr streams write structured JSON logs.

With an embed stage, `dogsled embed run` sits between the two. The state of a file source is then saved only after all three succeed.

Multi-destination fan-out works differently:

1. Extractor stdout is captured to a temp JSONL file.
2. Dogsled replays that file into one loader subprocess per named destination.
3. If every loader exits successfully, Dogsled runs `dogsled extract commit-state` against the captured `STATE` messages.
4. If any loader fails, Dogsled exits non-zero and leaves extractor state unadvanced so the next run can retry safely.

## Options

### Extraction Options

| Option                     | Description                                                                                                                                                            | Default      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `[resources...]`           | Positional args — resource names to extract (omit for all)                                                                                                             | all          |
| `--integration <name>`     | Integration to extract from                                                                                                                                            | **required** |
| `--full-refresh`           | Ignore bookmarks, extract from the beginning                                                                                                                           | `false`      |
| `--batch`                  | Enable batch output                                                                                                                                                    | `false`      |
| `--batch-size <n>`         | Records per batch file                                                                                                                                                 | —            |
| `--buffer-size <n>`        | Records to buffer before flushing                                                                                                                                      | —            |
| `--emit-model-spec-source` | Generate Model Spec source YAML                                                                                                                                        | `false`      |
| `--input <key=value>`      | Input override (repeatable)                                                                                                                                            | —            |
| `--default-via <id>`       | Override the source integration's `default_transport` for this run (multi-transport sources only)                                                                      | from source  |
| `--resource-via <name:id>` | Force one resource onto a specific transport (repeatable; wins over `--default-via`). Requires `--integration` when multiple integrations would otherwise be iterated. | —            |

### Loading Options

| Option                    | Description                                                                                                            | Default    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------- |
| `--dest <dest>`           | Destination: `local`, `gcs`, `s3`, `duckdb`, `bigquery`, `snowflake`, `postgres`, `mysql`, `clickhouse`, `turbopuffer` | `local`    |
| `--format <format>`       | Output format: `jsonl`, `csv`, `parquet`, `arrow`                                                                      | —          |
| `--output-dir <dir>`      | Local output directory                                                                                                 | `./output` |
| `--load-strategy <s>`     | Override: `append`, `merge`, `full_refresh`                                                                            | per-stream |
| `--table-prefix <prefix>` | Prefix prepended to all table names (e.g. `vantage__`)                                                                 | —          |
| `--db-path <path>`        | DuckDB database file path                                                                                              | —          |
| `--target-schema <s>`     | DuckDB target schema                                                                                                   | —          |
| `--gcs-bucket <bucket>`   | GCS bucket name                                                                                                        | —          |
| `--gcs-prefix <prefix>`   | GCS object prefix                                                                                                      | —          |
| `--project-id <id>`       | BigQuery project ID                                                                                                    | —          |
| `--dataset-id <id>`       | BigQuery dataset ID                                                                                                    | —          |
| `--location <loc>`        | BigQuery location                                                                                                      | —          |
| `--key-filename <path>`   | BigQuery service account key                                                                                           | —          |

### Output Options

| Option              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `-v, --verbose`     | Verbose output                                 |
| `-q, --quiet`       | Suppress non-error output                      |
| `--log-file <path>` | Write all stderr logs to a file (and terminal) |
| `--log-format <f>`  | Log format: `json` (default) or `pretty`       |

## Common Workflows

### BigQuery with Multiple Integrations

Use `--table-prefix` to namespace tables when loading multiple integrations into the same dataset:

```bash
export VANTAGE_API_TOKEN=...
dogsled pipeline --integration vantage \
  --dest bigquery \
  --project-id my-project \
  --dataset-id my_dataset \
  --key-filename ~/key.json \
  --table-prefix vantage__ \
  --load-strategy full_refresh \
  --log-file ~/vantage.log

export GITHUB_TOKEN=ghp_...
dogsled pipeline --integration github \
  --dest bigquery \
  --project-id my-project \
  --dataset-id my_dataset \
  --key-filename ~/key.json \
  --table-prefix github__
```

This produces tables like `vantage__costs`, `vantage__budgets`, `github__repos`, etc.

### Retrying Failed Resources

If a pipeline run partially fails (e.g. rate limiting), specify only the remaining resources as positional args to skip already-loaded ones:

```bash
# Check logs to see which streams succeeded vs failed
grep '"level":"error"' ~/pipeline.log

# Re-run only the failed/remaining resources
dogsled pipeline cost_providers costs dashboards \
  --integration vantage --dest bigquery ...
```

**Important:** If a resource uses `for_each` (parent-child extraction), include the parent resource in the retry list even if it already loaded. For example, `costs` depends on `cost_reports` — include both:

```bash
dogsled pipeline cost_reports costs --integration vantage ...
```

### Incremental Updates

For the single-destination path, `dogsled pipeline` passes `--advance-state` to the extractor. Subsequent runs automatically resume from the last durable cursor position:

```bash
# First run: extracts all repos
dogsled pipeline repos --integration github --dest duckdb --db-path ./data.duckdb

# Second run: only extracts repos updated since last run
dogsled pipeline repos --integration github --dest duckdb --db-path ./data.duckdb
```

For the multi-destination path, extractor state is deferred until every destination loader succeeds. That is why retries remain safe even when one destination succeeds and another fails.

## Embed Stage

When a pipeline has an `embed:` block in `dogsled.yml`, the chain becomes:

```text
dogsled extract ──▶ dogsled embed ──▶ dogsled load
```

The embedder reads SCHEMA/RECORD/BATCH messages from extractor stdout,
appends one `vector` column per configured field to SCHEMA, and enriches
each RECORD with the corresponding embedding array before forwarding to the
loader. Non-embed streams pass through byte-for-byte.

```yaml
pipelines:
  linear:
    source: linear
    destination: warehouse
    resources: [issues_graphql, comments_graphql]
    embed:
      provider: openai # or anthropic, google, openrouter, amazon-bedrock, ollama
      model: text-embedding-3-small
      api_key: $OPENAI_API_KEY # env placeholder; $VAR or ${{ env.VAR }}
      dimension: 1536 # optional for known models; sent where the model takes one
      cost_budget_usd: 5.0 # optional spend cap
      streams:
        issues_graphql:
          - field: description # → column `description_embedding`
        comments_graphql:
          - field: body
            as: body_vec # explicit output column name
```

Provider notes:

- `openai` / `anthropic` / `google` / `openrouter`: `api_key` is required and
  must be an env-var placeholder (raw values are rejected).
- `amazon-bedrock`: `model` + `region` are required; `api_key` is optional —
  set it to `$AWS_BEARER_TOKEN_BEDROCK` for Bedrock API-key auth, or omit and
  Dogsled falls back to the AWS SDK credential chain (`AWS_PROFILE`, instance
  role, SSO, etc.).
- `ollama`: local/free; `base_url` defaults to `http://127.0.0.1:11434/api`.
- `host`: the application that runs Dogsled supplies the model through
  `DOGSLED_HOST_EMBEDDING_URL` (`https` only) and `DOGSLED_HOST_EMBEDDING_TOKEN`.
  No `model`, `api_key`, `region`, `base_url`, or `cost_budget_usd`; `dimension` is
  an optional check.

For a document resource, the `streams` key is the resource's name and the only field
is `text`; the vectors go to `<resource>__chunks`. `--embed-config-json` and
`dogsled embed run` take exact stream names.

Every provider's vectors must have the declared length and finite values, or the run
fails. OpenAI `text-embedding-3-*`, Google `gemini-embedding-*`, Bedrock Titan Text v2
and Cohere Embed v4, and Ollama are asked for a configured `dimension`.

Destinations store the vector column natively when possible: Snowflake gets
`VECTOR(FLOAT, N)`, BigQuery gets `ARRAY<FLOAT64>` (the BQ-native vector type
used by `VECTOR_SEARCH` + `CREATE VECTOR INDEX`), DuckDB gets `FLOAT[N]`,
pgvector gets `vector(N)`, ClickHouse gets `Array(Float32)`, and Turbopuffer
gets `[N]f32` attributes. Array-only destinations (BigQuery via standard
arrays, local jsonl/parquet) still work — the loader picks the right physical
type from the SCHEMA message automatically.

Standalone:

```bash
# Inside a pipeline run, Dogsled wires this for you. Standalone use:
dogsled extract run issues_graphql --integration linear \
  | dogsled embed run --config embed.json \
  | dogsled load run --dest duckdb --db-path ./data.duckdb
```

Stub mode for testing without provider credentials:

```bash
DOGSLED_EMBED_STUB=1 dogsled pipeline ...   # emits zero-filled vectors
```

### Model Spec source scaffold pre-fill

When `--emit-model-spec-source` is set alongside an `embed:` block, the printed
Model Spec source YAML scaffold includes the embedding columns with `type: VECTOR`,
`dimension`, and `embedded_from` provenance pre-filled. Copy the scaffold
into your handcrafted `models/sources/<name>.yml` — the host agent and
SDK codegen rely on `embedded_from` to know which source column was
embedded and which provider/model produced it.

```yaml
# Example printed by --emit-model-spec-source for a pipeline configured with Bedrock Cohere embeddings
- name: description_embedding
  type: VECTOR
  dimension: 1024
  description: Vector embedding of description (amazon-bedrock/cohere.embed-english-v3)
  embedded_from:
    column: description
    provider: amazon-bedrock
    model: cohere.embed-english-v3
```

With `provider: host` the model is known only when the run starts, so the scaffold has no
embedding columns. The embedder also stamps `embedded_from` on the runtime SCHEMA message so
loaders and any downstream protocol consumer can recover provenance live
(separate from Model Spec YAML).

## Multi-Destination Fan-out

Configure fan-out in `dogsled.yml` and run it through the runner:

```yaml
destination:
  type: duckdb
  db_path: ./default.duckdb

pipelines:
  stripe:
    schedule: hourly
    destinations:
      - name: warehouse
        type: postgres
        host: db.example.com
        database: analytics
        username: loader
        password: $PG_PASSWORD
        load_strategy: merge
      - name: archive
        type: s3
        bucket: acme-archive
        prefix: stripe/
        format: parquet
        table_prefix: archive__
```

Run it locally:

```bash
dogsled runner run stripe
```

Operational notes:

- `destination` and `destinations` are mutually exclusive per pipeline.
- Named file destinations (`local`, `gcs`, `s3`) must set `format` explicitly.
- JSON logs remain machine-parseable in fan-out mode; Dogsled wraps loader log lines with a `destination` field instead of prefixing plain text.

## Troubleshooting

**"The --format option is required for local and gcs destinations"** — Add `--format parquet` (or jsonl, csv, arrow).

**Pipeline hangs** — Check if the API token is valid. Run the extractor standalone first: `dogsled extract run repos --integration github --limit 5`

**429 Too Many Requests** — The extractor retries with exponential backoff automatically. If it still fails, the integration's `rate_limit.requests_per_second` may be too high for the API. Lower it in `integration.yml`.

**BigQuery "Could not serialize access"** — This happens when concurrent load jobs race on the same table with `full_refresh`. The loader serializes per-stream loads to prevent this. If you see it, ensure you're on the latest build.

**Partial data** — If the pipeline fails mid-run, use resource names to retry only the failed streams (see "Retrying Failed Resources" above).

**Exit codes** — Single-destination mode returns the worse of extract/load exit codes. Fan-out mode returns the highest non-zero loader exit code so validation and drift failures still propagate accurately.
