# @bobsled-inc/extractor

This workspace is bundled inside `@bobsled-inc/bobsled-core` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

YAML-driven extraction CLI built on the canonical extractor framework.

The extractor now uses `provider` and `resource` specs everywhere. Providers define shared HTTP transport defaults. Resources define extract operations, lookup operations, output mapping, pagination, and incremental state.

## Install

```sh
pnpm install
pnpm --filter @bobsled-inc/extractor build
```

## Quick Start

```sh
# Scaffold a project
dogsled extract init my-project --integration github
cd my-project

# Validate all specs
dogsled extract validate

# Validate one provider or one resource
dogsled extract validate github
dogsled extract validate github/issues

# List resources for a provider
dogsled extract discover github

# Run one or more resources
dogsled extract run --integration github issues repos
```

## Project Layout

```text
my-project/
  extractor.yml
  providers/
    github.yml
  resources/
    github/
      issues.yml
      repos.yml
  .extractor/
    state.json
  output/
  batch/
```

`extractor.yml` accepts an optional `default_load: { integration, overrides?, defaults? }` block — the load destination used for resources that don't carry their own `load:` block. Resource-level `load:` takes precedence over `default_load:`. See [@bobsled-inc/loader](../loader) for the full shape.

Load destinations live **inline on each resource** (a `load:` block on the resource YAML) — there is no separate `targets/` folder. The legacy top-level `target:` field on resources and `default_target:` on `extractor.yml` are still accepted for backward compatibility and are deprecated; prefer the `load:` / `default_load:` shape described here.

## Provider Spec

Providers own shared transport defaults.

```yaml
spec_version: '1'
type: integration
name: github
auth_env_vars: [GITHUB_READ_TOKEN, ACTING_USER]
description: GitHub REST API
transport:
  type: http
  base_url: https://api.github.com
  auth:
    type: bearer
    token: '${{ env.GITHUB_READ_TOKEN }}'
  timeout_ms: 30000
  retry:
    retry_on: [429, 503]
    max_retries: 3
    backoff: exponential
    retry_after_header: true
  rate_limit:
    requests_per_second: 10
    burst: 20
  headers:
    Accept: application/vnd.github.v3+json
  # Sent only when every referenced variable resolves to a non-empty value;
  # omitted otherwise instead of failing the request. Use it for values the
  # executing host supplies per request (an acting-user assertion, a tenant
  # hint). Declare these names in auth_env_vars even when they are optional.
  # A `headers` entry with the same name always wins.
  optional_headers:
    x-acting-user: '${{ env.ACTING_USER }}'
```

## Resource Spec

Resources describe how to read data. A Resource may support extraction, lookup, query, or a mix of
these operations. The `extract` block is only needed when the Resource can run in a pipeline.

```yaml
spec_version: '1'
type: resource
name: issues
provider: github
description: Extract issues for a repository

api:
  endpoint: '/repos/${{ input.owner }}/${{ input.repo }}/issues'
  method: GET
  query_params:
    per_page: '${{ input.per_page }}'
    state: all

input:
  owner:
    type: string
    default: bobsled-inc
  repo:
    type: string
    default: demo-repo
  per_page:
    type: integer
    default: 100

output:
  id:
    type: integer
    path: '$.id'
  title:
    type: string
    path: '$.title'
  updated_at:
    type: timestamp
    path: '$.updated_at'

# Optional inline load block — when present, routes this resource's records
# to the named destination integration on the load side. Overrides the
# project-level `default_load:` in extractor.yml. See @bobsled-inc/loader
# for the full schema. If omitted, the loader falls back to
# extractor.yml.default_load, then to --load-file, then errors.
load:
  integration: main_warehouse
  overrides:
    schema: raw_github
  defaults:
    load_strategy: merge

extract:
  record_path: '$'
  pagination:
    type: link_header
  incremental:
    cursor_field: updated_at
    cursor_param: since
    cursor_type: timestamp
  table:
    primary_key: [id]
    # load_strategy: merge  # optional — auto-derived from incremental + primary_key

lookup:
  description: Fetch one issue by number
  api:
    endpoint: '/repos/${{ input.owner }}/${{ input.repo }}/issues/${{ input.id }}'
    method: GET
  input:
    owner:
      type: string
      default: bobsled-inc
    repo:
      type: string
      default: demo-repo
    id:
      type: string
      required: true
```

A lookup-only Resource does not need an extraction endpoint or an `extract` block:

```yaml
type: resource
name: user
via: default
description: Look up one user by ID

output:
  id:
    type: string
    path: '$.id'
  name:
    type: string
    path: '$.name'

lookup:
  description: Look up one user by ID
  api:
    endpoint: '/users/${{ input.user_id }}'
    method: GET
  input:
    user_id:
      type: string
      required: true
  extract:
    record_path: '$.data.user'
```

Run this Resource with `dogsled extract lookup`. An extraction run or extraction plan rejects it
because it has no extraction operation.

