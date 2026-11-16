---
name: add-custom-api-integration
description: Author a generic custom_api source for any REST/GraphQL API purely
  in YAML — inline transport (base_url + auth), one declarative resource per
  endpoint, then validate/verify/extract. Use when the API isn't in the bundled
  catalog.
---

# Add a custom API integration (`custom_api`)

Use this when a user wants to pull from a REST or GraphQL API that Dogsled does
**not** ship a bundled connector for. A `custom_api` source is **fully
self-describing**: you author a `source.yml` with an inline transport
(`base_url` + `auth`) and one declarative resource per endpoint. There is **no
per-connector code module** and **no catalog entry required** — the YAML runs
directly against the generic HTTP/REST/GraphQL extractor.

This skill owns custom API connector construction. Load `extract-pipelines`
for the authoritative contract on pipeline orchestration, filters and exact
operator vocabularies, pushdown, incremental state, validation, and operation.

When to use a different skill:

- The API already has a bundled connector → `explore-integration`.
- You have an OpenAPI spec and want to ship a first-party library integration →
  `add-integration`.
- The source is a warehouse/database → `add-warehouse-source`.
- The source is an MCP server → `mcp-discover`.

## Shape of a `custom_api` source

```text
<source-name>/
  source.yml          # source_type: custom_api, inline transport, auth_env_vars
  meta.yml            # display metadata (auth_setup is optional here)
  resources/
    <endpoint>.yml    # one declarative resource per endpoint
```

### Step 1 — Write `source.yml`

Declare the marker, the env vars the source needs, and a single inline HTTP
transport with `base_url` + `auth`. Auth types: `bearer`, `api-key`, `basic`,
`oauth2`, `aws-sigv4`. Secrets are **always** env-var indirection
(`${{ env.MY_TOKEN }}`) — never raw values.

```yaml
spec_version: '2'
type: source
source_type: custom_api # Dogsled-visible marker
bobsled_source_kind: custom_api # orchestrator/host application marker (Dogsled ignores it)
name: <source-name>
description: <one line>
auth_env_vars: # env vars the transport interpolates
  - <ENV_VAR_NAME>
transports:
  - id: default
    base_url: https://api.example.com
    auth:
      type: api-key # or bearer / basic / oauth2 / aws-sigv4
      header: x-api-key
      key: ${{ env.<ENV_VAR_NAME> }}
    timeout_ms: 30000
    retry:
      retry_on: [429, 500, 502, 503]
      max_retries: 3
      backoff: exponential
      retry_after_header: true
    rate_limit:
      requests_per_second: 10
      burst: 20
    headers:
      Accept: application/json
default_transport: default
```

Bearer auth instead:

```yaml
auth:
  type: bearer
  token: ${{ env.<ENV_VAR_NAME> }}
```

OAuth2 client credentials instead (Dogsled fetches and caches the token):

```yaml
auth:
  type: oauth2
  grant_type: client_credentials
  token_url: https://auth.example.com/oauth/token # HTTPS only
  client_id: ${{ env.<CLIENT_ID_ENV_VAR> }}
  client_secret: ${{ env.<CLIENT_SECRET_ENV_VAR> }}
  scopes: [read] # optional, sent as a space-separated `scope`
  resource: https://api.example.com/ # optional RFC 8707 resource, absolute HTTPS URL
```

Set `resource` only when the authorization server mints an audience-bound token
only for a named resource (RFC 8707 Resource Indicators) and otherwise returns a
token the API rejects. Dogsled sends it as a `resource` form parameter in the
token request; a token is never reused for a different `resource`.

> **SSRF:** `base_url` and every request go through the extractor's public-host
> enforcement — private/loopback/metadata hosts are blocked. The only escape
> hatch is the `BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1` process env var, which
> is **not** settable from YAML. `base_url` must be HTTPS.

### Step 2 — Write `meta.yml`

```yaml
display_name: <Human Name>
category: developer-tools # crm | marketing | finance | communication | analytics | cloud-infra | productivity | support | task-management
tags: [<tag>, <tag>]
docs_url: https://docs.example.com
# auth_setup is OPTIONAL for custom_api — env vars are declared in source.yml.
```

### Step 3 — One resource per endpoint

