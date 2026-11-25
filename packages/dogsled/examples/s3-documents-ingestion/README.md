# S3 / GCS document ingestion

Extract documents (PDF, DOCX, PPTX, HTML, Markdown, text, email) from an Amazon
S3 or Google Cloud Storage bucket, parse and token-chunk them, and load the
results into your warehouse. Optionally embed each chunk for semantic search.

```bash
dogsled examples init s3-documents-ingestion
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

dogsled extract validate s3_documents
dogsled extract run --integration s3_documents documents | dogsled load run --dest duckdb --db-path documents.duckdb
```

## Google Cloud Storage

Set `connection.bucket` in `integrations/gcs_documents.yml`.
For an explicit service account key, keep its variable name in `auth_env_vars`.

```bash
gcloud auth application-default login          # provides ADC
# Or set auth.type: service_account_json + GCS_SERVICE_ACCOUNT_JSON in the integration.

dogsled extract validate gcs_documents
dogsled extract run --integration gcs_documents documents | dogsled load run --dest duckdb --db-path documents.duckdb
```

## What you get

The document extractor emits Dogsled protocol streams that load as warehouse tables:

- `documents__documents` — one row per file (`document_id`, source URI, format, text, byte length, …)
- `documents__chunks` — N rows per file (`chunk_id`, `document_id`, `text`, `token_count`, …)
- `documents__parse_errors` — one row per file that failed to parse (`on_error: record`)

## Adding embeddings

`dogsled.yml` has a pipeline for each provider. Uncomment the `embed:` block of yours:

```yaml
embed:
  provider: amazon-bedrock
  model: amazon.titan-embed-text-v2:0
  region: us-east-1
  dimension: 1024
  streams:
    documents: [{ field: text }]
```

Then check the project and run the pipeline:

```bash
dogsled runner validate
dogsled runner run s3_documents   # or gcs_documents
```

Dogsled chains `extract -> embed -> load` and adds a `text_embedding` vector column to
`documents__chunks`. The other tables stay as they are. The key under `streams` is the
resource's name, and `text` is the only field it takes. This block signs in to Amazon
Bedrock with the AWS default credential chain. To try the pipeline without a provider,
set `DOGSLED_EMBED_STUB=1`, which writes zero vectors.

## Tuning

- `source.path` — glob of which keys to ingest (provider-relative).
- `parse.formats` / `parse.max_file_size_mb` / `parse.on_error` — what to parse and how to handle failures.
- `chunk.strategy` — `recursive` (default), or `paragraph` to cut at blank lines without overlap (remove `overlap_tokens`).
- `chunk.max_tokens` / `chunk.overlap_tokens` / `chunk.tokenizer` — chunking granularity.
