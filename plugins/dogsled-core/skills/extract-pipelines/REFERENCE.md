# Extract-pipeline capability reference

## Pipeline configuration files: orchestration

The root `dogsled.yml` or `dogsled.yaml` can own the whole configuration. Larger Projects can split it into nested fragments with `type: pipeline_config`; Dogsled merges those fragments by declared pipeline and destination names.

An extract pipeline pulls explicitly named resources from one source and loads them into one or more named destinations:

```yaml
destinations:
  local_dev:
    type: duckdb
    db_path: ./data/dev.duckdb

pipelines:
  linear_dev:
    type: extract
    source: linear
    destination: local_dev
    schedule: every 4h
    via: graphql
    resources:
      - issues
      - resource: teams
        via: mcp
        inputs: { include_archived: false }
        load_strategy: merge
        table: raw_linear__teams
```

Rules:

- `destinations:` is the top-level named map. A pipeline uses exactly one of `destination:` or `destinations:`.
- `resources:` is required, non-empty, and is the complete allowlist. Never use `only:` or `exclude:`.
- Resource entries are a bare resource/entity name or an object with `resource` plus optional `via`, `inputs`, `input_matrix`, `load_strategy`, `table`, and `for_each_parent` overrides. `for_each_parent` declares the parent edge the runner must co-schedule for a child resource.
- `schedule` is required. Use `manual` for an on-demand pipeline with no cron trigger. Supported scheduled forms include `hourly`, `daily`, `weekly`, `monthly`, `every 2h`, `every 15m`, `30 past hourly`, and `daily at 14:30`; five-field cron is accepted.
- Secrets are environment references such as `$PG_PASSWORD`, never literal credentials.
- Pipeline `inputs` apply to extraction; per-resource `inputs` override or extend them for that resource.
- `table_prefix` changes destination table naming. `enabled: false` disables scheduled execution.
- `buffer_size` bounds loader file chunks for wide/large records. `runner` accepts only `managed` (the default): resource groups become subprocess nodes in the portable task DAG; `for_each` parents and children remain co-located. Other runner spellings are rejected.

### Static input matrices

Use `input_matrix` when one Resource needs a fixed set of typed request
combinations. Dogsled expands the axes in authored order and sends every tuple
through one extractor stream and destination table:

```yaml
resources:
  - resource: historical_outrights
    inputs:
      odds_format: decimal
      event_id: all
    input_matrix:
      axes:
        tour: [pga, euro, alt]
        year: [2023, 2024, 2025]
        market: [win, top_5, top_10]
      concurrency: 4
```

Every axis must name a declared Resource input. Values must match that input's
type and constraints. Axes cannot be empty, duplicate normalized tuples are
rejected, and the Cartesian product cannot exceed 10,000 tuples. Matrix axes
cannot also be set by pipeline-wide or per-Resource `inputs`.

The `concurrency` value limits in-flight tuples from 1 to 64. The integration
rate limiter still applies to every tuple and retry. A matrix can compose with
`extract.for_each`, producing the parent-record by matrix-tuple product. The
first release supports matrices only on Resources with explicit
`extract.incremental.strategy: full_refresh`, because tuple-specific state is
not yet partitioned for cursor or filter strategies.

Use one matrix per Resource. Dogsled includes the failing tuple in structured
progress diagnostics and keeps all successful tuples in the same output stream.

### Snowflake source warehouse selection

An extract pipeline whose **source** is Snowflake may select one declared
warehouse for every resource task:

```yaml
pipelines:
  source_orders_large:
    type: extract
    source: snowflake_source
    runner: managed
    schedule: manual
    resources: [orders, order_lines]
    destination: raw_lake
    warehouse: large
```

`warehouse` is a stable key from the source connection's `warehouses` map. Use
the key (for example `large`), never the provider warehouse name stored as its
value (for example `LARGE_WH`). Omit the field to keep the source connection's
default warehouse. Dogsled rejects unknown IDs, sources without a warehouse map,
non-Snowflake sources, and per-resource `warehouse` overrides.

This selector changes only the Snowflake **source extraction session**. It does
not select or change an extract destination's warehouse, and it does not apply
to embedded post-extract models. Use the separate managed destination selector
below when the load session needs a non-default warehouse.

