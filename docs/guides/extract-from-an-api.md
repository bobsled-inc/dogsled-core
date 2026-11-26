# Extract from an API

This guide shows how to write an integration for a REST API that Dogsled does not
ship: authentication, pagination and incremental loads. The examples use a fictional
help-desk API at `https://api.example.com/v1` that returns tickets.

If the API is in the [integration library](../reference/connectors.md#library-integrations),
start from that instead: see [Use library integrations](use-library-integrations.md).

## Scaffold the files

`dogsled extract init` writes an `extractor.yml`, an integration and one resource:

```bash
dogsled extract init . --integration helpdesk
rm resources/helpdesk/items.yml
```

The scaffold is a commented starting point. This guide replaces
`integrations/helpdesk.yml` and removes the example `items` resource.

## Describe the API

The integration holds everything that is shared by all requests: the base URL,
authentication, headers, retries and rate limits.

Create `integrations/helpdesk.yml`:

```yaml
spec_version: '1'
type: integration
name: helpdesk
description: Fictional help-desk API
auth_env_vars: [HELPDESK_TOKEN]
transport:
  type: http
  base_url: https://api.example.com/v1
  auth:
    type: bearer
    token: ${{ env.HELPDESK_TOKEN }}
  headers:
    Accept: application/json
  timeout_ms: 30000
  retry:
    retry_on: [429, 503]
    max_retries: 3
    backoff: exponential
    retry_after_header: true
  rate_limit:
    requests_per_second: 10
    burst: 20
```

`${{ env.HELPDESK_TOKEN }}` reads the token from an environment variable when the
request is sent. List the name in `auth_env_vars` before using it. The value stays
out of your files. Dogsled also keeps it out of its output, logs and state files.

## Describe a resource

A resource is one endpoint that becomes one table. This one reads
`GET /tickets`, which returns a page of tickets under `data` and the page count
under `meta.total_pages`:

```json
{
  "data": [
    { "id": 1, "subject": "Ticket 1", "status": "open", "updated_at": "2026-01-01T00:00:00.000Z" }
  ],
  "meta": { "page": 1, "total_pages": 3 }
}
```

Create `resources/helpdesk/tickets.yml`:

```yaml
spec_version: '1'
type: resource
name: tickets
integration: helpdesk
description: Support tickets, oldest change first
input: {}
api:
  endpoint: /tickets
  method: GET
  query_params:
    per_page: '3'
output:
  id: { type: integer, path: $.id }
  subject: { type: string, path: $.subject }
  status: { type: string, path: $.status }
  updated_at: { type: timestamp, path: $.updated_at }
extract:
  record_path: $.data
  pagination:
    type: page_number
    page_param: page
    total_pages_path: $.meta.total_pages
  incremental:
    cursor_field: updated_at
    cursor_param: updated_since
  table:
    primary_key: [id]
```

- `query_params` values are strings, so quote numbers.
- `record_path` selects the list of records in each response.
- `output` maps each column to a JSONPath inside one record, with a type: `string`,
  `integer`, `number`, `boolean`, `timestamp`, `array` or `object`.
- `pagination` tells Dogsled how to ask for the next page. Here it adds
  `page=2`, `page=3` and so on until it reaches `meta.total_pages`.
- `incremental` makes later runs ask only for changes. Dogsled remembers the
  highest `updated_at` it has seen and sends it as `updated_since`.
- `primary_key` lets the loader merge changed rows instead of appending duplicates.

## Validate and test

Check the files, and that every environment variable they use is set:

```bash
export HELPDESK_TOKEN=your-token
dogsled extract validate helpdesk --check-env
```

`dogsled extract scaffold-test helpdesk` then calls the API with your credentials and
reads the first page of each resource. That confirms that authentication and the
`record_path` work before you run a full extraction:

```text
✓ tickets   200 (3 records)
Result: 1 passed of 1 resources
```

## Run it

Extract the tickets and load them into DuckDB. `--advance-state` tells Dogsled to
save the incremental cursor when the extraction succeeds:

```bash
dogsled extract run --integration helpdesk tickets --advance-state --quiet \
  | dogsled load run --dest duckdb --db-path helpdesk.duckdb
dogsled query "SELECT id, status, updated_at FROM tickets ORDER BY id" --db-path helpdesk.duckdb
```

```text
[loader] tickets: strategy=merge
[loader] tickets: loaded 7 rows
...
id	status	updated_at
1	open	2026-01-01T00:00:00.000Z
2	closed	2026-01-02T00:00:00.000Z
...
7	open	2026-01-07T00:00:00.000Z
```

The resource has an incremental cursor and a primary key, so the loader picks the
`merge` strategy: a row whose key already exists is updated instead of duplicated.

## Load only what changed

The cursor is now in `.extractor/state.json`:

```bash
cat .extractor/state.json
```

```text
"cursor_value": "2026-01-07T00:00:00.000Z"
```

The next run sends `updated_since=2026-01-07T00:00:00.000Z`, so the API returns only
tickets that changed since then. Here, ticket 1 was closed and ticket 8 was opened:

```bash
dogsled extract run --integration helpdesk tickets --advance-state --quiet \
  | dogsled load run --dest duckdb --db-path helpdesk.duckdb
dogsled query "SELECT count(*) AS tickets, count(*) FILTER (WHERE status = 'open') AS open FROM tickets" \
  --db-path helpdesk.duckdb
```

```text
[loader] tickets: loaded 2 rows
...
tickets	open
8	3
```

Without `--advance-state`, `extract run` reads from the saved cursor but does not
move it. That is useful for previews: runs with `--limit` never save state.

`--advance-state` saves the cursor even if the load that follows fails. To save it
only after a successful load, capture the extraction to a file, load the file, and
then commit the state from the same file:

```bash
dogsled extract run --integration helpdesk tickets --quiet > capture.jsonl
dogsled load run --dest duckdb --db-path helpdesk.duckdb < capture.jsonl
dogsled extract commit-state --integration helpdesk --capture-file capture.jsonl
```

To start again from the beginning, add `--full-refresh` to `extract run`. To keep
state somewhere other than the local file, for example a shared HTTPS endpoint, pass
`--state-backend` or set `DOGSLED_STATE_BACKEND`.

## Authentication types

Set `transport.auth.type` to one of these. Put every secret in an environment
variable with `${{ env.NAME }}`.

| Type                                           | Fields                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `none`                                         | None.                                                                                                     |
| `bearer`                                       | `token`                                                                                                   |
| `api-key`                                      | `key`, and `header` or `query_param`                                                                      |
| `basic`                                        | `username`, `password`                                                                                    |
| `oauth2` with `grant_type: client_credentials` | `token_url` (HTTPS), `client_id`, `client_secret`, optional `scopes`                                      |
| `oauth2` with `grant_type: authorization_code` | as above plus `refresh_token`, optional `token_prefix`                                                    |
| `custom-token`                                 | `token_url` (HTTPS), optional `token_request`, `token_response_path`, `token_prefix`, `token_ttl_seconds` |
| `aws-sigv4`                                    | `region`, `service`, `access_key_id`, `secret_access_key`, optional `session_token`                       |

A `custom-token` request that gets 429, 500, 502, 503 or 504 is retried with the
transport's `retry` backoff and `Retry-After` handling, within 30 seconds. A token
endpoint that answers 400, 401 or 403 fails as an authentication error at once. Any
other failed token request keeps its HTTP status, and 429 and 5xx stay retryable.

## Timeouts and retries

A request that reads, such as a page of a resource, is sent again when an attempt:

- times out,
- loses its connection before or while it reads the response, with a reset
  (`ECONNRESET`), a broken pipe (`EPIPE`), a timeout (`ETIMEDOUT`, or a connect,
  headers or body timeout from the HTTP client) or "other side closed"
  (`UND_ERR_SOCKET`),
- gets HTTP 429, 502, 503 or 504.

`timeout_ms` is the time one attempt gets, from sending the request to reading the
last byte of the response. A retry starts a new clock, so a slow page near the limit
costs one attempt, not the run. The default is 30 seconds.

A read makes up to 5 attempts by default. Under `retry`, `max_retries` (0 to 10)
sets the retries after the first attempt, where `0` turns retries off, and `retry_on`
replaces the list of statuses. Any other status ends the request. So does a size
limit, a response that is not valid JSON, a TLS or HTTP parser error, and a request
that Dogsled refuses before it sends it, such as one to a private host name, because
another attempt would fail the same way. Cancelling a run stops it at once and never
retries.

The wait before a retry is the `Retry-After` header, up to 5 minutes, when the API
sends one and `retry_after_header` is not `false`. Otherwise `backoff: exponential`
waits a random time of up to 1 second after the first failure, 2 seconds after the
second, then 4 and 8, never more than 30 seconds. `backoff: fixed` waits 1 second.

Each retry writes a warning to the run log, a `LOG` message with `level: warn`,
`event: http.request_retry` and the attributes `resource`, `attempt`,
`max_attempts`, `reason` (`timeout`, `connection`, `response_body` or
`http_status`), `detail`, `wait_ms` and, when the API answered, `status`. After the
last attempt the run fails with an error that says how many attempts ran and why
the last one failed.

An Action and an activation sync change data, so they keep their earlier retry
behavior. For them `timeout_ms` is one deadline for the request and its waits, and
the client retries HTTP 429 and 503, or the statuses in `retry_on`, and any error
before a response, up to 3 times by default. An activation sync also retries by
itself, as `error_handling` says.

## Pagination types

| Type          | How it gets the next page                          | Fields                                                                          |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `none`        | One request.                                       | None.                                                                           |
| `link_header` | Follows the `Link: <…>; rel="next"` header.        | None.                                                                           |
| `cursor`      | Sends the cursor from the response as a parameter. | `cursor_path`, `cursor_param`                                                   |
| `offset`      | Increments an offset.                              | `offset_param`, `limit_param`, `total_path` (all optional)                      |
| `page_number` | Increments a page number.                          | `page_param`, `per_page_param`, `total_pages_path`, `start_page` (all optional) |
| `next_url`    | Requests the URL found in the response.            | `next_url_path`                                                                 |

## Incremental strategies

The `incremental` block above uses the default `cursor` strategy: it sends the last
cursor value as `cursor_param`. Three other strategies exist:

- `filter` and `server_filter` send the cursor through `since_argument`,
  `until_argument` or `filter_argument`, with `value_format` (`iso8601`, `date`,
  `unix_seconds`, `unix_milliseconds`), optional look-back and fixed-size windows.
- `full_refresh` reads everything on every run.

## Other extract commands

- `dogsled extract discover helpdesk` lists the resources of an integration.
- `dogsled extract health-check helpdesk` makes one lightweight request.
- `dogsled extract lookup --integration helpdesk --resource <name> --input id=42`
  fetches single records when a resource defines a `lookup` operation.
- `dogsled extract topup --integration helpdesk --resource tickets --since 2d`
  extracts a cursor range without moving the saved state.
- `dogsled extract verify helpdesk` runs the offline checks that library
  integrations must pass, such as a `meta.yml` with a documentation link and the
  declared environment variables, and compares the resources with an OpenAPI
  document when one is configured.

The [CLI reference](../reference/cli.md#dogsled-extract) lists every flag, and
[Project files](../reference/project-files.md#resources) lists every resource field.
