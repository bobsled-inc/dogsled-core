---
name: starter-models-vercel
description: Curated Vercel starter models, metrics, and relationships for projects, deployments, FOCUS billing, commitments, observability queries, and sandbox operations.
exposed: true
triggers:
  - vercel starter models
  - prebuilt vercel models
  - curated vercel analytics models
  - vercel cost models
  - vercel billing models
  - vercel usage models
  - build vercel marts
  - models for vercel
---

# Starter data models — Vercel

This bundle provides the gold marts for Vercel. It follows the same generated
bronze and silver pattern as the Stripe, Vantage, and LangSmith bundles:

- `raw_<resource>` is a bronze source generated from the Vercel extractor schema.
- `stg_vercel__<resource>` is a generated silver view.
- `vercel__<name>` is an installable curated gold table.

The bundle keeps Vercel's native identifiers, metadata, units, currencies, and
measurement gaps. It does not infer an Eve/app ownership split. Select one
complete `snapshot_id` before aggregating billing charges; overlapping snapshots
must not be added together.

Resource units are carried into the generated bronze and silver metadata. Gold
models add fixed units where the value is unambiguous; billing and metric units
remain native columns because Vercel can return different units by service or
metric.

## Shipped marts

### vercel\_\_projects

{{include: packages/models/marts/vercel/vercel__projects.yml}}

### vercel\_\_deployments

{{include: packages/models/marts/vercel/vercel__deployments.yml}}

### vercel\_\_deployment_details

{{include: packages/models/marts/vercel/vercel__deployment_details.yml}}

### vercel\_\_billing_charges

{{include: packages/models/marts/vercel/vercel__billing_charges.yml}}

### vercel\_\_daily_costs

{{include: packages/models/marts/vercel/vercel__daily_costs.yml}}

### vercel\_\_contract_commitments

{{include: packages/models/marts/vercel/vercel__contract_commitments.yml}}

### vercel\_\_metric_catalog

{{include: packages/models/marts/vercel/vercel__metric_catalog.yml}}

### vercel\_\_metric_schema

{{include: packages/models/marts/vercel/vercel__metric_schema.yml}}

### vercel\_\_sandboxes

{{include: packages/models/marts/vercel/vercel__sandboxes.yml}}

### vercel\_\_sandbox_sessions

{{include: packages/models/marts/vercel/vercel__sandbox_sessions.yml}}

### vercel\_\_sandbox_session_details

{{include: packages/models/marts/vercel/vercel__sandbox_session_details.yml}}

### vercel\_\_metric_query_results

{{include: packages/models/marts/vercel/vercel__metric_query_results.yml}}

### vercel\_\_daily_overview

{{include: packages/models/marts/vercel/vercel__daily_overview.yml}}

## Metrics

{{include: packages/models/marts/vercel/metrics/vercel_total_billed_cost.yml}}
{{include: packages/models/marts/vercel/metrics/vercel_total_effective_cost.yml}}
{{include: packages/models/marts/vercel/metrics/vercel_deployment_count.yml}}

## Relationships

{{include: packages/models/marts/vercel/relationships/vercel_deployments_to_projects.yml}}
{{include: packages/models/marts/vercel/relationships/vercel_daily_overview_to_projects.yml}}

## Adaptation rules

The generated source and staging layers are produced from the loaded Vercel
resource schemas. Install only the resource slices that landed in the
warehouse, and remove a mart when its staging dependency is absent. The daily
cost models keep billed cost, effective cost, consumed quantity, pricing
quantity, currencies, and native units separate. Null project and region values
remain unattributed.

The metric query mart keeps the complete request envelope (scope, filters,
grouping, ordering, granularity, timezone, and requested bounds), result arrays,
and coverage evidence intact. Flatten a metric only after discovering its metric
schema and supported dimensions. Deployment build
duration is elapsed operational time and is not verified billed compute.

Deployment and sandbox child lookups retain the caller's team ID or slug when
provided. Sandbox session marts preserve the documented runtime, timeout,
working-directory, lifecycle, snapshot, CPU, and network fields; measurements
that Vercel omits remain null.

The sandbox mart also preserves the documented snapshot retention, network,
working-directory, and mount fields. The Query API's sandbox metrics (active CPU,
CPU usage, provisioned memory, peak memory, and data transfer) remain in the
generic metric query envelope until the account's metric catalog confirms the
available dimensions.

Vercel's AI Gateway Custom Reporting API is a separate host and credential
(`https://ai-gateway.vercel.sh/v1/report` with an AI Gateway API key or OIDC
token). It is not included in this package, which authenticates against
`api.vercel.com` with `VERCEL_TOKEN`; add it as a separate source/package when
an AI Gateway credential and an explicit reporting scope are available.

## Optional workload recipes

These recipes are intentionally not part of the default package until a
workload mapping exists:

### `vercel__workload_usage_daily`

Daily measured usage by explicit workload (`eve` or `app`), metric, unit,
region, and day. The mapping must connect a sandbox identity or exclusive route
to a workload and retain evidence and coverage.

### `vercel__workload_cost_allocation`

Estimated monetary allocation with `method`, `evidence`, `coverage`, and a
shared/unallocated remainder. For each service, allocate only against its
matching usage driver:

`native service cost × workload usage / total matching usage`

CPU uses active CPU, invocations use counts, and transfer uses bytes. Memory
allocation requires an explicit concurrency assumption. Shared subscriptions,
builds, unknown usage, credits, commitments, late adjustments, and external
provider charges remain separate. These values are estimates and can differ
from Vercel's final bill.
