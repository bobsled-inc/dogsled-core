# Extract from files

Dogsled reads CSV, JSON Lines and Parquet files, and parses documents (PDF, Word,
PowerPoint, HTML, Markdown, text and email) into text chunks. Files can come from a
local folder, Amazon S3, Google Cloud Storage, an SFTP server or a private Vercel
Blob object.

## Read a folder of CSV files

A file integration points at a folder. Each resource selects files with a glob
pattern relative to that folder.

Create `data/events/2026-01-01.csv`:

```csv
event_id,kind,amount
1,signup,0
2,purchase,40
```

Create `data/events/2026-01-02.csv`:

```csv
event_id,kind,amount
3,purchase,25
4,refund,-25
```

Create `integrations/files.yml`:

```yaml
spec_version: '1'
type: integration
name: files
source_type: local
connection:
  base_directory: data
auth:
  type: none
```

Create `resources/files/events.yml`:

```yaml
spec_version: '1'
type: resource
name: events
integration: files
source:
  path: events/*.csv
  format: csv
  options: { header: true }
  include_filename: true
replication:
  method: incremental_append
  cursor: { field: last_modified }
extract:
  table:
    primary_key: [event_id]
output:
  event_id: { type: integer }
  kind: { type: string }
  amount: { type: number }
```

Extract and load both files:

```bash
dogsled extract run --integration files events --advance-state --quiet \
  | dogsled load run --dest duckdb --db-path files.duckdb
dogsled query "SELECT event_id, kind, _file_path FROM events ORDER BY event_id" --db-path files.duckdb
```

```text
[loader] events: loaded 4 rows
...
event_id	kind	_file_path
1	signup	events/2026-01-01.csv
2	purchase	events/2026-01-01.csv
3	purchase	events/2026-01-02.csv
4	refund	events/2026-01-02.csv
```

`include_filename: true` adds the `_file_path` and `_file_uri` columns.

## Read only new files

`replication.method: incremental_append` with a `last_modified` cursor records each
file it has read. With `--advance-state`, the next run skips files that have not
changed since. The loader appends each run's rows, so earlier files stay in the
table. Add a third day:

Create `data/events/2026-01-03.csv`:

```csv
event_id,kind,amount
5,purchase,60
```

```bash
dogsled extract run --integration files events --advance-state --quiet \
  | dogsled load run --dest duckdb --db-path files.duckdb
dogsled query "SELECT count(*) AS events FROM events" --db-path files.duckdb
```

```text
[loader] events: loaded 1 rows
...
events
5
```

Use `cursor: { field: etag }` to detect changes by content instead of by timestamp.
A changed file is read again in full and its rows are appended again. To replace them
instead, set `extract.table.load_strategy: merge` with a `primary_key`.
`replication.method: full_refresh` reads every matching file on every run.

## File formats and options

| `format`  | Options                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `csv`     | `options.header`, `options.delimiter` (1 to 8 characters), `options.null_values`, `compression: gzip` |
| `jsonl`   | `compression: gzip`                                                                                   |
| `parquet` | None.                                                                                                 |

`include_file_metadata: true` adds `_file_modified_at`, `_file_etag` and `_file_size`
as well as the two file name columns. `source.path` must be relative to the
integration's folder or bucket; absolute paths and `..` are rejected.

## Parse documents

Set `format: document` to parse documents instead of reading rows. Dogsled extracts
the text, splits it into overlapping chunks by token count, and records what it
could not parse.

Create `data/docs/onboarding.md`:

```markdown
# Onboarding checklist

New support agents read the escalation policy first.

## Escalation

Escalate refunds over 500 to the finance team within one business day.
```

Create `resources/files/handbook.yml`:

```yaml
spec_version: '1'
type: resource
name: handbook
integration: files
source:
  path: docs/*.md
  format: document
  parse: { formats: [md] }
  chunk: { max_tokens: 50, overlap_tokens: 10 }
replication:
  method: full_refresh
output:
  document_id: { type: string }
```

```bash
dogsled extract run --integration files handbook --quiet \
  | dogsled load run --dest duckdb --db-path files.duckdb
dogsled query "SELECT chunk_index, token_count FROM handbook__chunks" --db-path files.duckdb
```

```text
[loader] handbook__documents: loaded 1 rows
[loader] handbook__chunks: loaded 1 rows
...
chunk_index	token_count
0	33
```

A document resource produces four tables, named after the resource:

