# Extract from files

Dogsled reads CSV, JSON Lines and Parquet files, and parses documents (PDF, Word,
PowerPoint, HTML, Markdown, text and email) into text chunks. It can also copy files
of any kind without reading them. Files can come from a local folder, Amazon S3,
Google Cloud Storage, an SFTP server or a private Vercel Blob object.

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
the text, splits it into chunks by token count, and records what it could not parse.

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
- `chunk.strategy`: `recursive` (default) or `paragraph`. See [Chunk by paragraph](#chunk-by-paragraph).
- `chunk.max_tokens` (default 800), `chunk.overlap_tokens` (default 120, or 0 with
  `paragraph`) and `chunk.tokenizer` (`cl100k_base`, `o200k_base` or `p50k_base`).
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

An incremental run skips a file that did not change, even when a `parse` or `chunk`
setting changed or a new Dogsled version parses the format differently. Run once with
`--full-refresh` to parse and chunk every file again.

`__acl` rows now carry `document_id`. ACL rows loaded before this change have none,
so run one `--full-refresh` after upgrading if you capture permissions.

### Hidden HTML content

The HTML parser, which also reads HTML email bodies, drops the content of plainly hidden
containers: `article`, `aside`, `div`, `figure`, `footer`, `header`, `main`, `nav`,
`section` and `span` with the `hidden` attribute (except `hidden="until-found"`) or an inline
style that sets `display: none` and no other `display`. One example is the hidden container
around the machine data of an Inline XBRL report. `.xhtml` files are read by HTML rules too.

In every unclear case the text stays. For example, an element keeps its text when its tags
are not balanced, or when it holds a table, a form control, a comment or a script. So does
one with an inline style that uses quotes, brackets or escapes. If dropping would leave no
text besides the title, nothing is dropped. Nothing is dropped either when a style sheet might
show the content again: when the document links a style sheet, or has a `<style>` that
mentions `display` or `hidden`, sets `all`, imports another sheet, or uses a backslash, `&`
or `<`.

Text that a script shows later is dropped, and there is no setting to keep it. This is text
clean-up, not protection against hidden instructions: text hidden in other ways still reaches
the chunks.

### Chunk by paragraph

`strategy: recursive` fills each chunk up to `max_tokens` and repeats `overlap_tokens` from
the previous chunk. `strategy: paragraph` makes smaller chunks that follow the document's
own paragraphs:

```yaml
chunk: { strategy: paragraph, min_tokens: 60, max_tokens: 800 }
```

- Text is cut at blank lines. A paragraph shorter than `min_tokens` (default 60, or
  `max_tokens` when that is smaller) is joined with the ones after it until the chunk
  reaches `min_tokens`, but never above `max_tokens`. Joined paragraphs keep the blank lines
  between them.
- A paragraph above `max_tokens` is cut the way `recursive` cuts it. Only a single character
  that takes more tokens than `max_tokens` makes a longer chunk.
- A short last paragraph joins the chunk before it when both fit in `max_tokens`.
- Chunks do not overlap: `overlap_tokens` must be 0 or left out.

`min_tokens` is only valid with `paragraph`.

## Copy files as they are

Set `source.kind: copy` to move files without reading them. Each new file arrives at
the destination with the same bytes, whatever it is: CSV, gzip, Parquet, PDF, ZIP or
a file with no content at all. The source can be a local folder, S3, GCS or SFTP. The
destination must be a `local`, `s3` or `gcs` file destination. Validation also accepts a
`dogsled_managed` destination, which Dogsled Cloud turns into a concrete one before it
runs the project. Core cannot run that one, and the loader refuses any destination that
cannot write a file.

Create `resources/files/drops.yml`:

```yaml
spec_version: '1'
type: resource
name: drops
integration: files
source:
  kind: copy
  path: incoming/**/*
replication:
  method: incremental_append
  cursor: { field: last_modified, lookback_seconds: 3600 }
limits:
  max_file_size_bytes: 1073741824
  max_files_per_run: 500
```

A copy has no `format`, `compression`, `options`, `include_filename`,
`include_file_metadata` or `output`, and Dogsled refuses a Resource that sets one.
`replication` must be `incremental_append` with `cursor.field: last_modified`.

Run it with a destination, with `dogsled pipeline` or a `dogsled.yml` pipeline:

```bash
dogsled pipeline --integration files --resource drops --dest local --format jsonl --output-dir copies
```

```text
[INFO] Completed: files/drops (1 file(s), 8 bytes copied)
```

The loader's `format` does not change a copy, though a file destination still needs
one. A file lands at `<prefix>/<resource name>/<path below the folder before the first
wildcard>`. With `path: incoming/**/*`, the file `incoming/2026/report.csv` becomes
`<prefix>/drops/2026/report.csv`. A `stream_subfolder` on the destination adds a
folder after the resource name, as it does for rows. A file that exists at the
destination is replaced. On a disk that ignores case, such as a default macOS disk, names that
differ only in case replace each other, and so do names that differ only in the
Unicode form of an accented letter.

The loader refuses a name it would have to change: one with a backslash, a control
character, or an empty, `.` or `..` folder, or one that makes an S3 or GCS key over
1,024 bytes. The run then fails and names the file. S3 and GCS folder placeholders,
which are keys that end in `/`, are skipped with a warning.

**Which files a run takes.** On S3 and GCS the server sets each file's time. A run
remembers the newest one it copied (the watermark) and the files it copied within
`lookback_seconds` of it (1 hour unless you set it). The next run takes files at or
after the watermark minus the lookback, except those it copied unchanged, oldest first.
The lookback catches a file that lands late with an older time, such as a slow upload.
S3 dates an object from the start of its upload, so set `lookback_seconds` longer than
your slowest upload. A file whose time is older than that window, behind the newest
copied file, is not taken. The watermark never passes the present, so a store with a fast clock cannot hide
later files. GCS uses the time an object was created, because its modified time also
moves when only its metadata does, as a storage class change does. A change to the
source type, endpoint, bucket, host, base directory or `path` starts the copy over,
since the files it now reads may be older than the watermark. SFTP and local folders let a client set
any time, so they keep a record of each file, like other file Resources.

**Limits.** A file over `max_file_size_bytes` (5 GiB unless you set it) fails the run
and names the file; a copy never skips one without saying so. S3 takes at most 5 GiB in
one write, so `dogsled.yml` validation refuses a larger limit for an S3 destination. A
run copies at most `max_files_per_run` files (10,000 unless you set it), oldest first,
and the next run takes the rest. `--limit` caps the files in a run instead and saves no
state. A file the source cannot read, such as an S3 object in an archive storage class,
fails the run until it is restored or moved out of the folder.

The saved state grows with the files inside the lookback window on S3 and GCS, and with
every file on SFTP and local folders. A state backend that loads state over HTTP refuses
more than 8 MiB, so keep `lookback_seconds` small for a bucket that takes tens of
thousands of files in an hour.

**How a run moves data.** The extractor downloads each file as it is stored to a
temporary file and sends a [`FILE` message](../reference/protocol.md#data-messages-standard-output).
It downloads up to 8 files at a time, or one at a time from SFTP, so `read_concurrency`
still caps the reads on the connection. It pauses new downloads while the files waiting
on disk would pass 1 GiB, though one file is always taken, so a larger file still copies
on its own. The loader writes up to 8 files at a time and deletes each temporary file
after its write. A file removed between the listing and the download fails the run, and
the next run lists again. The extractor saves state only after every file it
sent is gone, so a failed run copies the same files again. Its `STATE` line carries the
run time only, and the saved state holds the rest. A file that is still being written
when a run reads it from a local folder or an SFTP server is copied as it stands, and
copied again when its size or time next changes.

A copy needs a loader reading the extractor's output through a pipe. Run it with
`dogsled pipeline`, or pipe `dogsled extract run` into `dogsled load run`. It refuses to
write to a terminal or a file, including `--output file`, and a run that has no loader
reading its pipe waits until you stop it. To preview a copy, pipe it into a loader that
writes to a folder you can delete:

```bash
dogsled extract run --integration files drops --limit 5 | dogsled load run --dest local --format jsonl --output-dir preview
```

A pipeline with a copy Resource takes one destination, of type `local`, `s3` or `gcs`.
A `dogsled.yml` pipeline that lists several is refused when the project is validated,
and so is any `--destinations-json` run, even with one entry.

A copy sends no rows, so `PIPELINE_SUMMARY` shows 0 records. Read the `METRIC` line
instead: `files_processed` and `bytes_downloaded` are in every successful run, and are 0
when it copied nothing.

S3 and GCS objects keep their bytes but not their own metadata, such as content type. GCS
objects stored with `Content-Encoding: gzip` are copied still compressed.

### Object metadata

An `s3` or `gcs` destination can tag every file a copy writes. Add `object_metadata` to the
destination in `dogsled.yml`:

```yaml
destinations:
  archive:
    type: s3
    bucket: example-bucket
    prefix: raw/
    format: parquet
    object_metadata:
      team: data
      cost-center: '4021'
```

The loader stores these entries on each copied object, and two more of its own that say
where the file came from:

| Key                       | Value                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `dogsled-source`          | The file's key in the source, with no bucket, scheme or host. Left out when it would not fit, see below  |
| `dogsled-source-modified` | The time the source says the file changed, as an ISO 8601 date-time. Left out when the source gives none |

Those two go on only when the destination sets `object_metadata`. With none, or an empty
map, a copied file gets no tags at all, so nothing about its source goes with it, such as
the folders above the one it was copied from.

Keys use lowercase letters, digits and dashes. Values are text and are not empty. A value is
stored percent-encoded, because S3 keeps only US-ASCII: decode it with `decodeURIComponent`.

S3 allows 2,048 bytes of metadata on one object, and GCS gets the same limit, so a Resource
works on both. Each value counts as encoded. S3 does not say whether it counts the
`x-amz-meta-` that comes before each key, so each key counts 11 bytes more. Project
validation refuses `object_metadata` that leaves no room for the two keys a copy adds and a
24-character time. A source key can be 1,024 bytes long, so it has no room set aside: for a
file whose key would pass the limit, the loader leaves `dogsled-source` off and logs a
warning that names the file, and the copy goes on.

A file at an existing key replaces the earlier copy and its metadata. A `local` destination
keeps no metadata, so it takes no `object_metadata`, and a write that is not a copy carries
none.

Values are literal text. A value that starts with `$`, or holds `${{ env.NAME }}`, is written
as it is, never read as an environment variable reference, so it needs no `auth_env_vars`
entry, and no environment value can reach an object's metadata through it. Put a run ID or a
pipeline name in the value itself. On the command line, pass `--object-metadata '{"team":"data"}'` to
`dogsled load run`.

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
`@bobsled-inc/extractor` and `@bobsled-inc/dogsled/sftp`. Library hosts can use
`SftpFileStorageClient` from that subpath, with `ssh2` installed, and pin a
download with `expected: { size, mtimeSeconds }`: a file that no longer matches
fails with `SFTP_FILE_CHANGED`. Passing the same `progress` object and target
again resumes a download after a retryable failure.

A private Vercel Blob object uses `source_type: vercel_blob` with
`connection.blob_ref` and `auth: { type: signed_url_env, url_env, origin_env }`.
It reads one object per resource.

Each run reads at most 10,000 files, and skips files larger than 5 GiB with a
warning (document resources record them in `__parse_errors`; a copy fails the run
instead). Change these limits with `limits.max_files_per_run` and
`limits.max_file_size_bytes` on the resource.

For a resource that reads rows, the file limit counts the files a run tries to
read. An incremental run does not
count the files it skips because it already read them, so a path with more
matching files than the limit still gives its newer files to later runs. When
more files are ready than one run may read, the run reads up to the limit, logs a
warning, and the next run continues with the rest. A file that fails to download
counts too, and counts again on each run, because it is never marked as read. A
`full_refresh` resource starts at the front on every run, so it reads the same
first files each time and never reaches the rest; it logs the warning too. A
one-off full refresh of an incremental resource stops at the limit as well, so the
table holds only those files until later runs add the rest. Raise
`limits.max_files_per_run` or narrow `source.path` so every file fits in one run.
A run lists the path until it reaches the file that would pass the limit, or the
end of the path. It reports every oversize file it passes, and a document
resource with `parse.on_error: fail` stops at the first one.

Saved state of a resource that reads rows keeps one entry of a few hundred bytes
for every file it has read, and keeps it after the file is gone. A resource that
has read a million files carries a state file of hundreds of megabytes. The HTTPS
state backend cannot load a state document over 8 MiB, which a few tens of
thousands of files fill. A copy has its own limit and state rules, described
under [Copy files as they are](#copy-files-as-they-are).
