# S3 / GCS document ingestion

Extract documents (PDF, DOCX, PPTX, HTML, Markdown, text, email) from an Amazon
S3 or Google Cloud Storage bucket, parse and token-chunk them, and load the
results into your warehouse. Optionally embed each chunk for semantic search.

```bash
bobsled examples init s3-documents-ingestion
cd s3-documents-ingestion
```

Run **one** provider depending on which bucket you have.

## Amazon S3

Set `connection.bucket` in `integrations/s3_documents.yml` and choose its authentication method.
Custom S3 endpoints require `static_env` with every credential name listed in `auth_env_vars`.

```bash
# Option A — default credential chain (IAM role / instance profile / env):
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
# Option B — explicit keys: set auth.type: static_env in the integration first.

bobsled extract validate s3_documents
bobsled extract run --integration s3_documents documents | bobsled load run --dest duckdb --db-path documents.duckdb
```

## Google Cloud Storage

Set `connection.bucket` in `integrations/gcs_documents.yml`.
For an explicit service account key, keep its variable name in `auth_env_vars`.

```bash
gcloud auth application-default login          # provides ADC
# Or set auth.type: service_account_json + GCS_SERVICE_ACCOUNT_JSON in the integration.

bobsled extract validate gcs_documents
bobsled extract run --integration gcs_documents documents | bobsled load run --dest duckdb --db-path documents.duckdb
```

## What you get

The document extractor emits Bobsled Core protocol streams that load as warehouse tables:

- `documents__documents` — one row per file (`document_id`, source URI, format, text, byte length, …)
- `documents__chunks` — N rows per file (`chunk_id`, `document_id`, `text`, `token_count`, …)
- `documents__parse_errors` — one row per file that failed to parse (`on_error: record`)

## Adding embeddings

Uncomment the `embedding:` block in `resources/<provider>/documents.yml` and
declare a matching model role under `platform.models` in your `bobsled.yml`:

```yaml
platform:
  models:
    default_embedding_v1:
      provider: bedrock
      model: amazon.titan-embed-text-v2:0
```

When a pipeline runs with an `embed:` block, Bobsled Core auto-chains
`extract -> embed -> load`, adding a `text_embedding` vector column to
`documents__chunks`. With Bobsled Core, create the S3/GCS connection in the app and
the same flow runs against your managed warehouse — no local credentials
needed.

## Tuning

- `source.path` — glob of which keys to ingest (provider-relative).
- `parse.formats` / `parse.max_file_size_mb` / `parse.on_error` — what to parse and how to handle failures.
- `chunk.max_tokens` / `chunk.overlap_tokens` / `chunk.tokenizer` — chunking granularity.