| Table                  | Contents                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>__documents`    | One row per document, at its latest version: `document_id`, `source_uri`, `format`, full `text`, `content_hash`, `parser_version`.                    |
| `<name>__chunks`       | One row per chunk: `chunk_id`, `document_id`, `chunk_index`, `text`, `token_count`.                                                                   |
| `<name>__parse_errors` | Files that could not be parsed, when `parse.on_error` is `record` (the default). `skip` ignores them and `fail` stops the run.                        |
| `<name>__acl`          | Permission evidence (who could read the file) when the source exposes it and `permissions.capture` is on. Dogsled records it; it does not enforce it. |

Document options:

- `parse.formats`: any of `pdf`, `docx`, `pptx`, `html`, `md`, `txt`, `eml` (all by
  default). `parse.max_file_size_mb` defaults to 100 and allows up to 500.
- `chunk.max_tokens` (default 800), `chunk.overlap_tokens` (default 120) and
  `chunk.tokenizer` (`cl100k_base`, `o200k_base` or `p50k_base`).
- `embedding: { role: <model role> }` adds a vector for each chunk using a model
  role from `platform.models`. See [Embeddings and AI providers](embeddings-and-ai.md).

A document resource with `replication.method: full_refresh` parses every file again
on every run, and with `embedding` set it embeds every chunk again, which costs
provider calls each time. Use an incremental method to process only new or changed
files.

An incremental run replaces each new or changed file's rows in all four tables:
the loader deletes the file's previous rows by `document_id`, then writes the new
ones. A file that now has fewer chunks keeps no old chunks, and files that did not
change keep their rows, including their `__acl` evidence. If the new version cannot
be downloaded or exceeds `max_file_size_mb`, the file keeps its last good rows and `__parse_errors` records the
failure. A deleted file keeps its rows until a `--full-refresh` run. Table
destinations apply this; file destinations write each run's rows as new files.

`__acl` rows now carry `document_id`. ACL rows loaded before this change have none,
so run one `--full-refresh` after upgrading if you capture permissions.

## Cloud storage

The resource files stay the same. Only the integration changes. Credentials are
always read from environment variables that you name in the integration.

Amazon S3, or an S3-compatible store with `endpoint` and `force_path_style`:

```yaml
spec_version: '1'
auth_env_vars: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY]
type: integration
name: landing
source_type: s3
connection:
  bucket: my-landing-bucket
  region: us-east-1
auth:
  type: static_env # required for custom endpoints; default_chain requires no endpoint
  access_key_id_env: AWS_ACCESS_KEY_ID
  secret_access_key_env: AWS_SECRET_ACCESS_KEY
```

Google Cloud Storage. `auth.type` is `adc` (Application Default Credentials),
`service_account_json` with `credentials_json_env`, or `service_account_path` with
`credentials_path_env`:

```yaml
spec_version: '1'
type: integration
name: landing
source_type: gcs
connection:
  bucket: my-landing-bucket
auth:
  type: adc
```

SFTP, with `password` or `private_key` auth. `connection.host_keys` is required:
it pins the server's host keys, in order of preference, and the client offers
only those key types during the handshake. A server that also has other key
types still connects with the pinned one. Each pin names its `algorithm`
(`ssh-ed25519`, `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`,
`ecdsa-sha2-nistp521` or `ssh-rsa`) and either the OpenSSH `fingerprint`
(`SHA256:...`), the base64 `public_key`, or both. Pin up to four keys, for
example the old and new key during a key rotation.

```yaml
spec_version: '1'
auth_env_vars: [SFTP_PRIVATE_KEY]
type: integration
name: partner_drop
source_type: sftp
connection:
  host: sftp.example.com
  username: dogsled
  base_directory: /outgoing
  host_keys:
    - algorithm: ssh-ed25519
      public_key: AAAAC3NzaC1lZDI1NTE5AAAAIEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9g
  read_concurrency: 4
auth:
  type: private_key
  private_key_env: SFTP_PRIVATE_KEY
```

`private_key` auth takes exactly one of `private_key_env` (an env var holding the
OpenSSH private key text) or `private_key_path_env` (an env var holding the path
to the key file). Add `passphrase_env` for an encrypted key.

Get the values from the server operator, or with `ssh-keyscan -t ed25519 host`
(the second and third fields of each line are `algorithm` and `public_key`) and
`ssh-keygen -lf` for the fingerprint. Verify them out of band before you pin them.

A Resource `path` without a glob may name one file, such as `exports/orders.csv`,
or a folder, which is walked. A path that does not exist fails with
`SFTP_PATH_NOT_FOUND`.

The listing reads regular files below `base_directory` only. It skips symbolic
links and special files, and a download that resolves outside `base_directory`
is refused. `read_concurrency` (1 to 16, default 4) caps the read requests in
flight on the connection. Raise it only when the server can handle it.

A stalled server fails the run after 60 seconds without progress, and a dropped
connection fails the run instead of skipping the remaining files. Connection
failures carry a stable `code`, for example `SFTP_HOST_KEY_MISMATCH`,
`SFTP_HOST_KEY_TYPE_UNAVAILABLE`, `SFTP_AUTH_FAILED`, `SFTP_TIMEOUT` or
`SFTP_CONNECTION_LOST`. The full list is exported as `SFTP_ERROR_CODES` from
`@bobsled-inc/extractor`.

A private Vercel Blob object uses `source_type: vercel_blob` with
`connection.blob_ref` and `auth: { type: signed_url_env, url_env, origin_env }`.
It reads one object per resource.

Each run reads at most 10,000 files, and skips files larger than 5 GiB with a
warning (document resources record them in `__parse_errors`). Change these limits
with `limits.max_files_per_run` and `limits.max_file_size_bytes` on the resource.
