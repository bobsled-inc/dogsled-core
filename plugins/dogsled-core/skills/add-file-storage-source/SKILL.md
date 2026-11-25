---
name: add-file-storage-source
description: Onboard documents (PDF, DOCX, PPTX, HTML, Markdown, text, email)
  from an Amazon S3 or Google Cloud Storage bucket — author a file-storage
  integration (source_type s3|gcs, bucket + auth) plus a document resource that
  parses and token-chunks each file, and an optional pipeline that embeds the
  chunks. Use when the user wants to ingest files/documents from cloud object
  storage rather than from an API.
---

# Add a file-storage source (S3 / GCS documents)

Use this when a user wants to pull **documents** (PDF, DOCX, PPTX, HTML,
Markdown, plain text, email) out of an **Amazon S3** or **Google Cloud
Storage** bucket, parse and token-chunk them, and load the result into the
warehouse — optionally embedding each chunk for semantic search.

A file-storage source is two YAML files: an **integration** (which bucket and
how to authenticate) and a **document resource** (which keys to read and how to
parse and chunk them). A pipeline can embed the chunks. Secrets are **always** env-var indirection
through `*_env` fields. Declare each referenced name in `auth_env_vars`.

When to use a different skill:

- The source is a REST / GraphQL API → `add-custom-api-integration`.
- The source is an MCP server → `add-custom-mcp-integration` / `mcp-discover`.
- The source is a warehouse / database → `add-warehouse-source`.
- You want to _write_ files **to** S3/GCS (a destination, not a source) →
  `add-file-destination`.