Each resource is declarative: `endpoint`, `method`, optional `query_params` /
`request_body`, `extract.record_path` (JSONPath to the record array), optional
`extract.pagination`, and `output` columns mapped by JSONPath `path`. Reference
inputs with `${{ input.<name> }}`.

```yaml
type: resource
name: <entity>
description: <what this endpoint returns>
api:
  endpoint: /things
  method: GET
  query_params:
    limit: ${{ input.limit }}
    offset: ${{ input.offset }}
input:
  limit: { type: integer, default: 100, minimum: 1, maximum: 100 }
  offset: { type: integer, default: 0, minimum: 0 }
output:
  id: { type: string, path: $.id, description: Unique id }
  name: { type: string, path: $.name }
  created_at: { type: timestamp, path: $.created_at }
extract:
  record_path: $ # $ for a root array, or e.g. $.data
  pagination:
    type: offset # offset | page_number | cursor | link_header | next_url | none
    offset_param: offset
    limit_param: limit
  table:
    primary_key: [id]
```

GraphQL endpoints use `method: POST` with a `request_body` carrying the query,
and `record_path` pointing into `$.data.<field>`.

#### JSONPath dialect (read this before guessing a path)

`output.<field>.path`, `output.<field>.paths`, and `extract.record_path` accept a
**narrow, deterministic** subset of JSONPath. Stay inside it — anything outside is
unspecced and fails **silently** (a zero-match column goes null with no error; a
multi-match returns an array that gets stringified into garbage for scalar fields).

**Supported (use only these):**

- `$` — the whole record
- `$.prop`, `$.a.b.c` — top-level / nested properties
- `$.arr[0]` — positive array index
- `$.data[-1].id` — negative index (from the end)
- property names must match `[A-Za-z_][A-Za-z0-9_]*` (Notion-style keys like
  `heading_1`, `rich_text` qualify)

**Not supported — never use in `path` / `paths` / `record_path`:** wildcards (`$.*`,
`$.a[*]`), recursive descent (`$..x`), quoted/bracket keys (`$['a-b']`), hyphenated
keys (`$.a-b`), filters (`$.a[?(@.x)]`), slices (`$.a[0:2]`), unions (`$.a[0,1]`).

For the full rationale and the failure modes, see the canonical reference:
`.agents/skills/extractor-query-authoring/SKILL.md` ("JSONPath dialect" section).

#### Retaining parent keys in `for_each` children

When an endpoint is called once per parent and its response omits the parent key,
declare the key in the child's `output` and source it from the parent's mapped
output:

```yaml
input:
  project_id: { type: integer, required: true }
output:
  id: { type: string, path: $.id }
  project_id:
    type: integer
    from: { resource: projects, path: $.id }
extract:
  for_each:
    resource: projects
    field: id
    input: project_id
  record_path: $.results
  table:
    primary_key: [project_id, id]
```

`from.resource` must be the immediate parent or a proven ancestor in the same
fan-out chain. The path is evaluated against that resource's declared, mapped
`output`, never its raw response, inputs, request headers, auth, or environment.
The child type must match the referenced output type, `from` cannot be combined
with `path` or `paths`, and nested paths require declared `properties`/`items` at
every traversed segment. Dogsled does not modify primary keys automatically; use an
explicit composite key when child IDs are only unique within a parent. A targeted
child run can reconstruct only an immediate-parent field exactly matched by an
explicit `for_each` input binding; all other ancestry must be co-scheduled.

#### Recipe: type-discriminated nested payloads

Some APIs put a value under a key **equal to the record's type**. The canonical case is
Notion blocks: ~30 block types, each carrying its text under a key named for the type —
`paragraph.rich_text`, `heading_1.rich_text`, `code.rich_text`, and so on. Because the
dialect has no wildcard or `$..` to say "whichever key is present," pick one of these
**supported** patterns:

**(a) Ordered `paths` fallback — one column, recommended.** List the discriminant keys in
priority order; the first tier-1 path that resolves wins (ahead of `default`):

```yaml
output:
  block_id: { type: string, path: $.id }
  block_type: { type: string, path: $.type }
  text:
    type: string
    paths:
      - $.paragraph.rich_text
      - $.heading_1.rich_text
      - $.heading_2.rich_text
      - $.code.rich_text
    default: null
```

**(b) One concrete column per discriminant key, then COALESCE in the silver model.** Use
when you want each variant preserved in bronze:

