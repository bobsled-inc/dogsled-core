# Vercel source

The Vercel source uses the REST API at `https://api.vercel.com` and reads a
`VERCEL_TOKEN` from the environment. Scope requests with `team_id` or
`team_slug`, and use `project_id` where the endpoint supports project scope.

## Resource coverage

| Resource                  | Endpoint                                  | Purpose                                         |
| ------------------------- | ----------------------------------------- | ----------------------------------------------- |
| `projects`                | `GET /v10/projects`                       | Project identity and configuration              |
| `deployments`             | `GET /v7/deployments`                     | Deployment lifecycle, environment, and metadata |
| `deployment_details`      | `GET /v13/deployments/{idOrUrl}`          | Detailed deployment configuration               |
| `billing_charges`         | `GET /v1/billing/charges`                 | FOCUS JSONL charges and native costs            |
| `contract_commitments`    | `GET /v1/billing/contract-commitments`    | Enterprise contract commitments                 |
| `metric_catalog`          | `GET /v2/observability/schema`            | Available metric IDs                            |
| `metric_schema`           | `GET /v2/observability/schema/{metricId}` | Metric dimensions, units, and aggregations      |
| `metric_query`            | `POST /v2/observability/query`            | Bounded metric query envelopes                  |
| `sandboxes`               | `GET /v2/sandboxes`                       | Sandbox configuration and cumulative counters   |
| `sandbox_sessions`        | `GET /v2/sandboxes/sessions`              | Session lifecycle and measurements              |
| `sandbox_session_details` | `GET /v2/sandboxes/sessions/{sessionId}`  | Individual session measurements                 |

## Cost and usage boundaries

Vercel's billing endpoint provides native `BilledCost`, `EffectiveCost`,
currency, consumed quantity, pricing quantity, service, charge category,
region, and tags. The extractor treats each bounded JSONL retrieval as a
replaceable snapshot. It assigns `snapshot_id` and a record ordinal because
Vercel does not document a stable charge identifier. Select one complete
snapshot before summing costs.

The observability API can expose function invocations, duration, CPU, memory,
transfers, builds, and other account-enabled metrics. Vercel's current Query
Reference also lists sandbox active CPU, sandbox CPU usage, provisioned and
peak memory, and sandbox data transfer. The extractor discovers metric IDs and
dimensions first, then stores the complete query response. It does not assume
that every metric supports project, deployment, environment, route, or region
grouping.

The query resource also preserves the request envelope, including grouping,
ordering, granularity, bucket timezone, and result limits, so downstream models
can distinguish a complete result from a bounded or differently bucketed query.

Sandbox session CPU and network measurements are documented after a successful
stop. A null measurement means that Vercel did not provide a measurement; it is
not a zero. Sandbox list counters are cumulative observations and must not be
summed across refreshes. The sandbox resource also preserves snapshot retention,
network ID, working directory, and mount fields from the documented response.
The session resources preserve working directory, timeout, lifecycle, snapshot,
CPU, and network fields, including the team scope used by child lookups. The
documented timeout and snapshot-expiration values are milliseconds, and `mounts`
is a keyed object of mount configuration; keep both shapes intact when adapting
the generated staging model.

## Access and refresh

Use a token with access to the selected team. Billing supports Owner, Member,
Developer, Security, Billing, and Enterprise Viewer roles. Verify account roles
and enabled products before selecting billing, observability, or sandbox
resources. Contract commitments are Enterprise-only and can be empty for Pro or
Flex accounts.

Billing supports daily granularity and a maximum one-year bounded query. The
extractor uses UTC `from` (inclusive) and `to` (exclusive) bounds. Projects,
deployments, sandboxes, and sessions use provider pagination. The default
extractor rate is one request per second with one request in flight; this is a
Bobsled Core default and is not a Vercel quota. Published platform limits include
deployment retrieval at 500 requests/minute (2,000/minute for Enterprise),
runtime logs at 100/minute, and sandbox control-plane requests at
1,000/10,000/100,000 per minute for Hobby/Pro/Enterprise. Vercel does not
publish a billing or metric request quota or an ingestion-delay SLA. Store
retrieval time and treat recent results as provisional.

Metrics CLI queries currently require Pro or Enterprise with Observability
Plus for infrastructure metrics. Plus retains 30 days; basic Observability
retention is plan-dependent (12 hours for Hobby, one day for Pro, and three
days for Enterprise). Metric query results can be grouped and the CLI defaults
to ten grouped results per bucket, so the extractor preserves coverage and
statistics instead of presenting grouped rows as exhaustive. Vercel's CLI is
transitioning to `/metrics/v1`; this source uses the OpenAPI-listed
`/v2/observability` contract until the newer request semantics are separately
verified.

## Eve and app allocation

Vercel does not provide an automatic Eve/app billing split for a shared project.
Native project IDs, deployment metadata, sandbox names and tags, metric
dimensions, and runtime logs can provide attribution evidence. The default
models preserve those fields without assigning ownership. Add a mapping that
explicitly connects a sandbox identity or exclusive route to `eve` or `app`
before building workload allocation models.

An allocation remains an estimate:

```text
allocated cost = native service cost
                 * workload usage / total matching usage
```

Use active CPU for CPU charges, invocation counts for invocation charges, and
bytes for transfer charges. Memory needs a concurrency assumption. Shared
subscriptions, builds, credits, commitments, missing dimensions, late billing
corrections, and external provider costs remain shared or unallocated. These
estimates can differ from Vercel's final bill.

The public runtime log stream and drains are follow-on attribution inputs. The
stream does not provide a documented bounded historical cursor, and a drain
requires a receiver, so they are not part of this initial source.

## AI Gateway boundary

Vercel's AI Gateway Custom Reporting API is available at
`https://ai-gateway.vercel.sh/v1/report` and uses an AI Gateway API key or OIDC
token. It is account-scoped, accepts inclusive UTC `start_date` and `end_date`
parameters, and reports cost, token, and request measures by day, model, user,
tag, provider, credential type, and other documented groupings. It is not part
of this source because this source uses the separate `api.vercel.com` host and
`VERCEL_TOKEN` credential. Add a separate source and starter package when an AI
Gateway credential and reporting scope are available; do not send the Vercel
personal access token to the AI Gateway endpoint.
