---
name: add-integration
description: Add a new API integration to the @bobsled-inc/integrations library.
  Automates OpenAPI spec discovery, YAML generation, curation, and validation.
---

# Add Integration

Automates adding a new API integration to `packages/integrations/`. Leverages `dogsled extract generate` for OpenAPI-based generation, with fallback to manual authoring.

## Usage

```
/add-integration <service-name>
```

Example: `/add-integration stripe`

## Workflow

### Step 1: Check if integration already exists

```bash
ls packages/integrations/integrations/<name>/
```

If it exists, ask the user whether to regenerate/update or abort.

### Step 2: Find the OpenAPI spec

1. Search the web for `<service-name> OpenAPI spec` or `<service-name> API specification`
2. Common locations:
   - GitHub repos (e.g., `github.com/<org>/openapi`)
   - Official docs (e.g., `docs.<service>.com/openapi.json`)
   - SwaggerHub, APIs.guru
3. If no OpenAPI spec exists, fall back to **manual authoring** (Step 2b)

### Step 2b: Manual authoring (no OpenAPI spec)

1. Fetch the API documentation using WebFetch
2. Identify the base URL, auth method, and key endpoints
3. Write `integration.yml` and resource YAMLs by hand following the patterns in `packages/integrations/integrations/_template/`
4. Skip to Step 5

### Step 3: Generate YAMLs from OpenAPI

```bash
cd packages/dogsled && pnpm dev extract generate <openapi_url> --directory /tmp/integration-staging --integration <name>
```

Read all generated files in `/tmp/integration-staging/`.

### Step 4: Review and curate

1. Read each generated file
2. Resolve all `# REVIEW:` annotations — make decisions, remove the markers
3. **Curate resources** — keep the most useful endpoints (the 80% use case):
   - Keep: list endpoints, get-by-id endpoints, search endpoints
   - Remove: internal/admin-only endpoints, webhook management, bulk operations
4. For large APIs (e.g., AWS with 200+ services), ask the user which resource groups to include
5. **Wire up `for_each` for child endpoints** — If a resource's endpoint contains a path parameter referencing a sibling resource (e.g., `/campaigns/${{ input.campaign_id }}/leads`), add a `for_each` block in the `extract` section:

   ```yaml
   extract:
     for_each:
       resource: campaigns # sibling resource to iterate over
       field: id # field from the parent resource
       input: campaign_id # maps to this resource's required input
       concurrency: 1 # optional, 1..64 — iterations in flight. Default 1 (sequential).
   ```

   The test suite will catch missing `for_each` configs automatically.

   If the child response does not repeat the parent key, retain it by declaring a
   typed contextual field in the child's canonical `output` schema:

   ```yaml
   output:
     campaign_id:
       type: string
       from:
         resource: campaigns
         path: $.id

   extract:
     for_each:
       resource: campaigns
       field: id
       input: campaign_id
     table:
       primary_key: [campaign_id, id]
   ```

   `from.resource` must be the immediate parent or a proven ancestor in the same
   `for_each` chain. `from.path` resolves only through that ancestor's declared,
   mapped `output`; it cannot expose inputs, raw responses, headers, auth, or
   environment values. The child field type must match the referenced output type,
   and `from` cannot be combined with `path` or `paths`. Nested paths require the
   ancestor output to declare the traversed `properties`/`items` shape. Dogsled does
   not add contextual fields to the primary key, so declare a composite key
   explicitly when child IDs are parent-scoped. A targeted child run can reconstruct
   only an immediate-parent field exactly matched by an explicit `for_each` input
   binding; all other ancestry must be co-scheduled.

   **`concurrency:` notes.** Default `1` keeps the legacy sequential behavior. Raising it overlaps in-flight iterations against the existing integration `rate_limit` token bucket — the rps cap from `integration.yml` remains absolute, so setting `concurrency` above `rate_limit.burst` just queues against the bucket. Raise it for large fan-outs where per-request RTT (not the rps budget) is the bottleneck (e.g. thousands of child reads against a 3 rps API). A failing iteration logs a warning and does not cancel siblings.

6. **Add incremental sync where supported** — if an endpoint exposes a
   since/updated-after parameter or time filter, set `extract.incremental` so
   the connector pulls only new or changed rows instead of full-refreshing every
   run (see **Incremental sync (cursors)** below).