```yaml
output:
  paragraph_text: { type: string, path: $.paragraph.rich_text, default: null }
  heading_1_text: { type: string, path: $.heading_1.rich_text, default: null }
  code_text: { type: string, path: $.code.rich_text, default: null }
```

```sql
-- silver model
COALESCE(paragraph_text, heading_1_text, code_text) AS text
```

**(c) Capture the whole block, unfurl in model SQL.** Keep the raw shape and resolve
downstream:

```yaml
output:
  block: { type: object, path: $, default: null }
```

Pattern (a) needs no downstream SQL; (b)/(c) trade an extra model step for keeping the
raw variants. Cross-linked from `starter-models-notion`.

### Step 4 — Validate → verify → extract

```bash
dogsled extract validate <source-name>
dogsled extract verify <source-name>
dogsled extract verify <source-name> --mock
# then, with the env var exported:
dogsled extract run <source-name> --resource <entity> --limit 5
```

`verify` cross-checks every `${{ env.X }}` reference against the source's
`auth_env_vars` (bundled `<name>/source.yml` files can also use their `meta.yml` `auth_setup`) — keep them in sync.
Runtime interpolation also requires declarations for `optional_headers`. A declared variable that is absent or empty omits the header. An undeclared name fails before any request.

## Incremental sync (cursors)

By default a resource does a **full refresh** every run. To pull only new or
changed records, add an `extract.incremental` block. Dogsled persists a per-stream
**bookmark** as a `STATE` protocol message and, on the next run, uses it to ask
the API for only the rows past the last cursor value.

Core rules:

- Put `incremental` inside the resource's `extract:` block — the canonical
  placement used throughout this doc. A bare top-level `incremental:` is also
  accepted (but **never both**); prefer `extract.incremental`, because the
  `SCHEMA` message's `cursor_field` and the `topup` backfill command only honor
  that placement.
- `cursor_field` **must** be one of the declared `output` fields — it is the
  column whose value Dogsled tracks as the high-water mark.
- After a run the bookmark advances to the largest `cursor_field` value seen and
  is emitted as a `STATE` message (`{ cursor_field, cursor_type, cursor_value }`).
  Durable runs persist it. **`--limit` runs are always preview-only and never
  persist durable state**, including when state advancement is otherwise enabled.
- A resource with `extract.incremental` plus a `table.primary_key` makes the
  loader infer a `merge` (upsert) load strategy, and surfaces `cursor_field` on
  the `SCHEMA` message.

Choose one of four strategies via `strategy:`. Quick pick:

| pick            | when                                                                |
| --------------- | ------------------------------------------------------------------- |
| `cursor`        | the API echoes back one replay param (`?since=`, `?updated_after=`) |
| `filter`        | you must send explicit window bounds (since/until) on each call     |
| `server_filter` | the resource already declares a `query:` filter surface             |
| `full_refresh`  | the API has no server-side filter, but you still want upserts       |

### `cursor` — saved cursor sent back as a request parameter (default; HTTP only)

The simplest and most common case. Dogsled sends the saved cursor value back as a
request parameter named by `cursor_param`, so the API returns only newer rows.

| field          | required | meaning                                                          |
| -------------- | -------- | ---------------------------------------------------------------- |
| `cursor_field` | yes      | output field tracked as the high-water mark                      |
| `cursor_param` | yes      | request parameter that carries the saved cursor value            |
| `cursor_type`  | no       | `timestamp` \| `integer` \| `number` \| `string` (else inferred) |

`cursor_param` is routed automatically: it becomes a **query-string** parameter
for `GET` endpoints, or a **request-body** field for `POST` endpoints that
declare a `request_body` (use a dotted name like `filter.since` to target a
nested body field). You do not need to also declare it in `query_params`.

```yaml
type: resource
name: issues
description: Repository issues, fetched incrementally by update time.
api:
  endpoint: /repos/{owner}/{repo}/issues
  method: GET
  query_params:
    state: all
    per_page: ${{ input.per_page }}
input:
  per_page: { type: integer, default: 100, minimum: 1, maximum: 100 }
output:
  id: { type: integer, path: $.id }
  title: { type: string, path: $.title }
  updated_at: { type: timestamp, path: $.updated_at }
extract:
  record_path: $
  pagination: { type: page_number, page_param: page }
  incremental:
    strategy: cursor # optional — `cursor` is the default when omitted
    cursor_field: updated_at # must appear in output:
    cursor_param: since # the API returns rows updated after this value
    cursor_type: timestamp
  table:
    primary_key: [id]
```