### Managed Snowflake destination warehouse selection

An extract pipeline with one singular `dogsled_managed` destination may select
the Snowflake warehouse used by the destination load session:

```yaml
pipelines:
  posthog_ingestion:
    type: extract
    source: posthog
    destination: warehouse
    runner: managed
    schedule: manual
    resources: [events]
    destination_warehouse: medium
```

`destination_warehouse` is a stable ID from the managed destination connection,
not a physical Snowflake name. The managed orchestrator validates the ID and
resolves it once for execution; Dogsled preserves the ID in manifest v6 and
accepts the resolved physical name only through its trusted programmatic API.
Omitting the field keeps the saved destination default. It is not supported for
concrete Dogsled destinations, missing destinations, `destinations` fan-out,
model pipelines, or resource overrides.

A Snowflake-to-Snowflake extract may set both selectors. `warehouse` applies
only to the source extraction session, while `destination_warehouse` applies
only to the destination load session; their IDs belong to separate connections
and may resolve to different physical warehouses.

### Destination schema contract and drift (`schema_behavior`)

The extractor emits the effective schema policy in each `SCHEMA` message. Choose
one explicitly before the first write instead of relying on the implicit
`evolve` default. The policy is a load default, not a `dogsled.yml`
`load_strategy` setting.

Set a project-wide policy in `extractor.yml` with `default_load.defaults`:

```yaml
# extractor.yml
default_load:
  integration: snowflake_warehouse
  defaults:
    schema_behavior: strict
```

Override it for a three-block warehouse resource with `load.defaults`:

```yaml
# resources/orders.yml
spec_version: '1'
type: resource
name: orders
extract:
  source:
    table: ORDERS
    schema: PUBLIC
  replication:
    method: full_refresh
load:
  defaults:
    schema_behavior: evolve
schema:
  columns:
    order_id: { type: integer }
```

### ClickHouse integration example

ClickHouse warehouse sources use the HTTP interface and environment references
for credentials. Port 8443 with `require` is the usual ClickHouse Cloud
configuration; use port 8123 and `disable` for an unencrypted local server.

```yaml
spec_version: '1'
auth_env_vars: [CLICKHOUSE_HOST, CLICKHOUSE_PASSWORD, CLICKHOUSE_USER]
type: integration
name: test_clickhouse
source_type: clickhouse
connection:
  host_env: CLICKHOUSE_HOST
  port: 8443
  database: analytics
auth:
  type: password
  username_env: CLICKHOUSE_USER
  password_env: CLICKHOUSE_PASSWORD
ssl:
  mode: require
```

For the V2 source transport, use `type: sql_clickhouse` with the same
connection, auth, and SSL fields. A resource `schema:` is treated as the
ClickHouse database; the client qualifies tables as `` `database`.`table` ``
and uses named parameters such as `{p1:String}` for cursor values.

The resource `load:` block carries `defaults` and `overrides` only; it does not
carry the destination integration. If a resource has a `load:` block, that
block replaces the project `default_load` as a whole (there is no deep merge),
so an otherwise empty `load: {}` intentionally does not inherit the project's
schema policy. When no resource block is present, `default_load` supplies the
policy. A bare load block in a `--load-file` can also set
`defaults.schema_behavior`; the loader's `--schema-behavior` option is a
runtime override.

Warehouse resources have two accepted schema shapes. In the three-block shape
above, `schema.columns` is normalized to `resource.output` before extraction,
and `buildSchemaColumns` uses that normalized output to emit the protocol
`SCHEMA` columns. An empty `schema.columns` map is rejected before a run. The
legacy warehouse shape (also using `spec_version: '1'`) instead requires a
top-level `output:` map. Mixing the two shapes fails resource validation. Keep
the shape consistent with the resource schema and verify that the emitted
`SCHEMA` message has at least one data column.

Accepted values:

- **`evolve`** (the default when unset) — add columns that are present in the
  incoming schema but absent from the destination, and apply only safe type
  widenings. Non-widenable type conflicts fail. Columns absent from the
  incoming schema are retained; they are never dropped automatically.
