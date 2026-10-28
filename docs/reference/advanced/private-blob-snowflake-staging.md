# Private Blob CSV to Snowflake staging

Dogsled can read one private Vercel Blob object through a fresh, object-scoped
signed HTTPS GET URL and load its CSV records into an exact Snowflake table. The
same project definition works with `dogsled pipeline` and a managed ETL task that
calls `runProjectPipeline`; it does not require a Blueprint deployment.

The orchestrator owns attachment authorization, retention, table reservation,
reuse, executor reconciliation, and eventual table deletion. Dogsled reads the
file and loads rows. The administrator creates the staging schema in the
destination connection's existing database before a guarded load runs.

## Project definition

`integrations/private_upload.yml`:

```yaml
spec_version: '1'
auth_env_vars: [PRIVATE_UPLOAD_ORIGIN, PRIVATE_UPLOAD_SIGNED_URL]
type: integration
name: private_upload
source_type: vercel_blob
connection:
  blob_ref: attachments/preview-example/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222
  max_bytes: 262144000 # 250 MiB; choose a ceiling for your own workload
auth:
  type: signed_url_env
  url_env: PRIVATE_UPLOAD_SIGNED_URL
  origin_env: PRIVATE_UPLOAD_ORIGIN
```

`resources/private_upload/uploaded_csv.yml`:

```yaml
spec_version: '1'
type: resource
name: uploaded_csv
source:
  path: attachments/preview-example/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222
  format: csv
  options:
    header: true
replication:
  method: full_refresh
output: {} # infer columns and types from the CSV
```

`dogsled.yml`:

```yaml
destinations:
  staging:
    auth_env_vars: [SNOWFLAKE_OIDC_TOKEN]
    type: snowflake
    account: MY_ACCOUNT
    username: DOGSLED_LOADER
    credentials_access_token: $SNOWFLAKE_OIDC_TOKEN
    warehouse: INGEST_WH
    database: ANALYTICS
    schema: ATTACHMENT_STAGING

pipelines:
  private_upload_stage:
    type: extract
    schedule: manual
    runner: managed
    source: private_upload
    destination: staging
    load_strategy: full_refresh
    resources:
      - resource: uploaded_csv
        table: DS_CSV_22222222222242228222222222222222
        table_ownership_marker: temp-dataset-22222222-2222-4222-8222-222222222222
```

The resource `source.path` and integration `connection.blob_ref` must match.
They are the stable Vercel pathname, without a leading slash, query, fragment,
or glob. Vercel Blob pathnames need not end in `.csv`; `format: csv` selects the
parser. Object identifiers and original filenames are separate metadata.
The `table` override is an exact, case-preserved, unqualified table identifier in the named
destination's database and schema. The caller reserves it before execution and supplies a stable
`table_ownership_marker` for retries and rebuilds.
The existing Snowflake loader uppercases CSV column identifiers: `domain` lands
as `DOMAIN`, `Company Name` as quoted `COMPANY NAME`, and `MiXeD` as `MIXED`.
Consumers that rewrite CSV queries need this original-header to destination
column mapping. Quoted identifiers with spaces still need a live Snowflake
integration check before relying on them in generated SQL.

## Runtime values

For each task attempt, the authorized attachment service issues a signed GET
URL scoped to the saved `blob_ref`, then supplies:

| Environment variable        | Value                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PRIVATE_UPLOAD_SIGNED_URL` | Fresh signed HTTPS GET URL for that object                                                              |
| `PRIVATE_UPLOAD_ORIGIN`     | Its trusted HTTPS origin, such as `https://example.public.blob.vercel-storage.com`                      |
| `SNOWFLAKE_OIDC_TOKEN`      | Destination token valid for the load, or use the connection's supported refreshable token configuration |

The destination credential placeholder above illustrates ordinary authored Dogsled
configuration. An authored pipeline supplies the same environment variables from its
own secret manager. Neither the temporary URL nor a Blob store-wide token is
saved in YAML or a manifest. A new ETL attempt receives a new URL; an expired
or revoked URL produces an authentication error rather than falling back to a
different object. The runner must ensure URL and destination credentials remain
valid for the attempt, or renew them through a supported runtime credential
mechanism. Signed URL query parameters must stay out of logs and error output.

## Transfer and ownership behavior

Dogsled uses HTTPS GET for the single object and does not require HEAD, listing,
or globbing. The GET response supplies `ETag`, `Last-Modified`, and size when
available. A missing ETag uses a content digest; a missing Last-Modified is
null metadata. A missing Content-Length does not disable the configured byte
ceiling. Retries restart the transfer into a cleaned temporary path. Redirects
must remain on the trusted HTTPS origin; credentials are never forwarded to an
unapproved host. Cancellation removes the partial download and stops parsing.

For a guarded Snowflake load, Dogsled requires the existing staging schema and
creates the reserved table with its ownership marker in the same `CREATE TABLE
IF NOT EXISTS` statement. It verifies the persisted marker before modifying a
table, including on a rebuild or retry. A missing schema, insufficient
privileges, or an existing table with a different marker fails the load. The caller
reconciles the previous executor before rebuilding at the same coordinates.
Dogsled does not delete the final table.