The first run (no bookmark) fetches everything and records the max `updated_at`.
Each later run sends `?since=<bookmark>` and advances the bookmark.

For a **`POST` query endpoint**, the same `cursor_param` lands in the request
body instead of the query string — use a dotted name to nest it. This is the
shape for endpoints like `POST /runs/query`:

```yaml
type: resource
name: runs
description: Workflow runs, fetched incrementally by start time.
api:
  endpoint: /runs/query
  method: POST
  request_body:
    session_id: ${{ input.session_id }}
input:
  session_id: { type: string }
output:
  id: { type: string, path: $.id }
  start_time: { type: timestamp, path: $.start_time }
extract:
  record_path: $.runs
  incremental:
    strategy: cursor
    cursor_field: start_time
    cursor_param: filter.start_time # nests into request_body.filter.start_time
  table:
    primary_key: [id]
```

### `filter` — client-driven time windows (HTTP + MCP)

Use when the cursor must be expressed as an explicit time range, or when you
want bounded backfill windows. `since_argument` / `until_argument` /
`filter_argument` are the **names of the request parameters** that receive the
window bounds — Dogsled sets them directly on each request (query-string params
for `GET`, body fields for a `POST` with `request_body`, tool arguments for
MCP). No `${{ input.X }}` wiring is required.

| field                      | required | meaning                                                                |
| -------------------------- | -------- | ---------------------------------------------------------------------- |
| `cursor_field`             | yes      | output field tracked as the high-water mark                            |
| `since_argument`           | yes\*    | request parameter that receives the window **start**                   |
| `filter_argument`          | yes\*    | alias for `since_argument` (single-bound filters)                      |
| `until_argument`           | no       | request parameter that receives the window **end**                     |
| `value_format`             | no       | `iso8601` (default) \| `date` \| `unix_seconds` \| `unix_milliseconds` |
| `initial_lookback_seconds` | no\*\*   | how far back the very first run reaches (no bookmark yet)              |
| `lookback_seconds`         | no       | re-fetch this safety margin before the bookmark each run               |
| `window_size_seconds`      | no       | split the range into fixed chunks (requires `until_argument`)          |
| `cursor_type`              | no       | cursor data type (else inferred)                                       |

\* Exactly one of `since_argument` or `filter_argument` is required.
\*\* Required the first time a stream runs, when there is no bookmark yet.

```yaml
type: resource
name: events
description: Events fetched in daily time windows.
api:
  endpoint: /events
  method: GET
input: {} # the since/until args below are injected as request params, not declared inputs
output:
  id: { type: string, path: $.id }
  created: { type: timestamp, path: $.created }
extract:
  record_path: $.data
  incremental:
    strategy: filter
    cursor_field: created # an output field
    since_argument: created_after # → ?created_after=<window start>
    until_argument: created_before # → ?created_before=<window end>
    value_format: iso8601
    initial_lookback_seconds: 2592000 # first run reaches back 30 days
    window_size_seconds: 86400 # one request per day
    lookback_seconds: 3600 # 1h overlap to catch late updates
  table:
    primary_key: [id]
```

For a `POST` query endpoint, point the arguments at body fields (dotted names
nest into `request_body`), e.g. `since_argument: filter.start_time`.

### `server_filter` — time windows routed through the `query:` block (HTTP + MCP)

Same fields as `filter`, but the bounds are not sent as raw parameters. Dogsled
converts the window into `cursor_field gte <since>` / `lte <until>` and emits
them through the resource's `query.filters` block, reusing its `bind` / `compile`
targets. Use this when the resource already exposes a `query:` filter surface.
The `cursor_field` **must** be declared in `query.filters` with `gte` (and, if
you set `until_argument`, `lte`) operators.

