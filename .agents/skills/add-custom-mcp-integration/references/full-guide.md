# Add a custom MCP server source (`custom_mcp`)

Use this when a user wants to extract data from a remote MCP server that
Dogsled does **not** ship a bundled connector for. A `custom_mcp` source is
**fully self-describing**: you author a `source.yml` with an inline
`mcp_http` transport (`url` + `auth`) and one declarative resource per
tool you want to call. There is **no per-connector code module** and
**no catalog entry required** — the YAML runs directly against Dogsled's
generic MCP extractor.

## When to use a different skill

- The MCP server already has a bundled connector (e.g. `linear`, `notion`)
  → `explore-integration`. Bundled connectors carry curated resource lists
  and richer auth metadata.
- You don't know the server's tools and want to scaffold extraction YAML
  from its live tool list → `mcp-discover`. Run that first; it generates
  the resource shells. Then return here to wire them up as a `custom_mcp`
  source.
- The user wants to _author_ their own MCP server first → `build-mcp-server`.
  Build it, deploy it to a public HTTPS URL, then return here.
- The source is a REST/GraphQL API → `add-custom-api-integration`.
- The source is a warehouse/database → `add-warehouse-source`.

## What a `custom_mcp` source is

- **YAML-only.** No per-connector code, no catalog entry.
- **One inline transport of `type: mcp_http`.** Dogsled's
  `McpHttpTransportSchema` accepts `url` (HTTPS-only), optional `auth`,
  `headers`, `timeout_ms`, `retry`, `rate_limit`. `mcp_stdio` is
  **rejected at strict-schema time** for `custom_mcp` — the hosted
  extractor doesn't run customer-supplied binaries. If you try, the
  validator emits:

  ```text
  custom_mcp sources may only declare mcp_http transports (got "mcp_stdio")
  ```

- **One resource per tool.** Dogsled's `McpToolConfigSchema` defines the
  `tool:` block — `tool_name` (required), `arguments` (optional, with
  `${{ input.X }}` / `${{ env.X }}` interpolation), `timeout_ms`. The
  outer resource declares `input:` for tool argument inputs and
  `output:` columns mapped from the tool's JSON response via JSONPath.
- **HTTPS only + SSRF enforced.** `url` must be HTTPS
  (`AbsoluteHttpsUrlSchema`). At runtime, `createStreamableHttpTransport`
  in `@bobsled-inc/extractor` blocks private/loopback/metadata hosts and
  runs DNS pre-resolution to mitigate DNS rebinding. The only escape
  hatch is the `DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1` process env var
  (local dev), which is **not** settable from YAML.

## File layout

```text
<source-name>/
  source.yml                # source_type: custom_mcp, inline mcp_http transport
  meta.yml                  # display metadata (auth_setup optional)
  resources/
    <tool-name>.yml         # one resource per tool, with tool: + extract: blocks
```

## Step 1 — Write `source.yml`

Declare the kind, the env vars the transport interpolates, and one
inline `mcp_http` transport. Auth is one of `none`, `bearer`, or
`api-key` (Dogsled's `McpTransportAuthSchema` also supports `oauth2`
client_credentials; if you need that, hand-author the transport — this
skill stays focused on the simple shapes).

Bearer auth (most common — Linear, Notion, GitHub MCP):

```yaml
spec_version: '2'
type: source
source_type: custom_mcp # Dogsled-visible marker
dogsled_source_kind: custom_mcp # orchestrator / host application marker (Dogsled ignores it)
name: <source-name>
description: <one line>
auth_env_vars: # env vars the transport interpolates
  - <ENV_VAR_NAME>
transports:
  - id: default
    type: mcp_http
    url: https://mcp.example.com/mcp
    auth:
      type: bearer
      token: ${{ env.<ENV_VAR_NAME> }}
    timeout_ms: 30000
    retry:
      max_retries: 3
      backoff: exponential
    rate_limit:
      requests_per_second: 5
      burst: 10
    headers:
      User-Agent: dogsled-extractor
default_transport: default
```

API-key header auth:

```yaml
transports:
  - id: default
    type: mcp_http
    url: https://mcp.example.com/mcp
    auth:
      type: api-key
      header: x-api-key
      key: ${{ env.<ENV_VAR_NAME> }}
```

No auth (public read-only MCP servers — rare but valid):

```yaml
transports:
  - id: default
    type: mcp_http
    url: https://mcp.example.com/mcp
    auth:
      type: none
```

> **SSRF + HTTPS.** `url` and every tool call go through the extractor's
> public-host enforcement — private / loopback / metadata hosts are
> blocked at `createStreamableHttpTransport` time, with a DNS
> pre-resolution check against the same allowlist. HTTPS is enforced by
> `AbsoluteHttpsUrlSchema`. The only escape hatch is
> `DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1`, settable only in the
> process environment (never from YAML).

## Step 2 — Write `meta.yml`