- You want to move files unchanged, without parsing them → a `source.kind: copy`
  file Resource, not a document Resource. See
  [Copy files as they are](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/guides/extract-from-files.md#copy-files-as-they-are).

## Shape

```text
integrations/
  <name>.yml          # spec_version '1', type: integration, source_type: s3 | gcs
resources/
  <name>/
    documents.yml     # type: resource, source.format: document, parse + chunk
```

### Step 1 — Integration (bucket + auth)

#### Amazon S3

```yaml
spec_version: '1'
auth_env_vars: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN]
type: integration
name: s3_documents
description: Amazon S3 bucket holding documents to ingest.
source_type: s3
connection:
  bucket: documents
  region: us-east-1
  # endpoint: https://minio.example.com   # S3-compatible stores only
  # force_path_style: true                 # some S3-compatible stores require this
auth:
  # default_chain = AWS SDK default credential chain (IAM role / instance
  # profile / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in the env).
  type: default_chain
  # Explicit keys instead:
  # type: static_env
  # access_key_id_env: AWS_ACCESS_KEY_ID
  # secret_access_key_env: AWS_SECRET_ACCESS_KEY
  # session_token_env: AWS_SESSION_TOKEN   # optional
```

Custom S3 endpoints, including MinIO and R2, require `static_env` credentials. Declare each key and session-token name in `auth_env_vars`.

#### Google Cloud Storage

```yaml
spec_version: '1'
auth_env_vars: [GCS_SERVICE_ACCOUNT_JSON]
type: integration
name: gcs_documents
description: Google Cloud Storage bucket holding documents to ingest.
source_type: gcs
connection:
  bucket: documents
  # project_id: my-gcp-project   # optional
auth:
  # adc = Application Default Credentials (Workload Identity, a GCE service
  # account, or `gcloud auth application-default login` locally).
  type: adc
  # Explicit service-account key instead:
  # type: service_account_json
  # credentials_json_env: GCS_SERVICE_ACCOUNT_JSON
```

### Step 2 — Document resource (parse + chunk)

One resource per ingest. `source.format: document` selects the document
extractor; `parse` controls which formats are read and how failures are
handled; `chunk` controls token-chunk granularity. `integration:` must match
the integration's `name`.

```yaml
spec_version: '1'
type: resource
name: documents
integration: s3_documents
description: Parse and chunk documents under the bucket's documents/ prefix.
source:
  path: 'documents/**/*' # glob, provider-relative (no leading slash, no `..`)
  format: document
  parse:
    formats: [pdf, docx, pptx, html, md, txt, eml]
    max_file_size_mb: 50
    on_error: record # record a row in __parse_errors instead of failing the run
  chunk:
    # strategy: paragraph # cut at blank lines; default is recursive
    max_tokens: 800
    overlap_tokens: 120
    tokenizer: cl100k_base
  ingest:
    mode: extract
replication:
  method: full_refresh
output:
  document_id:
    type: string
```

`chunk.strategy: paragraph` cuts at blank lines and joins short paragraphs up to
`min_tokens` (default 60), never above `max_tokens`. It takes no overlap, so remove
`overlap_tokens` from the block above. `min_tokens` is invalid with `recursive`. PDF text
usually has no blank lines, so `paragraph` cuts it by size.

HTML and HTML email parsing drops plainly hidden content (containers with `hidden` or
inline `display: none`), including content that a script shows later. A document that links
a style sheet, or has one that might show hidden content, keeps everything. This is text
clean-up, not protection against hidden instructions.

Changing `parse`, `chunk` or the pipeline's `embed` block does not touch files an
incremental resource already read; run once with `--full-refresh`.

### What you get

The document extractor emits Dogsled protocol streams that load as warehouse
tables, prefixed by the resource name:

- `<resource>__documents` — one row per file (`document_id`, source URI, format, text, byte length, …)
- `<resource>__chunks` — N rows per file (`chunk_id`, `document_id`, `text`, `token_count`, …)
- `<resource>__parse_errors` — one row per file that failed to parse (only with `on_error: record`)

### Step 3 — (optional) Embeddings

Give the pipeline an `embed:` block. Its `streams` key is the document resource's
name, and `text` is the only field it takes. `dogsled runner run` then chains
`extract → embed → load` and adds a `text_embedding` vector column to
`<resource>__chunks`; the other tables are loaded as they are.

```yaml
# dogsled.yml
destinations:
  local:
    type: duckdb
    db_path: ./documents.duckdb
pipelines:
  documents:
    schedule: manual
    source: s3_documents
    destination: local
    resources: [documents]
    embed:
      provider: amazon-bedrock
      model: amazon.titan-embed-text-v2:0
      region: us-east-1
      dimension: 1024
      streams:
        documents: [{ field: text }]
```

Do not add an `embedding:` block to the resource: it has no effect, and validation
warns about it. With `dogsled extract run | dogsled embed run | dogsled load run`, use
the exact stream name, `<resource>__chunks`, in the embedder's configuration. When a
host application supplies the model, use `provider: host`; see
[Host-supplied embeddings](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/reference/host-embeddings.md).

### Step 4 — Validate → run

```bash
# S3:
export S3_BUCKET=my-company-docs
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...   # or an IAM role for default_chain
dogsled extract validate --integration s3_documents documents
dogsled extract run --integration s3_documents documents | dogsled load run --to duckdb

# GCS:
export GCS_BUCKET=my-company-docs
gcloud auth application-default login                    # ADC; or service_account_json
dogsled extract validate --integration gcs_documents documents
dogsled extract run --integration gcs_documents documents | dogsled load run --to duckdb
```

A ready-to-edit example project ships with the CLI:

```bash
dogsled examples init s3-documents-ingestion
```

## Managed destinations

A destination with `type: dogsled_managed` uses `dogsled_connection_ref` to name a
connection supplied by an orchestrator. Core validates these fields but cannot
load into a managed destination. For local execution, use a concrete destination
such as DuckDB or BigQuery. Author the `documents` resource and the pipeline's optional
`embed:` block as above. See [Dogsled Cloud and Core](https://github.com/bobsled-inc/dogsled-core/blob/main/docs/guides/dogsled-cloud.md).

## Next step — feed the entity graph

The `<resource>__chunks` table (and its `text_embedding` vector when the pipeline
has an `embed:` block) is the **upstream feeder** for
**`entity-graph-construction`**: mention extraction runs candidate retrieval
over those chunk embeddings to link each chunk to a resolved entity, and
relationship extraction reads the resolved same-chunk mentions. After
resolving entities (`entity-resolution`), point construction at these chunks.

## Quality checklist

- Integration sets `spec_version: '1'`, `type: integration`, `source_type: s3` or `gcs`, and `connection.bucket`.
- S3 auth is `default_chain` or `static_env`; GCS auth is `adc` or `service_account_json`.
- Every credential is env indirection (`${{ env.X }}` / `*_env`) — no raw secrets, no literal bucket.
- The resource sets `source.format: document`, a provider-relative `source.path` glob, `parse.formats`, and `chunk` settings; `integration:` matches the integration `name`.
- Use `on_error: record` when the user wants a `__parse_errors` table instead of a hard run failure.
- Embeddings: the pipeline's `embed.streams` has the resource's name with `field: text`, and the resource has no `embedding:` block.