## Parent context in fan-out records

Use `extract.for_each` when a child endpoint must be requested once for every
record emitted by another resource. If the child response does not repeat the
parent identifier, declare that identifier as a normal child `output` field and
source it from the parent:

```yaml
input:
  project_id:
    type: integer
    required: true

output:
  id:
    type: string
    path: $.id
  project_id:
    type: integer
    from:
      resource: projects
      path: $.id

extract:
  for_each:
    resource: projects
    field: id
    input: project_id
  record_path: $.results
  table:
    primary_key: [project_id, id]
```

The contextual field is part of the resource's canonical output schema, so it is
present in emitted records, loader schemas, previews, filters, and generated Model Spec
sources. `from` is mutually exclusive with `path` and `paths`; the declared child
type must match the referenced parent output type.

`from.resource` may name the immediate `for_each` parent or any proven ancestor in
the same fan-out chain. This lets a nested organization → project → event resource
retain both ancestor keys without passing the organization ID through every
intermediate request:

```yaml
output:
  organization_id:
    type: string
    from: { resource: organizations, path: $.id }
  project_id:
    type: integer
    from: { resource: projects, path: $.id }
```

Context paths resolve against the ancestor's declared, mapped `output`, not its raw
API response or request configuration. Nested paths are allowed only where the
ancestor output declares the corresponding `properties` or `items`; opaque objects,
unrelated resources, inputs, headers, auth values, and environment values cannot be
projected. Include every required parent in the extraction so Dogsled can establish
the lineage. A directly targeted child run may reconstruct only an immediate-parent
value that is exactly the explicitly supplied `for_each` input binding; every other
ancestor projection requires the ancestors to be co-scheduled.

Dogsled never changes a child's primary key automatically. If child IDs are scoped to
their parent, declare the composite key explicitly as shown above. Resources without
contextual outputs retain their existing behavior.

## Filtering

Three composable extract-time primitives let you scope an extraction without
custom code. **Each has a distinct role** — pick the right one (or combine):

| primitive                | role                | semantics                                                       |
| ------------------------ | ------------------- | --------------------------------------------------------------- |
| `extract.where`          | **data invariant**  | drop individual records that fail the predicate before emission |
| `extract.stop_when`      | **pagination cost** | halt walking the API once a whole page is past the window       |
| `extract.for_each.where` | **fan-out cost**    | drop parents before iterating, so children are never fetched    |

### Pattern: strict "last 6 months only" (data invariant + cost)

To extract _only_ records updated in the last 6 months **and** stop calling
the API once you're past the window, stack `where` + `stop_when` on the same
field. They are designed to compose:

```yaml
extract:
  record_path: $.data.issues.nodes
  where:
    - field: updated_at
      gte: '-6mo' # invariant: no emitted row older than 6 months
  stop_when:
    field: updated_at
    gte: '-6mo' # cost: stop walking once the API is past the window
    requires_sort: { field: updated_at, direction: desc }
```

`stop_when` reads records BEFORE `where` runs, so a strict `where` doesn't
hide the halt signal from `stop_when` — the two primitives compose cleanly
for the rolling-window case.

If you only declare `where`, you get the invariant but pay full pagination.
If you only declare `stop_when`, you stop paginating early but the last
page emits some pre-cutoff rows (it halts pages, not records).

### Other knobs

- `extract.where` predicates **auto-push down** when the resource's
  `query.filters[<field>].compile.<op>` binding matches; the rest evaluate
  client-side after `mapResponse`. No author work needed at the call site —
  the resource declares the pushdown surface once.
- `extract.stop_when.requires_sort` is cross-checked against
  `api.query_params` / `api.request_body` at parse time (catches the
  "halt on page 1 of an ascending feed" footgun).
- `extract.for_each.where` filters parent records before iteration —
  children are never fetched for unmatched parents:

  ```yaml
  for_each:
    resource: nt_pages
    field: id
    input: block_id
    where:
      - field: last_edited_time
        gte: '-6mo'
  ```