```yaml
display_name: <Human Name>
category: developer-tools # crm | marketing | finance | communication | analytics | cloud-infra | productivity | support | task-management
tags: [<tag>, <tag>]
docs_url: https://docs.example.com
# auth_setup is OPTIONAL for custom_mcp — env vars are declared in
# source.yml `auth_env_vars`.
```

## Step 3 — One resource per tool

Each resource declares which tool to call, what inputs to feed it, and
how to extract rows from the tool's JSON response.

```yaml
type: resource
name: <entity>
via: default # transport id from source.yml (omit if default_transport matches)
description: <what this tool returns>
tool:
  tool_name: <tool name as advertised by the MCP server>
  arguments:
    # Static arguments + interpolated inputs via ${{ input.X }}.
    workspace_id: ${{ input.workspace_id }}
    limit: 100
input:
  workspace_id:
    type: string
    required: true
    description: Workspace UUID to scope the call to
output:
  id:
    type: string
    path: $.id
    description: Unique id
  name:
    type: string
    path: $.name
  created_at:
    type: timestamp
    path: $.created_at
extract:
  # JSONPath into the tool response that points at the record array. Use
  # `$` for a root array, `$.items` for { items: [...] }, `$.data.things`
  # for nested wrappers.
  record_path: $.items
  # Most MCP tools paginate via their own arguments (e.g. cursor / offset);
  # if a tool returns everything in one call, set pagination: none.
  pagination:
    type: none
  table:
    primary_key:
      - id
```

If the tool needs to be called once per row from another resource (e.g.
`get_project` once per project id from `list_projects`), use
`extract.for_each`:

```yaml
extract:
  for_each:
    resource: <parent-resource-name>
    field: id
    input: project_id # the input on THIS resource that receives the value
    concurrency: 1 # optional, 1..64 — iterations in flight. Default 1.
  record_path: $
```

`concurrency` defaults to `1` (strictly sequential). Raise it to overlap
in-flight iterations when per-request round-trip time is the bottleneck and
the integration's `rate_limit` still has headroom — the global token bucket
remains the absolute rps cap. A failing iteration logs a warning and does
not cancel its siblings.

If the tool response omits the parent key, keep it as a typed field in the
child's canonical output schema:

```yaml
output:
  id: { type: string, path: $.id }
  project_id:
    type: string
    from: { resource: projects, path: $.id }
extract:
  for_each:
    resource: projects
    field: id
    input: project_id
  table:
    primary_key: [project_id, id]
```

The source must be the immediate parent or a proven ancestor in the same fan-out
chain. `from.path` can traverse only declared mapped output (including declared
`properties`/`items`), never inputs, raw tool responses, headers, auth, or
environment. Its terminal type must match the child field type, and `from` is
mutually exclusive with `path` and `paths`. Primary keys remain explicit. A targeted
child run can reconstruct only an immediate-parent field exactly matched by an
explicit `for_each` input binding; all other ancestry must be co-scheduled.

To pull only new or changed rows instead of re-listing everything, add an
`extract.incremental` block. For MCP (`tool:`) resources use the `filter` or
`server_filter` strategy — the default `cursor` strategy is HTTP-only (it needs
a request parameter, which MCP tools do not have).

{{include: packages/extractor/docs/incremental-cursors-reference.md}}

## Step 4 — Validate → verify → extract

```bash
dogsled extract validate <source-name>
dogsled extract verify <source-name>
dogsled extract verify <source-name> --mock
# then, with the env var exported:
export <ENV_VAR_NAME>=...
dogsled extract run <source-name> --resource <entity> --limit 5
```

- `validate` — schema-level check (source/transport/resource shapes,
  `mcp_stdio` rejection for `custom_mcp`, HTTPS, unique transport ids).
- `verify` — cross-checks every `${{ env.X }}` reference against
  `auth_env_vars` (bundled `<name>/source.yml` files can also use their `meta.yml` `auth_setup`), plus a live
  reachability check on the MCP server (skip with `--mock`).
- `run` — calls the real MCP server. `--limit N` caps record count for
  smoke tests.

## Worked example — Linear MCP as a BYO source

Linear ships a bundled `linear` source, but the example below shows how
to wire its public MCP endpoint (`https://mcp.linear.app/mcp`) as a
`custom_mcp` source — a runnable demonstration of the pattern. For a
real BYO MCP server, swap the URL and tool names.

`linear_mcp/source.yml`:

```yaml
spec_version: '2'
type: source
source_type: custom_mcp
dogsled_source_kind: custom_mcp
name: linear_mcp
description: Linear team data via the public Linear MCP server.
auth_env_vars:
  - LINEAR_API_KEY
transports:
  - id: default
    type: mcp_http
    url: https://mcp.linear.app/mcp
    auth:
      type: bearer
      token: ${{ env.LINEAR_API_KEY }}
    timeout_ms: 30000
    retry:
      max_retries: 3
      backoff: exponential
    rate_limit:
      requests_per_second: 5
      burst: 10
default_transport: default
```

