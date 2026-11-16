---
name: add-custom-api-integration
description: Author a generic custom_api source for any REST/GraphQL API purely in YAML — inline transport (base_url + auth), one declarative resource per endpoint, then validate/verify/extract. Use when the API isn't in the bundled catalog.
exposed: true
triggers:
  - custom api
  - rest api
  - graphql api
  - source not in catalog
  - add api not in catalog
  - api we dont ship a connector for
  - langsmith
  - self-describing source
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

{{include: packages/extractor/docs/incremental-cursors-reference.md}}

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