- **`strict`** — fail before loading when the incoming schema has a new column,
  a missing existing column, or a type conflict. No destination DDL is issued.
  Use this for tables that are contracts for published models, metrics, or
  other downstream consumers.
- **`freeze`** — leave the destination's physical schema unchanged: no add,
  widen, or drop operation is attempted. Incoming records are still loaded
  against that schema, so a field or type that is not accepted by the
  destination can fail the load; `freeze` is not a filter that silently
  discards new fields. Use it only when the upstream and destination shape is
  deliberately pinned and validated elsewhere.
  An upstream rename is not inferred. Under `evolve`, the new name is an added
  column and the old name is merely absent, so the old column remains while the
  new column is added. This can silently split data between stale and current
  columns. Treat a rename as an explicit migration; use `strict` to stop while
  you review it, and do not assume a full refresh will rename or backfill a
  column.

### Repairing an existing schema drift

`strict` is intentionally a detector and does not alter the destination. For
Snowflake, Dogsled provides a narrowly scoped, one-shot reconciliation operation
for a known stream. The targeted loader form is
`dogsled load run --dest snowflake --reconcile-schema <stream>`. An end-to-end
run must provide protocol input and can resolve a project destination
integration like this:

```bash
dogsled extract run --integration <source> --full-refresh <stream> \
  | dogsled load run --load-integration <snowflake_destination> \
      --load-strategy full_refresh \
      --reconcile-schema <stream>
```

Managed/background agents that cannot invoke a shell use the public Dogsled
runner API instead of trying to call the loader CLI directly:

```typescript
import { runProjectPipeline } from '@bobsled-inc/dogsled/pipeline';

await runProjectPipeline({
  projectRoot: '/srv/project',
  pipelineName: 'orders',
  resources: ['orders'],
  fullRefresh: true,
  reconcileSchema: ['orders'],
});
```

`reconcileSchema` is an invocation-only override. It accepts the same authored
or entity resource names as `resources`, resolves them to the exact protocol
stream names, and must be a subset of the selected resources. A managed task
adapter should map its validated one-shot repair override to these typed API
fields. The generated managed manifest command remains unchanged. Dogsled's MCP
server currently exposes read-only `read_source` (and entity-graph reads); it
does not execute pipelines or loader writes, so an MCP client must use the
managed adapter's programmatic runner surface.

`<stream>` is the extractor stream/resource name, not a table wildcard; repeat
the option to target multiple streams. The listed stream must be present in
the input protocol, and its effective load strategy must be `full_refresh`
(from the CLI, a stream override, or the incoming `SCHEMA`); when the incoming
schema does not already resolve to `full_refresh`, add
`--load-strategy full_refresh` to this one-shot command. The operation
reconciles only the targeted table in place: it adds incoming columns, applies
safe type widenings, and drops destination columns that are absent from the
incoming contract. It never drops or recreates the table itself. A rename is
treated as add-plus-drop, not as a rename or a backfill, so review the
contract and preserve/migrate data separately when that distinction matters.
Do not omit extractor `--full-refresh`: truncating the destination after an
incremental source read would reload only the incremental slice and lose the
older rows.

Use this flag only for the repair run. After it succeeds, run the pipeline
again with `schema_behavior: strict` (or `--schema-behavior strict`) so future
drift stops for review. `--reconcile-schema` is currently supported only for
Snowflake; other destinations reject the option. The operation also repairs a
pre-existing Snowflake shell table when the incoming `SCHEMA` has real data
columns, without requiring a new table name.

`full_refresh` is a load strategy. The loader truncates the destination table
once on the first flush and then loads the batches. For Snowflake, the default
`evolve` schema behavior first inspects the existing table and replaces it only
when drift is detected, preserving grants with `COPY GRANTS` and reapplying
clustering. `strict` fails on drift and `freeze` leaves the physical schema
unchanged; other destinations retain their destination-specific behavior.
Extractor `--full-refresh` is a separate state operation that ignores saved
cursors for that run.

### Resource discovery and transports

Use `dogsled integrations show <source>` to discover resources, variants, required environment variables, and transport ids. For a multi-transport source, a canonical entity such as `issues` may have variants such as `issues_graphql` and `issues_mcp`.