7. Ensure every resource has:
   - A non-empty `description`
   - `extract.table.primary_key` set
   - At least one output field with a valid JSONPath
   - HTTPS-only URLs

### Step 5: Create `meta.yml`

Create `packages/integrations/integrations/<name>/meta.yml` with:

```yaml
display_name: <Human-readable name>
category: <one of: developer-tools, crm, marketing, finance, communication, analytics, cloud-infra, productivity>
tags: [<relevant tags>]
logo_url: <favicon or logo URL>
docs_url: <official API docs URL>
openapi_url: <source OpenAPI spec URL, if used>
auth_setup:
  - env: <ENV_VAR_NAME>
    description: <what this token/key is>
    docs_url: <link to auth docs>
```

Declare every referenced environment variable in `auth_env_vars`, including optional headers. Bundled `<name>/source.yml` files can also use declarations from their `meta.yml` `auth_setup`. Optional headers are omitted when a declared variable is absent or empty.

### Step 6: Move to library

```bash
mkdir -p packages/integrations/integrations/<name>/resources
```

Copy finalized `integration.yml` and resource YAMLs into position:

- `packages/integrations/integrations/<name>/integration.yml`
- `packages/integrations/integrations/<name>/meta.yml`
- `packages/integrations/integrations/<name>/resources/<resource>.yml`

### Step 7: Validate and check against OpenAPI spec

Run validation and OpenAPI diff checks — these catch most config issues without needing API credentials:

```bash
# Static validation: schema correctness + input completeness
dogsled extract validate --integration <name>

# OpenAPI spec diff: endpoint mismatches, field type drift, missing fields
# Auto-resolves the OpenAPI URL from meta.yml if openapi_url is set
dogsled extract check <name>

# Or provide the URL explicitly:
dogsled extract check <name> --openapi <openapi-url-or-path>
```

**Fix all errors before proceeding.** Warnings are informational — review but don't necessarily fix:

| Severity | Action                                                                      |
| -------- | --------------------------------------------------------------------------- |
| `error`  | Must fix: endpoint not found, method mismatch, missing required body fields |
| `warn`   | Review: field type mismatches, pagination drift, aggressive rate limits     |
| `info`   | Optional: API fields not yet mapped in resource output                      |

### Step 8: Smoke test auth

If the user has API credentials available, run:

```bash
dogsled extract test-auth <name>
```

All resources should return 200. If failures occur:

- Check `integration.yml` auth config `${{ env.* }}` references match the actual env var names
- Verify env vars match `meta.yml` `auth_setup` entries
- Confirm API endpoints are correct and accessible

If no credentials are available, note that and move on.

### Step 9: Run tests

```bash
pnpm --filter @bobsled-inc/integrations test
```

All tests must pass. Fix any failures before proceeding.

### Step 10: Report

Print a summary:

```
Added integration: <name>
  Display name: <display_name>
  Category: <category>
  Resources: <count> (<list of names>)
  Auth: <env var names>
```

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

## Quality Requirements

- Zero `# REVIEW:` annotations in final files
- Every resource has `extract.table.primary_key`
- Every resource has ≥1 output field
- All URLs use HTTPS
- `integration` field in each resource matches the directory name
- No duplicate endpoints within an integration
- Child endpoints must have `for_each` wired to their parent resource
- Resources with a usable cursor parameter declare `extract.incremental`, and
  `cursor_field` references an output field
- All integration tests pass after adding

## Categories

| Category          | Examples                                          |
| ----------------- | ------------------------------------------------- |
| `developer-tools` | GitHub, GitLab, Bitbucket, Jira, Linear, CircleCI |
| `crm`             | Salesforce, HubSpot, Pipedrive, Close             |
| `marketing`       | Mailchimp, Sendgrid, Brevo, ActiveCampaign        |
| `finance`         | Stripe, QuickBooks, Xero, Plaid                   |
| `communication`   | Slack, Discord, Twilio, Intercom                  |
| `analytics`       | Google Analytics, Mixpanel, Amplitude, PostHog    |
| `cloud-infra`     | AWS, GCP, Azure, Datadog                          |
| `productivity`    | Notion, Airtable, Google Sheets, Asana            |