Predicate operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`.
Coexists with `extract.record_filters` (CLI-input-bound, `in`-only) — both
can be present on the same resource; `record_filters` runs first.

## Templating

Supported templates:

- `${{ input.foo }}`
- `${{ env.NAME }}`
- `${{ secrets.NAME }}`

Extractor CLI overrides populate `input` values:

```sh
dogsled extract run --integration github issues --input owner=my-org --input repo=my-repo
```

## Commands

`init`

```sh
dogsled extract init demo --integration github
```

`validate`

```sh
dogsled extract validate
dogsled extract validate github
dogsled extract validate github/issues
dogsled extract validate --check-env
```

`discover`

```sh
dogsled extract discover github
dogsled extract discover github --probe
```

`run`

```sh
dogsled extract run
dogsled extract run --integration github
dogsled extract run --integration github issues repos
dogsled extract run --integration github issues --limit 100
dogsled extract run --integration github issues --output file
dogsled extract run --integration github issues --full-refresh
```

`lookup`

```sh
dogsled extract lookup --integration github --resource issues --input id=42
```

`topup`

```sh
dogsled extract topup --integration github --resource issues --since 2h
dogsled extract topup --integration github --resource issues --since 2026-03-01T00:00:00Z --until 2026-03-15T00:00:00Z
dogsled extract topup --integration github --resource issues --since 1d --advance-state
```

## Output

Protocol messages are emitted as JSONL:

- `SCHEMA` — includes `load_strategy`, optional `schema_behavior`, and optional `cursor_field` (derived from resource config)
- `RECORD`
- `STATE`
- `BATCH` — points at external batch files (`jsonl` by default, `parquet` when `--batch-format parquet` or `extractor.yml` sets `default_batch_format: parquet`)

Logs and metrics go to stderr. Data can go to stdout or `output/*.jsonl`.

## Load Strategy Resolution

The extractor resolves a `load_strategy` for each stream and emits it in the SCHEMA message. The loader uses this to decide how to load each stream.

| Priority | Source                                      | Example                                                                                            |
| -------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1        | Explicit YAML `extract.table.load_strategy` | `load_strategy: append`                                                                            |
| 2        | `--full-refresh` CLI flag                   | Always `full_refresh`                                                                              |
| 3        | Inference from resource config              | file `incremental_append` → `append`; incremental + PKs → `merge`, incremental + no PKs → `append` |
| 4        | Default                                     | `full_refresh` (non-incremental resources)                                                         |

Most resources need no explicit `load_strategy` — the correct one is inferred from `incremental` and `primary_key` config.

For Snowflake, a `full_refresh` resource using the default `schema_behavior:
evolve` repairs a drifted destination table before loading. `strict` fails on
drift and `freeze` leaves the physical schema unchanged; other destinations
retain their own schema behavior. `full_refresh` remains a truncate-and-load
operation for the stream's rows.

## State

Bookmarks are stored in `.extractor/state.json`, keyed as `provider/resource`.

- `run` emits `STATE` for incremental resources, but only persists durable state when `--advance-state` is passed
- `--limit` runs are always preview-only, even if `--advance-state` is set
- `topup` emits `STATE` but only persists when `--advance-state` is passed
- `lookup` is stateless
- Relative durations (e.g. `2h`, `1d`) are only valid for timestamp cursors; integer/number cursors require absolute values

To make a deferred run durable later, commit the captured `STATE` messages explicitly:

```bash
dogsled extract commit-state \
  --integration github \
  --capture-file ./.extractor/captured-state.jsonl
```

This is the same durability step used by multi-destination fan-out runs after every loader succeeds.

### Pluggable state backends

State persistence is pluggable. Use `--state-backend` (or `DOGSLED_STATE_BACKEND`) to pick where bookmarks live:

| Backend                | URL form                                  | When to use                                                        |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| Local file _(default)_ | _omitted_, `file://./path`, `/abs/path`   | Laptops, long-lived VMs — anywhere the filesystem outlives the run |
| HTTP(S)                | `https://host/path` or `http://host/path` | Ephemeral containers (Cloud Run Jobs, k8s batch, GitHub Actions)   |

HTTP-backend contract:

- `GET <url>` returns the full `ExtractorState` JSON. `404` is treated as "no state yet".
- `PUT <url>` writes the full state. `If-Match` / `ETag` provide optimistic concurrency (412 is treated as a transient, retryable error).
- Status codes map to the extractor's error taxonomy: `5xx`/`429`/`412` → transient (retryable), `401`/`403` → config error (fail fast), other `4xx` → data error (fail fast). Network / DNS / TLS failures also surface as transient.

Auth for HTTP backends:

- `--state-auth-env <VAR>` (or `DOGSLED_STATE_AUTH_ENV`) names an env var that holds a bearer token. The token is sent as `Authorization: Bearer <value>` on every request; CR/LF are stripped defensively.
- The extractor refuses to send a bearer token over cleartext `http://` to a public host — use `https://` for authenticated backends. Loopback addresses (`localhost`, `127.*`, `::1`) are still allowed for local dev.
- `http(s)://` backends resolving to private/loopback/link-local hosts are rejected unless `DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1` is set (same escape hatch used elsewhere by the extractor for VPN / on-prem setups).

Example — running `dogsled extract run` against a self-hosted state backend:

```sh
DOGSLED_STATE_BACKEND=https://state.example.com/api/dogsled/state \
DOGSLED_STATE_AUTH_ENV=DOGSLED_RUN_TOKEN \
DOGSLED_RUN_TOKEN=<jwt> \
dogsled extract run --integration linear --advance-state
```

The HTTP contract (path, version, error-response shape) is exported from `@bobsled-inc/protocol` as `STATE_BACKEND_PATH`, `STATE_BACKEND_CONTRACT_VERSION`, `StateBackendErrorResponse`, and `isStateBackendErrorResponse`, so OSS users and third-party state services share one source of truth.