Resolution precedence is: strict variant name first; otherwise per-resource `via` → pipeline `via` → bundled resource `via` → source `default_transport`. A project-local resource under `resources/<source>/` overrides only the bundled resource with the same declared name; bundled siblings remain available. Single-transport sources ignore `via`. HTTP/REST/GraphQL is normally best for throughput and API-native pagination; MCP is useful when that is the available auth/tool surface. Do not claim one is cheaper or faster without provider evidence.

### Destination fan-out and embedding boundaries

```yaml
pipelines:
  stripe_archive:
    source: stripe
    destinations: [warehouse, archive]
    resources: [charges, customers]
```

Local `dogsled runner run` and `dogsled pipeline` support fan-out by extracting once and replaying to each loader; durable extractor state commits only after every destination succeeds. Scheduling and remote orchestration belong to the caller.

An optional `embed:` block sits between extract and load and adds vector fields. It does not change extraction, filters, or cursor semantics. Route provider/model/stream configuration to `pipeline` or `ai-model-roles`, and destination configuration to `loader`. A model pipeline (`type: models`) materializes Model Spec models and is outside this skill.

Review pipeline `defaults.timeout` and `defaults.retry` together with the caller’s execution policy.

## Integration and resource YAML: extraction behavior

Project-local `extractor.yml` normally points at `integrations/`, `resources/`, `state/`, and `batches/`. Do not edit it merely to change what a pipeline runs.

Project-local resources extend the bundled source catalog one resource at a time. A file under
`resources/<source>/` overrides a bundled resource with the same declared `name`; bundled siblings
remain available to discovery, validation, `for_each` dependencies, contextual outputs, and
`dogsled.yml` resource lists. Adding one local resource never replaces the source's whole bundled
resource tree.

An integration declares one or more transports plus auth. A resource declares one endpoint/tool/query, typed inputs and outputs, extraction mechanics, and table metadata. A representative HTTP resource is:

```yaml
type: resource
name: issues
description: Issues updated by the provider.
api:
  endpoint: /issues
  method: GET
  query_params:
    limit: ${{ input.limit }}
    updated_since: ${{ input.updated_since }}
input:
  limit: { type: integer, default: 100, minimum: 1, maximum: 100 }
  updated_since: { type: timestamp, required: false }
  updated_before: { type: timestamp, required: false }
output:
  id: { type: string, path: $.id, description: Stable issue id. }
  updated_at: { type: timestamp, path: $.updated_at, description: Last provider update. }
  title: { type: string, path: $.title, description: Issue title. }
extract:
  record_path: $.data
  pagination:
    type: offset
    offset_param: offset
    limit_param: limit
  incremental:
    strategy: cursor
    cursor_field: updated_at
    cursor_param: updated_since
    cursor_type: timestamp
  table:
    primary_key: [id]
query:
  filters:
    updated_at:
      operators: [gte, lte]
      bind:
        gte: { input: updated_since }
        lte: { input: updated_before }
      compile:
        gte: { mode: http_query, param: updated_since }
        lte: { mode: http_query, param: updated_before }
```

Use the actual resource schema and existing integrations as templates. HTTP resources use `api`; MCP resources use a `tool` block and MCP pagination; warehouse resources declare tables/queries. Inputs referenced by query bindings must exist and be optional. Output fields are the contract used by predicates, incremental cursors, loaders, and embedding streams.

When the provider omits a request parameter from each response row, retain it with
an input projection:

```yaml
input:
  tour: { type: string }
  year: { type: integer }
output:
  requested_tour: { type: string, from: { input: tour } }
  requested_year: { type: integer, from: { input: year } }
  player_id: { type: string, path: $.player_id }
```

`from.input` must name a declared input and its type must match the output field.
It is evaluated from the request tuple and does not require `extract.for_each`.
Keep `from.resource` for mapped values inherited from a parent Resource. A field
cannot combine `from` with `path` or `paths`.

Supported deterministic JSON paths are `$`, dotted identifier properties such as `$.data.items`, and optional integer indexes such as `$.items[0]` or `$.items[-1]`. Do not rely on wildcards, recursive descent, filters, slices, unions, or bracket-quoted/hyphenated keys; capture a container or use ordered `paths` fallbacks instead.

### Pagination and parent/child fan-out