`linear_mcp/meta.yml`:

```yaml
display_name: Linear (via MCP)
category: task-management
tags: [linear, mcp, projects, issues]
docs_url: https://linear.app/docs
```

`linear_mcp/resources/teams.yml` — call the `list_teams` tool, root-array
response, no pagination:

```yaml
type: resource
name: teams
description: List Linear teams in the workspace.
tool:
  tool_name: list_teams
output:
  id:
    type: string
    path: $.id
    description: Team UUID.
  name:
    type: string
    path: $.name
  key:
    type: string
    path: $.key
extract:
  record_path: $.teams
  pagination:
    type: none
  table:
    primary_key:
      - id
```

`linear_mcp/resources/cycles.yml` — call `list_cycles` once per team via
`for_each`:

```yaml
type: resource
name: cycles
description: Active cycles for each Linear team.
tool:
  tool_name: list_cycles
  arguments:
    teamId: ${{ input.team_id }}
    type: current
input:
  team_id:
    type: string
    required: true
    description: UUID of the team to list cycles for.
output:
  id:
    type: string
    path: $.id
  number:
    type: integer
    path: $.number
  name:
    type: string
    path: $.name
  starts_at:
    type: timestamp
    path: $.startsAt
  ends_at:
    type: timestamp
    path: $.endsAt
  progress:
    type: number
    path: $.progress
extract:
  for_each:
    resource: teams
    field: id
    input: team_id
  record_path: $.cycles
  pagination:
    type: none
  table:
    primary_key:
      - id
```

Then run:

```bash
export LINEAR_API_KEY=lin_api_...
dogsled extract validate linear_mcp
dogsled extract verify linear_mcp
dogsled extract run linear_mcp --resource teams --limit 5
dogsled extract run linear_mcp --resource cycles --limit 5
```

## Common gotchas

- **`mcp_stdio` rejected.** custom_mcp may only declare `mcp_http`.
  Error: `custom_mcp sources may only declare mcp_http transports (got
"mcp_stdio")`. If you genuinely need stdio (an unsupported edge case),
  ship a bundled integration instead.
- **`url` must be HTTPS.** `AbsoluteHttpsUrlSchema` rejects `http://` and
  bare hostnames. Error: `Must be an absolute HTTPS URL`.
- **Private host blocked.** A `url` resolving to a private IP / localhost
  / cloud-metadata host is rejected at runtime: `MCP HTTP URL
"<host>" targets a private or internal host`. Use
  `DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1` for local dev only.
- **`MISSING_AUTH_SETUP` from `verify`.** Every `${{ env.X }}` reference
  in the source must appear in `auth_env_vars`. Add it.
- **`Transport "X" not found in source "Y"`.** A resource's `via:` (or
  the source's `default_transport`) names a transport id that doesn't
  exist. Match exactly.
- **Single object vs list.** If the tool returns a single record, use
  `record_path: $`. If it returns `{ items: [...] }`, use
  `record_path: $.items`. If it returns `{ data: { things: [...] } }`,
  use `record_path: $.data.things`.
- **OAuth2 MCP servers.** Dogsled's `McpTransportAuthSchema` accepts
  `type: oauth2` with `grant_type: client_credentials`, `token_url`,
  `client_id`, `client_secret`. This skill stays focused on
  none/bearer/api-key; for OAuth2, hand-author the transport block from
  the schema and verify with `--mock`.
- **Tool inputs declared but never referenced.** `input:` declares
  inputs the resource accepts but `tool.arguments` is what's sent to the
  tool. Make sure every input you declare is actually referenced via
  `${{ input.X }}` somewhere in `tool.arguments`, otherwise it's dead
  config.

## Quality checklist

Before handing back to the user:

- [ ] `source.yml` has `source_type: custom_mcp` and
      `dogsled_source_kind: custom_mcp`.
- [ ] `transports[0].type === 'mcp_http'` and `url` is absolute HTTPS.
- [ ] No `mcp_stdio` transports anywhere in the bundle.
- [ ] `auth_env_vars` lists every env var the transport references.
- [ ] No raw secrets in YAML — `${{ env.X }}` only.
- [ ] Each resource has `tool.tool_name`, at least one `output[*].path`,
      `extract.record_path`, `extract.table.primary_key`.
- [ ] Paginated tools declare `extract.pagination` (or
      `pagination: none` for bounded lists).
- [ ] Incremental tools set `extract.incremental` with `filter` or
      `server_filter` and a `cursor_field` that exists in `output` (the
      `cursor` strategy is HTTP-only).
- [ ] `dogsled extract validate <source>` returns clean.
- [ ] `dogsled extract verify <source>` returns clean.

## Related

- `build-mcp-server` — build a remote MCP server from scratch, then
  connect it via this skill.
- `mcp-discover` — auto-scaffold resource YAML from a live MCP server's
  tool list, then refine it here.
- `add-custom-api-integration` — same pattern but for REST / GraphQL.