```yaml
type: resource
name: events
description: Events fetched via query-filter time windows.
api:
  endpoint: /events
  method: GET
input:
  since: { type: string }
  until: { type: string }
output:
  id: { type: string, path: $.id }
  created: { type: timestamp, path: $.created }
query:
  filters:
    created: # = cursor_field, declared as a query filter
      operators: [gte, lte]
      bind:
        gte: { input: since } # window start binds to input.since
        lte: { input: until } # window end binds to input.until
extract:
  record_path: $.data
  incremental:
    strategy: server_filter
    cursor_field: created
    since_argument: since
    until_argument: until
    value_format: iso8601
    initial_lookback_seconds: 2592000
  table:
    primary_key: [id]
```

The `query.filters` `bind` / `compile` syntax, exact operator vocabularies, and
pushdown modes are documented authoritatively in
`.agents/skills/extract-pipelines/SKILL.md`. Maintainers implementing the
underlying query block can additionally use `extractor-query-authoring`.

### `full_refresh` — re-pull everything, still dedupe-able

No incremental windowing — every run fetches the full set — but pairing a
`table.primary_key` with `cursor_field` lets the loader merge/dedupe (upsert)
instead of appending blindly. Use when the API exposes no usable filter but you
still want upsert semantics.

```yaml
type: resource
name: things
description: All things, re-pulled each run and merged on the cursor.
api:
  endpoint: /things
  method: GET
input: {}
output:
  id: { type: string, path: $.id }
  updated_at: { type: timestamp, path: $.updated_at }
extract:
  record_path: $
  incremental:
    strategy: full_refresh
    cursor_field: updated_at # optional; merge/dedupe also needs the primary_key below
  table:
    primary_key: [id]
```

### Transport applicability

| strategy        | HTTP (`api:`) | MCP (`tool:`)                            |
| --------------- | ------------- | ---------------------------------------- |
| `cursor`        | ✅            | ❌ — needs a request param; MCP has none |
| `filter`        | ✅            | ✅ — bounds bind to tool `arguments`     |
| `server_filter` | ✅            | ✅                                       |
| `full_refresh`  | ✅            | ✅                                       |

For **MCP** (`tool:`) resources the `cursor` strategy's direct parameter
injection does not apply — there is no query string. Use `filter` or
`server_filter`; the window bounds are passed as the tool's own `arguments`.

> **⚠️ `cursor` on a `tool:` resource validates but does nothing.** Nothing
> rejects `strategy: cursor` on an MCP resource — `validate` and `verify` both
> pass, then every run silently full-refreshes because the cursor is never
> injected. On MCP, always use `filter` or `server_filter`.

`cursor_type` accepts `string | number | integer | timestamp`. Relative
durations (e.g. `2h`, `1d`) are valid **only** for `timestamp` cursors.

### Two things that look like incremental cursors but are not

- **`pagination.type: cursor`** is a _pagination_ strategy (walking pages within
  a single run). `incremental.strategy: cursor` is about _resuming across runs_.
  They are unrelated despite the shared word.
- **The `query:` block** declares caller-facing filters for ad-hoc queries;
  `extract.incremental` controls the extractor's own state windows.
  `server_filter` is the one place the two connect.

### Verify it end to end

Each step proves a different thing — only two live runs prove resumption:

```bash
dogsled extract validate <source>        # shape only: the incremental block parses
dogsled extract verify <source> --mock   # request shaping only — NOT cross-run resumption
# the two runs below need live credentials and prove the bookmark advances:
dogsled extract run <source> --resource <r>   # first run: full fetch, records the bookmark
dogsled extract run <source> --resource <r>   # second run: resumes from the bookmark
```

`verify --mock` runs a single pass from empty state, so it confirms the
cursor/filter params shape the request correctly but cannot prove the second run
resumes. Confirm resumption with two real runs.

## Filtering — author-time scope

Use `extract-pipelines` as the capability reference before authoring filters.
This skill only shows the custom-API binding pattern: declare a caller-facing
`query.filters` binding and compile provider-supported values to HTTP query
parameters. Unmatched `extract.where` predicates remain client-side.

```yaml
query:
  filters:
    last_edited_time:
      operators: [gte]
      compile: { gte: { mode: http_query, param: updated_since } }
      bind: { gte: { input: since } }
```

For exact extract-predicate and query-filter operator vocabularies,
`stop_when` sorting rules, compile modes, and incremental composition, use
`extract-pipelines`; do not infer them from this connector example.

### Static request matrices and input projections

Use a dogsled pipeline `input_matrix` when one endpoint must be requested for a
bounded set of typed combinations. The matrix keeps one Resource stream and
table. Dogsled expands axes in authored order and limits in-flight requests with
`concurrency`:

```yaml
resources:
  - resource: historical_outrights
    input_matrix:
      axes:
        tour: [pga, euro]
        year: [2024, 2025]
        market: [win, top_10]
      concurrency: 4
```

Each axis must name a Resource input and each value must pass that input's type,
enum, and range checks. Axes cannot be empty or exceed 10,000 Cartesian tuples.
Dogsled rejects duplicate normalized tuples and conflicts with `inputs`.
Matrices support explicit `extract.incremental.strategy: full_refresh` only.
The integration rate limiter covers all tuples and retries. A matrix can also
compose with `extract.for_each`, which runs every tuple for each parent record.

If the API does not echo a request parameter, preserve it with an input
projection:

```yaml
input:
  tour: { type: string }
output:
  requested_tour: { type: string, from: { input: tour } }
  player_id: { type: string, path: $.player_id }
```

`from.input` must reference a declared input with the same type as the output.
Use `from.resource` only for mapped values from a `for_each` ancestor.

## Worked example — LangSmith

LangSmith (LangChain's observability/eval platform) ships no bundled connector.
Base URL `https://api.smith.langchain.com`, `x-api-key` header auth (bearer is
also accepted), limit/offset pagination, root-array responses.

`langsmith/source.yml`:

```yaml
spec_version: '2'
type: source
source_type: custom_api
bobsled_source_kind: custom_api
name: langsmith
description: LangSmith observability and evaluation platform by LangChain.
auth_env_vars:
  - LANGSMITH_API_KEY
transports:
  - id: default
    base_url: https://api.smith.langchain.com
    auth:
      type: api-key
      header: x-api-key
      key: ${{ env.LANGSMITH_API_KEY }}
    timeout_ms: 30000
    retry:
      retry_on: [429, 500, 502, 503]
      max_retries: 3
      backoff: exponential
      retry_after_header: true
    rate_limit:
      requests_per_second: 10
      burst: 20
    headers:
      Accept: application/json
default_transport: default
```

> Bearer-token alternative (LangSmith also accepts `Authorization: Bearer`):
>
> ```yaml
> auth:
>   type: bearer
>   token: ${{ env.LANGSMITH_API_KEY }}
> ```

`langsmith/meta.yml`:

```yaml
display_name: LangSmith
category: developer-tools
tags: [observability, evaluation, llm, langchain]
docs_url: https://docs.smith.langchain.com
```

`langsmith/resources/datasets.yml` — a paginated list endpoint with JSONPath
record extraction off the root array:

```yaml
type: resource
name: datasets
description: List datasets in the LangSmith workspace.
api:
  endpoint: /datasets
  method: GET
  query_params:
    limit: ${{ input.limit }}
    offset: ${{ input.offset }}
input:
  limit: { type: integer, default: 100, minimum: 1, maximum: 100 }
  offset: { type: integer, default: 0, minimum: 0 }
output:
  id: { type: string, path: $.id, description: Unique dataset id (UUID). }
  name: { type: string, path: $.name }
  data_type: { type: string, path: $.data_type }
  example_count: { type: integer, path: $.example_count }
  created_at: { type: timestamp, path: $.created_at }
  modified_at: { type: timestamp, path: $.modified_at }
extract:
  record_path: $
  pagination:
    type: offset
    offset_param: offset
    limit_param: limit
  table:
    primary_key: [id]
```

Then:

```bash
export LANGSMITH_API_KEY=ls__...
dogsled extract validate langsmith
dogsled extract verify langsmith
dogsled extract run langsmith --resource datasets --limit 5
```

## Quality checklist

- `source_type: custom_api` and `auth_env_vars` are set; `base_url` is HTTPS.
- Every `${{ env.X }}` reference appears in `auth_env_vars`.
- Each resource has a non-empty `description`, ≥1 `output` field with a
  JSONPath `path` (or an ordered `paths` fallback — one or the other, not both),
  `extract.record_path`, and `extract.table.primary_key`.
- Paginated endpoints declare `extract.pagination` (or `extract.paginated:
false` for bounded lists).
- Incremental resources set `extract.incremental` with a `cursor_field` that
  exists in `output` (see **Incremental sync (cursors)** above).
- No raw secrets in YAML — env-var indirection only.