HTTP resources support these exact pagination shapes:

- `none` and `link_header` take no other keys.
- `cursor` requires `cursor_path` and `cursor_param`.
- `offset` optionally sets `offset_param`, `limit_param`, and `total_path`; inspect the provider contract rather than assuming parameter names.
- `page_number` optionally sets `page_param`, `per_page_param`, `total_pages_path`, and non-negative `start_page` (default `1`).
- `next_url` requires `next_url_path`.

MCP resources use:

- `mcp_cursor`, requiring `cursor_path` and `cursor_argument`.
- `mcp_offset`, with `offset_argument` (default `offset`), `limit_argument` (default `limit`), positive `limit_value` (default `100`), and optional `total_path`.
- `mcp_page_number`, with `page_argument` (default `page`), `per_page_argument` (default `per_page`), positive `per_page_value` (default `25`), optional `total_pages_path`, and non-negative `start_page` (default `1`).
- `none` for a single tool call.

Bind the exact provider parameter/argument and response path required by the selected strategy; do not infer cursors or page counts from field names. Pagination URLs remain same-origin and every retry/page traversal must stay bounded by the integration controls.

A child endpoint/tool that must run once per parent record declares `extract.for_each`:

```yaml
extract:
  for_each:
    resource: projects
    field: id
    input: project_id
    concurrency: 1
    where:
      - { field: archived, eq: false }
```

`field` references the parent output and `input` is the child input receiving it. `concurrency` is 1–64 and remains constrained by the integration rate limiter. The parent and child must run in the same extraction process, with the parent first; include both in the pipeline `resources:` list and use the child resource override's `for_each_parent` when the runner needs an explicit dependency edge. A failed child iteration is reported without cancelling its siblings.

## Filters: keep the two vocabularies distinct

### Extract predicates

`extract.where`, `extract.stop_when`, and `extract.for_each.where` use exactly:

`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`

Each predicate targets one scalar output field and has exactly one operator:

```yaml
extract:
  where:
    - { field: status, in: [open, pending] }
    - { field: updated_at, gte: -6mo }
  stop_when:
    field: updated_at
    gte: -6mo
    requires_sort:
      field: updated_at
      direction: desc
```

- `where` drops individual records after response mapping.
- `stop_when` stops pagination only when its `requires_sort` guarantee is valid. It inspects mapped records before `where`, so a boundary page can stop pagination while `where` removes out-of-window records from that page.
- `for_each.where` filters parent records before iteration, so children are fetched only for matching parents.
- Relative durations (`-6mo`, `1d`, `2h`) are allowed only for timestamp fields with `gt`, `gte`, `lt`, or `lte`.

`extract.record_filters` is a separate caller-input-bound filter surface. It supports only `operator: in`, runs before `extract.where`, accepts at most 16 entries, and must bind an existing resource input to a scalar output field. Do not confuse it with literal author-time predicates or `query.filters`.

### Query-resource filters

Caller-facing `query.filters` use exactly:

`eq`, `contains`, `gte`, `lte`, `ne`, `lt`, `gt`, `not`, `in`

Callers may use `$eq`-style keys; a scalar is shorthand for `eq`. A filter field declares all supported operators and a matching `bind` for each operator. Notice that query filters use `ne`, while extract predicates use `neq`.

Compile modes are:

- `http_query`: put the value in an HTTP query parameter.
- `direct_arg`: put the value in an MCP/tool argument.
- `filter_dsl`: build the provider's native filter expression/DSL.

For `extract.where` pushdown, Dogsled matches the predicate field/operator against `query.filters.<field>.compile`. Matching `http_query` and `direct_arg` bindings push down and are removed from client-side evaluation; unmatched predicates remain client-side. `filter_dsl` is available to the query-resource backend but is not an `extract.where` pushdown mode. A pushed binding therefore carries correctness responsibility: verify that its provider parameter/tool argument has semantics equivalent to the authored predicate.

## Incremental extraction and state

Incremental resources declare an output `cursor_field`, its cursor type, and
strategy-specific replay/window settings. The extractor reads prior state,
applies the cursor to the request when configured, and emits a new state
candidate based on successful records.

Choose the strategy explicitly:

- `cursor`: replays one saved value through `cursor_param`; use for HTTP endpoints that accept a single `since`-style query/body parameter. It does not apply to MCP tools.
- `filter`: requires `cursor_field` and `since_argument` (legacy `filter_argument` is accepted), then injects the window into HTTP parameters/body fields or MCP tool arguments. Set `until_argument` when the provider accepts an upper bound.
- `server_filter`: requires `cursor_field` and `since_argument` (legacy `filter_argument` is accepted), then routes the window through matching `query.filters` `gte` and, when `until_argument` is present, `lte` bindings. Use when the resource already has a query-filter surface; supported for HTTP and MCP.
- `full_refresh`: fetches the complete resource every run. Pair a stable `table.primary_key` with merge/upsert behavior when the provider has no usable incremental filter.

For both `filter` and `server_filter`, `initial_lookback_seconds` is mandatory for the first run unless a bookmark or explicit since override already exists; omission causes the run to fail. `lookback_seconds` (default `0`) replays before an existing bookmark for late arrivals. `window_size_seconds` splits the range into positive-sized windows and requires `until_argument`. `value_format` defaults to `iso8601` and may be `iso8601`, `date`, `unix_seconds`, or `unix_milliseconds`; it must match the provider request format and the cursor field's value semantics.

Prefer `extract.incremental` over the accepted legacy top-level placement. The cursor field must be a declared output field. Incremental metadata plus a primary key lets Dogsled infer merge semantics; confirm the resolved load strategy during validation rather than assuming it.

State safety rules:

- `--full-refresh` ignores prior cursor state for that run.
- Extractor runs using `--limit` are always preview-only and never persist durable state.
- A normal successful single-destination run may commit state; failed runs do not.
- Fan-out commits only after all destinations succeed.
- Filtering can produce zero emitted records; investigate predicate summaries and pushdown rather than assuming the API returned nothing.
- Never hand-edit state to make a failing pipeline appear healthy. Back up state before an intentional reset or backfill.

## Validate, run, and verify

Use this order:

1. `dogsled extract validate <source> --semantic-check=strict` — YAML, references, output semantics.
2. `dogsled extract verify <source>` and `--mock` — static/OpenAPI/fixture and mocked behavior.
3. For a new or changed HTTP API integration, run `dogsled extract scaffold-test <source>` with credentials. It intentionally rejects MCP, warehouse/database, and file-storage sources; use their source-specific checks plus a bounded extractor preview instead.
4. `dogsled runner validate --strict` — resolve pipelines, resources, inputs, transports, destinations, and secrets.
5. Verify required environment references without printing secret values.
6. Point the pipeline at a disposable destination, then run one resource with `dogsled runner run <pipeline> --resource <resource>`.
7. Verify rows, schema, table names/load strategy, cursor behavior, stderr summaries, and destination queries.
8. Restore the intended destination and review pipeline configuration changes. Scheduling belongs to the caller.

Do not put `--limit` on a real state-advancing acceptance run: it is a safe preview, not proof that resume semantics work. Do not run against a shared warehouse or bucket merely to discover resource names.

## Troubleshooting map

- Unknown/duplicate resource: inspect `dogsled integrations show`, strict variant names, `via` resolution, and the explicit `resources:` list.
- Missing secret/auth failure: compare integration auth metadata and `$ENV_VAR` references; rerun validation. Never print secret values.
- Zero records: inspect inputs, pagination, `record_path`, output mapping, predicate summaries, relative-duration clock behavior, and pushdown equivalence.
- Repeated/omitted records: inspect pagination tokens/order, primary keys, incremental cursor ordering/lookback, and whether a preview run was mistaken for state advancement.
- Wrong table/load behavior: inspect pipeline/resource `table`, `table_prefix`, `load_strategy`, primary keys, and loader logs.
- Scheduling failure: inspect the caller’s scheduler; the toolkit runs pipelines locally and does not generate scheduling workflows.
- Protocol corruption: stdout is data messages only; human/diagnostic logging belongs on stderr.

Route local environment readiness and runtime diagnosis to `dogsled-troubleshoot`, connector implementation to the relevant `add-*` skill, destination internals to `loader`, and model materialization to Model Spec skills.
