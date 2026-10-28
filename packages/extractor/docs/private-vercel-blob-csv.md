# Private Vercel Blob CSV source

Dogsled can extract one private CSV object from Vercel Blob through an
object-scoped signed HTTPS URL. The stable object reference is part of the
integration and resource definition; the signed URL is supplied for the
execution attempt through environment indirection.

## Configuration

The `blob_ref` is the Vercel Blob pathname returned by the caller's
object store. It is provider-relative, has no leading slash, and must not
contain a query, fragment, glob, or `..` segment. The resource `source.path`
must repeat the exact same value. A `.csv` suffix is optional because
`format: csv` selects the parser.

```yaml
# integrations/private_attachment.yml
spec_version: '1'
type: integration
name: private_attachment
auth_env_vars: [DOGSLED_BLOB_URL, DOGSLED_BLOB_ORIGIN]
source_type: vercel_blob
connection:
  blob_ref: attachments/preview-example/project-uuid/attachment-uuid
auth:
  type: signed_url_env
  url_env: DOGSLED_BLOB_URL
  origin_env: DOGSLED_BLOB_ORIGIN
```

```yaml
# resources/private_attachment/rows.yml
spec_version: '1'
type: resource
name: rows
integration: private_attachment
source:
  kind: structured
  path: attachments/preview-example/project-uuid/attachment-uuid
  format: csv
  options:
    header: true
replication:
  method: full_refresh
output: {}
```

At runtime, `DOGSLED_BLOB_URL` contains a fresh, object-scoped signed URL issued by the storage provider, and `DOGSLED_BLOB_ORIGIN`
contains the exact allowed HTTPS origin returned alongside it. The URL and its
query are attempt-scoped secrets. They must not be written to pipeline YAML,
state, logs, emitted metadata, or a durable task record. A normal authored
pipeline may provide the same two environment values manually; the caller renews
them for every task attempt.

Dogsled deliberately uses the direct signed URL. The current Dogsled file clients
already own provider-relative listing and downloads, while the generic HTTP
client authenticates API requests and carries an integration base URL. It does
not bind one stable file reference to a separately supplied object-scoped URL,
or provide the file client’s single-object state and staging semantics. A
separate provider client keeps that binding explicit and reuses the existing
`FileStorageClient` and DuckDB CSV reader. No Vercel store token or
attachment authorization endpoint is required inside Dogsled.

The client requires the signed URL to be HTTPS, credential-free, and on the
declared allowed origin. Its decoded pathname must equal `blob_ref`. Redirects
are manual, limited to five hops, and must remain HTTPS on that same origin and
pathname. Dogsled never forwards an authorization header. URLs in errors are
sanitized so signed query parameters are replaced with `[redacted]`.

## Transfer and metadata behavior

The client does not issue `HEAD`. It streams the GET response into the normal
local staging file, counts bytes, and enforces `max_bytes` (250 MiB by default,
with an upper configuration bound of 5 GiB). The caller remains responsible for enforcing any application-specific
limit. Listing is local and emits the one stable object without remote
validators, so `full_refresh` is the appropriate replication mode; an
incremental resource may re-download when its prior bookmark is compared with
the validator-free listing result. It retries only network failures and HTTP 408, 429, 500, 502, 503, and
504, with bounded exponential backoff. HTTP 401/403, 404, redirects that leave
the object, parser errors, and size violations fail immediately.

`ETag`, `Last-Modified`, and `Content-Length` are read from the GET response
when present. Missing `HEAD`, `ETag`, or `Last-Modified` does not prevent a
load: the transfer computes a streaming SHA-256 digest as the fallback ETag
and records the actual byte count. The first response fingerprint is retained
across retries for successful object responses; validators from provider error
pages are ignored. If an ETag, Last-Modified value, or known size changes
during a retry, Dogsled fails rather than combining bytes from different object
versions. If an interrupted successful response supplies none of those
validators, Dogsled restarts from byte zero and cannot prove that the later
response is byte-identical; the partial file is still removed before retry.
If a validator or known size is present on one successful response but absent
on the next, Dogsled also fails closed instead of assuming the object is
unchanged.
The signed URL is refreshed by the caller for a later task attempt after an
expired or revoked URL response.

Cancellation is propagated to both the HTTP request and response-body stream.
An interrupted transfer or cancellation removes the partial staging file before
returning. The existing CSV reader handles quoting, embedded newlines, null and
empty values, and type conversion after the download completes. `include_file_metadata`
only controls whether `_file_*` columns are emitted; transfer validators and
integrity state remain active when it is omitted or set to `false`.

The caller owns object retention, URL renewal, destination table
identity, reconciliation, and final Snowflake table deletion. Dogsled owns the
download, CSV parsing, schema inference, and protocol records.
