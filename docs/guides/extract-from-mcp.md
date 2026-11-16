# Extract from MCP servers

A [Model Context Protocol](https://modelcontextprotocol.io) server exposes tools
that return data. Bobsled Core can call those tools as resources and load their results
like any other source. The examples use the MCP project's reference server, which
has a `get-structured-content` tool that returns simulated weather for a city.

## Describe the server

MCP integrations use the `type: source` format, which lists one or more
transports. For a server that speaks MCP over HTTPS:

Create `integrations/everything.yml`:

```yaml
spec_version: '2'
type: source
name: everything
description: The MCP reference server
transports:
  - id: mcp
    type: mcp_http
    url: https://mcp.example.com/mcp
default_transport: mcp
```

`mcp_http` transports take an optional `auth` block (`none`, `bearer`, `api-key` or
`oauth2` with client credentials), `headers`, `timeout_ms`, `retry` and
`rate_limit`. The URL must use HTTPS.

List the server's tools:

```bash
bobsled extract mcp list-tools everything
```

```text
echo	Echoes back the input string
...
get-structured-content	Returns structured content along with an output schema for client data validation
get-sum	Returns the sum of two numbers
...
```

## Scaffold resources

`bobsled extract mcp discover everything --write` writes one resource file per tool
under `resources/everything/`. To learn a tool's output shape, it reads the tool's
output schema, or calls the tool once when there is none. Pass `--no-dry-run` to
stop it from calling tools. The scaffolds are marked for review; edit them before
you use them.

## Describe a resource

An MCP resource names the tool, its arguments and how to map the result:

Create `resources/everything/weather.yml`:

```yaml
type: resource
name: weather
description: Simulated weather for one city
via: mcp
tool:
  tool_name: get-structured-content
  arguments:
    location: ${{ input.location }}
input:
  location:
    type: string
    default: Chicago
output:
  temperature: { type: number, path: $.temperature }
  conditions: { type: string, path: $.conditions }
  humidity: { type: number, path: $.humidity }
extract:
  record_path: $
```

`via` names the transport. Resources of a `type: source` integration have no
`spec_version` or `integration` field.

```bash
bobsled extract run --integration everything weather --input location=Chicago --quiet \
  | bobsled load run --dest duckdb --db-path mcp.duckdb
bobsled query "SELECT temperature, conditions, humidity FROM weather" --db-path mcp.duckdb
```

```text
[loader] weather: loaded 1 rows
...
temperature	conditions	humidity
36	Light rain / drizzle	82
```

For tools that return pages of results, `extract.pagination` supports
`mcp_cursor`, `mcp_offset` and `mcp_page_number`.

## Check redaction

`bobsled extract mcp verify-redaction everything --tool <tool>` calls one tool with
no arguments and prints the result after Bobsled Core's redaction, so that you can check
what would reach your logs and tables before you extract.

## Local servers

Servers started as a local process (`type: mcp_stdio`) are limited to reviewed
commands, because a command line can run any program. This release allows the
BigQuery and Snowflake MCP servers used by the `bigquery` and `snowflake` library
integrations. Run any other server over HTTP. MCP servers on your own machine or
network also need `BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1`.

`bobsled mcp` is a shortcut for `bobsled extract mcp`, and also contains
`bobsled mcp serve`, which runs Bobsled Core itself as an MCP server: see
[Entity graph](entity-graph.md#serve-entities-to-agents).
