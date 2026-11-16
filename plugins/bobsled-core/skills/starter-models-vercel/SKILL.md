---
name: starter-models-vercel
description: Curated Vercel starter models, metrics, and relationships for
  projects, deployments, FOCUS billing, commitments, observability queries, and
  sandbox operations.
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

spec_version: '0.2'
name: vercel__projects
type: model
description: One row per Vercel project with reusable project and source-control context.
grain: project_id
source:
  ref: stg_vercel__projects
columns:
  - name: project_id
    expr: stg_vercel__projects.project_id
    primary_key: true
    semantic_role: entity_id
    description: Stable Vercel project identifier.
  - name: project_name
    expr: stg_vercel__projects.name
    semantic_role: categorical
    description: Vercel project name.
  - name: account_id
    expr: stg_vercel__projects.account_id
    semantic_role: entity_id
    description: Owning team or account identifier.
  - name: framework
    expr: stg_vercel__projects.framework
    semantic_role: categorical
    description: Configured or detected framework.
  - name: node_version
    expr: stg_vercel__projects.node_version
    semantic_role: categorical
    description: Configured Node.js version.
  - name: root_directory
    expr: stg_vercel__projects.root_directory
    semantic_role: categorical
    description: Configured project root directory.
  - name: build_command
    expr: stg_vercel__projects.build_command
    semantic_role: categorical
    description: Configured build command.
  - name: output_directory
    expr: stg_vercel__projects.output_directory
    semantic_role: categorical
    description: Configured output directory.
  - name: created_at
    expr: stg_vercel__projects.created_at
    semantic_role: event_timestamp
    description: Project creation timestamp.
  - name: updated_at
    expr: stg_vercel__projects.updated_at
    semantic_role: event_timestamp
    description: Last project update timestamp.
  - name: project_settings
    expr: stg_vercel__projects.project_settings
    semantic_role: categorical
    description: Native Vercel project settings.
  - name: link
    expr: stg_vercel__projects.link
    semantic_role: categorical
    description: Source-control link metadata.
tags:
  - vercel
  - projects
  - context
trust_tier: gold
materialization:
  type: table

### vercel\_\_deployments

spec_version: '0.2'
name: vercel__deployments
type: model
description: One row per Vercel deployment with environment, lifecycle, metadata, and observed build elapsed time.
grain: deployment_id
source:
  ref: stg_vercel__deployments
joins:
  - ref: stg_vercel__projects
    type: left
    on: stg_vercel__deployments.project_id = stg_vercel__projects.project_id
columns:
  - name: deployment_id
    expr: stg_vercel__deployments.uid
    primary_key: true
    semantic_role: entity_id
    description: Stable Vercel deployment identifier.
  - name: project_id
    expr: stg_vercel__deployments.project_id
    semantic_role: entity_id
    references: stg_vercel__projects.project_id
    description: Vercel project identifier.
  - name: team_id
    expr: stg_vercel__deployments.team_id
    semantic_role: entity_id
    description: Vercel team identifier supplied for the extraction request.
  - name: team_slug
    expr: stg_vercel__deployments.team_slug
    semantic_role: categorical
    description: Vercel team slug supplied for the extraction request.
  - name: project_name
    expr: stg_vercel__projects.name
    semantic_role: categorical
    description: Project name from the project catalog when the deployment project is known.
  - name: project_account_id
    expr: stg_vercel__projects.account_id
    semantic_role: entity_id
    description: Owning Vercel team or account identifier from the project catalog.
  - name: project_framework
    expr: stg_vercel__projects.framework
    semantic_role: categorical
    description: Framework configured or detected for the deployment project.
  - name: deployment_name
    expr: stg_vercel__deployments.name
    semantic_role: categorical
    description: Deployment name.
  - name: target
    expr: stg_vercel__deployments.target
    semantic_role: categorical
    description: Deployment target environment.
  - name: state
    expr: stg_vercel__deployments.state
    semantic_role: categorical
    description: Current deployment state.
  - name: ready_state
    expr: stg_vercel__deployments.ready_state
    semantic_role: categorical
    description: Current deployment readiness state.
  - name: source
    expr: stg_vercel__deployments.source
    semantic_role: categorical
    description: Deployment creation source.
  - name: url
    expr: stg_vercel__deployments.url
    semantic_role: categorical
    description: Deployment URL.
  - name: created_at
    expr: stg_vercel__deployments.created_at
    semantic_role: event_timestamp
    description: Deployment creation timestamp.
  - name: created_timestamp
    expr: stg_vercel__deployments.created_timestamp
    semantic_role: event_timestamp
    description: Native Vercel deployment creation timestamp when returned separately from created_at.
  - name: building_at
    expr: stg_vercel__deployments.building_at
    semantic_role: event_timestamp
    description: Time the deployment began building.
  - name: ready_at
    expr: stg_vercel__deployments.ready
    semantic_role: event_timestamp
    description: Time the deployment became ready.
  - name: ready_substate
    expr: stg_vercel__deployments.ready_substate
    semantic_role: categorical
    description: Provider readiness substate when returned.
  - name: error_code
    expr: stg_vercel__deployments.error_code
    semantic_role: categorical
    description: Provider deployment error code when present.
  - name: error_message
    expr: stg_vercel__deployments.error_message
    semantic_role: categorical
    description: Provider deployment error message when present.
  - name: observed_build_duration_ms
    expr: stg_vercel__deployments.ready - stg_vercel__deployments.building_at
    semantic_role: measure
    unit: milliseconds
    description: Elapsed time between Vercel build and ready timestamps. This is operational time, not verified billed compute.
  - name: creator
    expr: stg_vercel__deployments.creator
    semantic_role: categorical
    description: Deployment creator metadata.
  - name: meta
    expr: stg_vercel__deployments.meta
    semantic_role: categorical
    description: Source-control metadata.
  - name: project_settings
    expr: stg_vercel__deployments.project_settings
    semantic_role: categorical
    description: Project settings returned with the deployment.
group_by:
  - deployment_id
  - project_id
  - team_id
  - team_slug
  - project_name
  - project_account_id
  - project_framework
  - deployment_name
  - target
  - state
  - ready_state
  - source
  - url
  - created_at
  - created_timestamp
  - building_at
  - ready_at
  - ready_substate
  - error_code
  - error_message
  - creator
  - meta
  - project_settings
tags:
  - vercel
  - deployments
  - operations
trust_tier: gold
materialization:
  type: table

### vercel\_\_deployment_details

spec_version: '0.2'
name: vercel__deployment_details
type: model
description: Detailed Vercel deployment configuration and lifecycle metadata, enriched with project context.
grain: deployment_detail_id
source:
  ref: stg_vercel__deployment_details
joins:
  - ref: stg_vercel__deployments
    type: left
    on: stg_vercel__deployment_details.uid = stg_vercel__deployments.uid
  - ref: stg_vercel__projects
    type: left
    on: stg_vercel__deployment_details.project_id = stg_vercel__projects.project_id
columns:
  - name: deployment_detail_id
    expr: stg_vercel__deployment_details.deployment_detail_id
    primary_key: true
    semantic_role: entity_id
    description: Identifier returned by the deployment detail endpoint.
  - name: deployment_id
    expr: stg_vercel__deployment_details.uid
    semantic_role: entity_id
    references: stg_vercel__deployments.uid
    description: Deployment UID when returned by the detail endpoint.
  - name: project_id
    expr: stg_vercel__deployment_details.project_id
    semantic_role: entity_id
    references: stg_vercel__projects.project_id
    description: Vercel project identifier.
  - name: team_id
    expr: stg_vercel__deployment_details.team_id
    semantic_role: entity_id
    description: Vercel team identifier supplied for the extraction request.
  - name: team_slug
    expr: stg_vercel__deployment_details.team_slug
    semantic_role: categorical
    description: Vercel team slug supplied for the extraction request.
  - name: project_name
    expr: stg_vercel__projects.name
    semantic_role: categorical
    description: Project name from the project catalog when the deployment project is known.
  - name: project_framework
    expr: stg_vercel__projects.framework
    semantic_role: categorical
    description: Framework configured or detected for the deployment project.
  - name: deployment_name
    expr: stg_vercel__deployment_details.name
    semantic_role: categorical
    description: Deployment name.
  - name: target
    expr: stg_vercel__deployment_details.target
    semantic_role: categorical
    description: Deployment target environment.
  - name: ready_state
    expr: stg_vercel__deployment_details.ready_state
    semantic_role: categorical
    description: Deployment readiness state.
  - name: created_at
    expr: stg_vercel__deployment_details.created_at
    semantic_role: event_timestamp
    description: Deployment creation timestamp.
  - name: building_at
    expr: stg_vercel__deployment_details.building_at
    semantic_role: event_timestamp
    description: Time the deployment began building.
  - name: ready_at
    expr: stg_vercel__deployment_details.ready
    semantic_role: event_timestamp
    description: Time the deployment became ready when Vercel provides it.
  - name: meta
    expr: stg_vercel__deployment_details.meta
    semantic_role: categorical
    description: Source-control metadata.
  - name: project_settings
    expr: stg_vercel__deployment_details.project_settings
    semantic_role: categorical
    description: Project settings associated with the deployment.
  - name: resource_config
    expr: stg_vercel__deployment_details.resource_config
    semantic_role: categorical
    description: Deployment resource configuration, including build-machine settings when available.
tags:
  - vercel
  - deployments
  - operations
trust_tier: gold
materialization:
  type: table

### vercel\_\_billing_charges

spec_version: '0.2'
name: vercel__billing_charges
type: model
description: FOCUS billing detail at the selected snapshot and record ordinal; billed and effective costs remain separate.
grain:
  - snapshot_id
  - record_ordinal
source:
  ref: stg_vercel__billing_charges
columns:
  - name: snapshot_id
    expr: stg_vercel__billing_charges.snapshot_id
    primary_key: true
    semantic_role: entity_id
    description: Complete bounded billing snapshot selected for analysis.
  - name: record_ordinal
    expr: stg_vercel__billing_charges.record_ordinal
    primary_key: true
    semantic_role: entity_id
    description: JSONL record ordinal within the selected snapshot.
  - name: snapshot_from
    expr: stg_vercel__billing_charges.snapshot_from
    semantic_role: time_dimension
    description: Inclusive snapshot start.
  - name: snapshot_to
    expr: stg_vercel__billing_charges.snapshot_to
    semantic_role: time_dimension
    description: Exclusive snapshot end.
  - name: retrieval_time
    expr: stg_vercel__billing_charges.retrieval_time
    semantic_role: time_dimension
    description: UTC retrieval time for the selected snapshot.
  - name: team_id
    expr: stg_vercel__billing_charges.team_id
    semantic_role: entity_id
    description: Team scope used for the request.
  - name: team_slug
    expr: stg_vercel__billing_charges.team_slug
    semantic_role: categorical
    description: Team slug used for the request.
  - name: project_id
    expr: stg_vercel__billing_charges.project_id
    semantic_role: entity_id
    references: stg_vercel__projects.project_id
    description: Project identifier when Vercel exposes a recognized tag key; otherwise null.
  - name: project_name
    expr: stg_vercel__billing_charges.project_name
    semantic_role: categorical
    description: Project name when Vercel exposes a recognized tag key; otherwise null.
  - name: billed_cost
    expr: stg_vercel__billing_charges.billed_cost
    semantic_role: measure
    tags:
      - financial
    description: Native billed cost.
  - name: effective_cost
    expr: stg_vercel__billing_charges.effective_cost
    semantic_role: measure
    tags:
      - financial
    description: Native effective cost.
  - name: billing_currency
    expr: stg_vercel__billing_charges.billing_currency
    semantic_role: categorical
    description: Billing currency.
  - name: consumed_quantity
    expr: stg_vercel__billing_charges.consumed_quantity
    semantic_role: measure
    description: Native consumed quantity.
  - name: consumed_unit
    expr: stg_vercel__billing_charges.consumed_unit
    semantic_role: categorical
    description: Unit for consumed quantity.
  - name: pricing_quantity
    expr: stg_vercel__billing_charges.pricing_quantity
    semantic_role: measure
    description: Native pricing quantity.
  - name: pricing_unit
    expr: stg_vercel__billing_charges.pricing_unit
    semantic_role: categorical
    description: Unit for pricing quantity.
  - name: charge_period_start
    expr: stg_vercel__billing_charges.charge_period_start
    semantic_role: time_dimension
    description: Native charge period start.
  - name: charge_period_end
    expr: stg_vercel__billing_charges.charge_period_end
    semantic_role: time_dimension
    description: Native charge period end.
  - name: charge_category
    expr: stg_vercel__billing_charges.charge_category
    semantic_role: categorical
    description: FOCUS charge category.
  - name: service_name
    expr: stg_vercel__billing_charges.service_name
    semantic_role: categorical
    description: Native service name.
  - name: service_category
    expr: stg_vercel__billing_charges.service_category
    semantic_role: categorical
    description: Native service category.
  - name: service_provider_name
    expr: stg_vercel__billing_charges.service_provider_name
    semantic_role: categorical
    description: Native service provider.
  - name: region_id
    expr: stg_vercel__billing_charges.region_id
    semantic_role: categorical
    description: Native region identifier.
  - name: region_name
    expr: stg_vercel__billing_charges.region_name
    semantic_role: categorical
    description: Native region name.
  - name: tags
    expr: stg_vercel__billing_charges.tags
    semantic_role: categorical
    description: Native Vercel tags preserved as JSON.
  - name: pricing_category
    expr: stg_vercel__billing_charges.pricing_category
    semantic_role: categorical
    description: FOCUS pricing category.
  - name: pricing_currency
    expr: stg_vercel__billing_charges.pricing_currency
    semantic_role: categorical
    description: Pricing currency.
tags:
  - vercel
  - billing
  - finance
trust_tier: gold
materialization:
  type: table

### vercel\_\_daily_costs

spec_version: '0.2'
name: vercel__daily_costs
type: model
description: Daily Vercel spend grouped by selected snapshot, team, project, service, region, currency, category, and native units.
grain:
  - snapshot_id
  - date
  - team_id
  - project_id
  - service_name
  - region_id
  - billing_currency
  - pricing_currency
  - charge_category
  - consumed_unit
  - pricing_unit
source:
  ref: stg_vercel__billing_charges
columns:
  - name: snapshot_id
    expr: stg_vercel__billing_charges.snapshot_id
    primary_key: true
    semantic_role: entity_id
    description: Selected complete billing snapshot.
  - name: date
    expr: CAST(stg_vercel__billing_charges.charge_period_start AS DATE)
    primary_key: true
    semantic_role: time_dimension
    description: UTC day containing the native charge-period start.
  - name: team_id
    expr: stg_vercel__billing_charges.team_id
    primary_key: true
    semantic_role: entity_id
    description: Vercel team identifier.
  - name: project_id
    expr: stg_vercel__billing_charges.project_id
    primary_key: true
    semantic_role: entity_id
    references: stg_vercel__projects.project_id
    description: Project identifier when available from native tags; null remains unattributed.
  - name: service_name
    expr: stg_vercel__billing_charges.service_name
    primary_key: true
    semantic_role: categorical
    description: Native service name.
  - name: region_id
    expr: stg_vercel__billing_charges.region_id
    primary_key: true
    semantic_role: categorical
    description: Native region identifier; null remains unattributed.
  - name: billing_currency
    expr: stg_vercel__billing_charges.billing_currency
    primary_key: true
    semantic_role: categorical
    description: Billing currency.
  - name: pricing_currency
    expr: stg_vercel__billing_charges.pricing_currency
    primary_key: true
    semantic_role: categorical
    description: Currency for pricing quantity. Unlike currencies are not grouped together.
  - name: charge_category
    expr: stg_vercel__billing_charges.charge_category
    primary_key: true
    semantic_role: categorical
    description: FOCUS charge category.
  - name: consumed_unit
    expr: stg_vercel__billing_charges.consumed_unit
    primary_key: true
    semantic_role: categorical
    description: Unit for consumed quantity. Unlike units are not summed together.
  - name: pricing_unit
    expr: stg_vercel__billing_charges.pricing_unit
    primary_key: true
    semantic_role: categorical
    description: Unit for pricing quantity. Unlike units are not summed together.
  - name: charge_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of charge lines in the bucket.
  - name: total_billed_cost
    expr: SUM(stg_vercel__billing_charges.billed_cost)
    semantic_role: measure
    tags:
      - financial
    description: Sum of native billed costs for the bucket.
  - name: total_effective_cost
    expr: SUM(stg_vercel__billing_charges.effective_cost)
    semantic_role: measure
    tags:
      - financial
    description: Sum of native effective costs for the bucket.
  - name: total_consumed_quantity
    expr: SUM(stg_vercel__billing_charges.consumed_quantity)
    semantic_role: measure
    description: Sum of consumed quantity within one native unit.
  - name: total_pricing_quantity
    expr: SUM(stg_vercel__billing_charges.pricing_quantity)
    semantic_role: measure
    description: Sum of pricing quantity within one native unit.
group_by:
  - snapshot_id
  - date
  - team_id
  - project_id
  - service_name
  - region_id
  - billing_currency
  - pricing_currency
  - charge_category
  - consumed_unit
  - pricing_unit
tags:
  - vercel
  - billing
  - daily
trust_tier: gold
materialization:
  type: table

### vercel\_\_contract_commitments

spec_version: '0.2'
name: vercel__contract_commitments
type: model
description: Vercel contract and commitment detail kept separate from charge totals.
grain:
  - snapshot_id
  - record_ordinal
source:
  ref: stg_vercel__contract_commitments
columns:
  - name: snapshot_id
    expr: stg_vercel__contract_commitments.snapshot_id
    primary_key: true
    semantic_role: entity_id
    description: Selected commitments snapshot.
  - name: record_ordinal
    expr: stg_vercel__contract_commitments.record_ordinal
    primary_key: true
    semantic_role: entity_id
    description: JSONL record ordinal within the selected snapshot.
  - name: team_id
    expr: stg_vercel__contract_commitments.team_id
    semantic_role: entity_id
    description: Vercel team identifier.
  - name: team_slug
    expr: stg_vercel__contract_commitments.team_slug
    semantic_role: categorical
    description: Vercel team slug used for the request.
  - name: retrieval_time
    expr: stg_vercel__contract_commitments.retrieval_time
    semantic_role: time_dimension
    description: UTC retrieval time for the selected snapshot.
  - name: contract_id
    expr: stg_vercel__contract_commitments.contract_id
    semantic_role: entity_id
    description: Native contract identifier.
  - name: commitment_id
    expr: stg_vercel__contract_commitments.commitment_id
    semantic_role: entity_id
    description: Native commitment identifier.
  - name: commitment_category
    expr: stg_vercel__contract_commitments.commitment_category
    semantic_role: categorical
    description: FOCUS contract commitment category.
  - name: commitment_type
    expr: stg_vercel__contract_commitments.commitment_type
    semantic_role: categorical
    description: Provider-assigned commitment type.
  - name: commitment_description
    expr: stg_vercel__contract_commitments.commitment_description
    semantic_role: categorical
    description: Provider-supplied commitment description.
  - name: contract_period_start
    expr: stg_vercel__contract_commitments.contract_period_start
    semantic_role: time_dimension
    description: Overall contract period start.
  - name: contract_period_end
    expr: stg_vercel__contract_commitments.contract_period_end
    semantic_role: time_dimension
    description: Overall contract period end.
  - name: commitment_period_start
    expr: stg_vercel__contract_commitments.commitment_period_start
    semantic_role: time_dimension
    description: Commitment period start.
  - name: commitment_period_end
    expr: stg_vercel__contract_commitments.commitment_period_end
    semantic_role: time_dimension
    description: Commitment period end.
  - name: commitment_quantity
    expr: stg_vercel__contract_commitments.commitment_quantity
    semantic_role: measure
    description: Quantity associated with the commitment.
  - name: commitment_unit
    expr: stg_vercel__contract_commitments.commitment_unit
    semantic_role: categorical
    description: Commitment quantity unit.
  - name: commitment_cost
    expr: stg_vercel__contract_commitments.commitment_cost
    semantic_role: measure
    tags:
      - financial
    description: Native cost associated with the commitment.
  - name: currency
    expr: stg_vercel__contract_commitments.currency
    semantic_role: categorical
    description: Commitment currency.
tags:
  - vercel
  - billing
  - commitments
trust_tier: gold
materialization:
  type: table

### vercel\_\_metric_catalog

spec_version: '0.2'
name: vercel__metric_catalog
type: model
description: Metric identifiers exposed by the authenticated Vercel account for query planning.
grain: metric_id
source:
  ref: stg_vercel__metric_catalog
columns:
  - name: metric_id
    expr: stg_vercel__metric_catalog.metric_catalog_id
    primary_key: true
    semantic_role: entity_id
    description: Stable Vercel metric identifier.
  - name: description
    expr: stg_vercel__metric_catalog.description
    semantic_role: categorical
    description: Metric description returned by Vercel.
tags:
  - vercel
  - observability
  - metrics
trust_tier: gold
materialization:
  type: table

### vercel\_\_metric_schema

spec_version: '0.2'
name: vercel__metric_schema
type: model
description: Supported dimensions, units, and aggregations for each Vercel observability metric.
grain:
  - metric_id
  - metric_schema_id
source:
  ref: stg_vercel__metric_schema
joins:
  - ref: stg_vercel__metric_catalog
    type: left
    on: stg_vercel__metric_schema.metric_id = stg_vercel__metric_catalog.metric_catalog_id
columns:
  - name: metric_id
    expr: stg_vercel__metric_schema.metric_id
    primary_key: true
    semantic_role: entity_id
    references: stg_vercel__metric_catalog.metric_catalog_id
    description: Metric identifier used by the query endpoint.
  - name: metric_schema_id
    expr: stg_vercel__metric_schema.metric_schema_id
    primary_key: true
    semantic_role: entity_id
    description: Identifier returned by the metric schema endpoint.
  - name: metric_description
    expr: stg_vercel__metric_schema.description
    semantic_role: categorical
    description: Metric description returned by Vercel.
  - name: catalog_description
    expr: stg_vercel__metric_catalog.description
    semantic_role: categorical
    description: Metric description from the account metric catalog.
  - name: dimensions
    expr: stg_vercel__metric_schema.dimensions
    semantic_role: categorical
    description: Supported dimensions, preserved as returned so new Vercel dimensions remain queryable.
  - name: unit
    expr: stg_vercel__metric_schema.unit
    semantic_role: categorical
    description: Native metric unit.
  - name: aggregations
    expr: stg_vercel__metric_schema.aggregations
    semantic_role: categorical
    description: Supported aggregation names.
  - name: default_aggregation
    expr: stg_vercel__metric_schema.default_aggregation
    semantic_role: categorical
    description: Default aggregation selected by Vercel.
tags:
  - vercel
  - observability
  - metrics
trust_tier: gold
materialization:
  type: table

### vercel\_\_sandboxes

spec_version: '0.2'
name: vercel__sandboxes
type: model
description: Vercel sandbox configuration and cumulative usage counters, retained without summing repeated observations.
grain:
  - project_id
  - sandbox_name
source:
  ref: stg_vercel__sandboxes
joins:
  - ref: stg_vercel__projects
    type: left
    on: stg_vercel__sandboxes.project_id = stg_vercel__projects.project_id
columns:
  - name: project_id
    expr: stg_vercel__sandboxes.project_id
    primary_key: true
    semantic_role: entity_id
    references: stg_vercel__projects.project_id
    description: Vercel project scope when supplied.
  - name: team_id
    expr: stg_vercel__sandboxes.team_id
    semantic_role: entity_id
    description: Vercel team identifier supplied for the extraction request.
  - name: team_slug
    expr: stg_vercel__sandboxes.team_slug
    semantic_role: categorical
    description: Vercel team slug supplied for the extraction request.
  - name: sandbox_name
    expr: stg_vercel__sandboxes.name
    primary_key: true
    semantic_role: entity_id
    description: Stable sandbox name within a project.
  - name: project_name
    expr: stg_vercel__projects.name
    semantic_role: categorical
    description: Project name from the project catalog when the sandbox project is known.
  - name: project_account_id
    expr: stg_vercel__projects.account_id
    semantic_role: entity_id
    description: Owning Vercel team or account identifier from the project catalog.
  - name: project_framework
    expr: stg_vercel__projects.framework
    semantic_role: categorical
    description: Framework configured or detected for the sandbox project.
  - name: current_snapshot_id
    expr: stg_vercel__sandboxes.current_snapshot_id
    semantic_role: entity_id
    description: Current snapshot identifier.
  - name: current_session_id
    expr: stg_vercel__sandboxes.current_session_id
    semantic_role: entity_id
    description: Current session identifier.
  - name: status
    expr: stg_vercel__sandboxes.status
    semantic_role: categorical
    description: Current sandbox status.
  - name: status_updated_at
    expr: stg_vercel__sandboxes.status_updated_at
    semantic_role: event_timestamp
    description: Time the sandbox status last changed.
  - name: region
    expr: stg_vercel__sandboxes.region
    semantic_role: categorical
    description: Primary region.
  - name: failover_regions
    expr: stg_vercel__sandboxes.failover_regions
    semantic_role: categorical
    description: Configured failover regions.
  - name: vcpus
    expr: stg_vercel__sandboxes.vcpus
    semantic_role: measure
    unit: vcpu
    description: Allocated virtual CPUs.
  - name: memory
    expr: stg_vercel__sandboxes.memory
    semantic_role: measure
    unit: megabytes
    description: Allocated memory.
  - name: runtime
    expr: stg_vercel__sandboxes.runtime
    semantic_role: categorical
    description: Sandbox runtime.
  - name: image
    expr: stg_vercel__sandboxes.image
    semantic_role: categorical
    description: Sandbox image identifier.
  - name: timeout
    expr: stg_vercel__sandboxes.timeout
    semantic_role: measure
    unit: milliseconds
    description: Sandbox timeout configuration.
  - name: snapshot_expiration
    expr: stg_vercel__sandboxes.snapshot_expiration
    semantic_role: measure
    unit: milliseconds
    description: Snapshot expiration interval in milliseconds.
  - name: keep_last_snapshots
    expr: stg_vercel__sandboxes.keep_last_snapshots
    semantic_role: categorical
    description: Snapshot retention settings returned by Vercel.
  - name: network_policy
    expr: stg_vercel__sandboxes.network_policy
    semantic_role: categorical
    description: Sandbox network policy.
  - name: network_id
    expr: stg_vercel__sandboxes.network_id
    semantic_role: entity_id
    description: Vercel network identifier when assigned.
  - name: cwd
    expr: stg_vercel__sandboxes.cwd
    semantic_role: categorical
    description: Sandbox working directory.
  - name: persistent
    expr: stg_vercel__sandboxes.persistent
    semantic_role: categorical
    description: Whether the sandbox persists between sessions.
  - name: tags
    expr: stg_vercel__sandboxes.tags
    semantic_role: categorical
    description: User-defined tags for workload mapping.
  - name: mounts
    expr: stg_vercel__sandboxes.mounts
    semantic_role: categorical
    description: Sandbox mounts returned by Vercel.
  - name: total_egress_bytes
    expr: stg_vercel__sandboxes.total_egress_bytes
    semantic_role: measure
    unit: bytes
    description: Latest cumulative egress counter.
  - name: total_ingress_bytes
    expr: stg_vercel__sandboxes.total_ingress_bytes
    semantic_role: measure
    unit: bytes
    description: Latest cumulative ingress counter.
  - name: total_active_cpu_duration_ms
    expr: stg_vercel__sandboxes.total_active_cpu_duration_ms
    semantic_role: measure
    unit: milliseconds
    description: Latest cumulative active CPU counter.
  - name: total_duration_ms
    expr: stg_vercel__sandboxes.total_duration_ms
    semantic_role: measure
    unit: milliseconds
    description: Latest cumulative duration counter.
  - name: created_at
    expr: stg_vercel__sandboxes.created_at
    semantic_role: event_timestamp
    description: Sandbox creation timestamp.
  - name: updated_at
    expr: stg_vercel__sandboxes.updated_at
    semantic_role: event_timestamp
    description: Sandbox update timestamp.
  - name: expires_at
    expr: stg_vercel__sandboxes.expires_at
    semantic_role: event_timestamp
    description: Sandbox expiration timestamp when supplied.
tags:
  - vercel
  - sandboxes
  - operations
trust_tier: gold
materialization:
  type: table

### vercel\_\_sandbox_sessions

spec_version: '0.2'
name: vercel__sandbox_sessions
type: model
description: One row per Vercel sandbox session with lifecycle and measured CPU and network usage when available.
grain: session_id
source:
  ref: stg_vercel__sandbox_sessions
joins:
  - ref: stg_vercel__projects
    type: left
    on: stg_vercel__sandbox_sessions.project_id = stg_vercel__projects.project_id
  - ref: stg_vercel__sandboxes
    type: left
    on: stg_vercel__sandbox_sessions.project_id = stg_vercel__sandboxes.project_id AND stg_vercel__sandbox_sessions.source_sandbox_name = stg_vercel__sandboxes.name
columns:
  - name: session_id
    expr: stg_vercel__sandbox_sessions.sandbox_session_id
    primary_key: true
    semantic_role: entity_id
    description: Stable sandbox session identifier.
  - name: source_sandbox_name
    expr: stg_vercel__sandbox_sessions.source_sandbox_name
    semantic_role: entity_id
    description: Sandbox name that created the session.
  - name: project_id
    expr: stg_vercel__sandbox_sessions.project_id
    semantic_role: entity_id
    references: stg_vercel__projects.project_id
    description: Vercel project identifier.
  - name: team_id
    expr: stg_vercel__sandbox_sessions.team_id
    semantic_role: entity_id
    description: Vercel team identifier supplied for the extraction request.
  - name: team_slug
    expr: stg_vercel__sandbox_sessions.team_slug
    semantic_role: categorical
    description: Vercel team slug supplied for the extraction request.
  - name: project_name
    expr: stg_vercel__projects.name
    semantic_role: categorical
    description: Project name from the project catalog when the session project is known.
  - name: project_framework
    expr: stg_vercel__projects.framework
    semantic_role: categorical
    description: Framework configured or detected for the session project.
  - name: sandbox_tags
    expr: stg_vercel__sandboxes.tags
    semantic_role: categorical
    description: Tags from the named sandbox when a matching sandbox record is available.
  - name: region
    expr: stg_vercel__sandbox_sessions.region
    semantic_role: categorical
    description: Session region.
  - name: status
    expr: stg_vercel__sandbox_sessions.status
    semantic_role: categorical
    description: Session lifecycle status.
  - name: runtime
    expr: stg_vercel__sandbox_sessions.runtime
    semantic_role: categorical
    description: Session runtime.
  - name: cwd
    expr: stg_vercel__sandbox_sessions.cwd
    semantic_role: categorical
    description: Session working directory.
  - name: timeout
    expr: stg_vercel__sandbox_sessions.timeout
    semantic_role: measure
    unit: milliseconds
    description: Session timeout configuration.
  - name: memory
    expr: stg_vercel__sandbox_sessions.memory
    semantic_role: measure
    unit: megabytes
    description: Allocated session memory.
  - name: vcpus
    expr: stg_vercel__sandbox_sessions.vcpus
    semantic_role: measure
    unit: vcpu
    description: Allocated session virtual CPUs.
  - name: requested_at
    expr: stg_vercel__sandbox_sessions.requested_at
    semantic_role: event_timestamp
    description: Session request timestamp.
  - name: requested_stop_at
    expr: stg_vercel__sandbox_sessions.requested_stop_at
    semantic_role: event_timestamp
    description: Requested stop timestamp when available.
  - name: snapshotted_at
    expr: stg_vercel__sandbox_sessions.snapshotted_at
    semantic_role: event_timestamp
    description: Snapshot request timestamp when available.
  - name: started_at
    expr: stg_vercel__sandbox_sessions.started_at
    semantic_role: event_timestamp
    description: Session start timestamp.
  - name: stopped_at
    expr: stg_vercel__sandbox_sessions.stopped_at
    semantic_role: event_timestamp
    description: Successful stop timestamp.
  - name: aborted_at
    expr: stg_vercel__sandbox_sessions.aborted_at
    semantic_role: event_timestamp
    description: Abort timestamp when available.
  - name: duration
    expr: stg_vercel__sandbox_sessions.duration
    semantic_role: measure
    unit: milliseconds
    description: Session duration.
  - name: active_cpu_duration_ms
    expr: stg_vercel__sandbox_sessions.active_cpu_duration_ms
    semantic_role: measure
    unit: milliseconds
    description: Active CPU duration after successful stop; null is not zero.
  - name: network_transfer
    expr: stg_vercel__sandbox_sessions.network_transfer
    semantic_role: categorical
    description: Network transfer measurements when available.
  - name: network_policy
    expr: stg_vercel__sandbox_sessions.network_policy
    semantic_role: categorical
    description: Session network policy.
  - name: source_snapshot_id
    expr: stg_vercel__sandbox_sessions.source_snapshot_id
    semantic_role: entity_id
    description: Source snapshot identifier.
  - name: created_at
    expr: stg_vercel__sandbox_sessions.created_at
    semantic_role: event_timestamp
    description: Session creation timestamp.
  - name: updated_at
    expr: stg_vercel__sandbox_sessions.updated_at
    semantic_role: event_timestamp
    description: Session update timestamp.
tags:
  - vercel
  - sandboxes
  - sessions
trust_tier: gold
materialization:
  type: table

### vercel\_\_sandbox_session_details

spec_version: '0.2'
name: vercel__sandbox_session_details
type: model
description: Detailed Vercel sandbox session state and final measurements, enriched with project and sandbox context.
grain: sandbox_session_detail_id
source:
  ref: stg_vercel__sandbox_session_details
joins:
  - ref: stg_vercel__sandbox_sessions
    type: left
    on: stg_vercel__sandbox_session_details.sandbox_session_detail_id = stg_vercel__sandbox_sessions.sandbox_session_id
  - ref: stg_vercel__projects
    type: left
    on: stg_vercel__sandbox_session_details.project_id = stg_vercel__projects.project_id
  - ref: stg_vercel__sandboxes
    type: left
    on: stg_vercel__sandbox_session_details.project_id = stg_vercel__sandboxes.project_id AND stg_vercel__sandbox_session_details.source_sandbox_name = stg_vercel__sandboxes.name
columns:
  - name: sandbox_session_detail_id
    expr: stg_vercel__sandbox_session_details.sandbox_session_detail_id
    primary_key: true
    semantic_role: entity_id
    description: Identifier returned by the sandbox session detail endpoint.
  - name: session_id
    expr: stg_vercel__sandbox_session_details.sandbox_session_detail_id
    semantic_role: entity_id
    references: stg_vercel__sandbox_sessions.sandbox_session_id
    description: Sandbox session identifier.
  - name: source_sandbox_name
    expr: stg_vercel__sandbox_session_details.source_sandbox_name
    semantic_role: entity_id
    description: Sandbox name that created the session.
  - name: project_id
    expr: stg_vercel__sandbox_session_details.project_id
    semantic_role: entity_id
    references: stg_vercel__projects.project_id
    description: Vercel project identifier.
  - name: team_id
    expr: stg_vercel__sandbox_session_details.team_id
    semantic_role: entity_id
    description: Vercel team identifier supplied for the extraction request.
  - name: team_slug
    expr: stg_vercel__sandbox_session_details.team_slug
    semantic_role: categorical
    description: Vercel team slug supplied for the extraction request.
  - name: project_name
    expr: stg_vercel__projects.name
    semantic_role: categorical
    description: Project name from the project catalog when the session project is known.
  - name: project_framework
    expr: stg_vercel__projects.framework
    semantic_role: categorical
    description: Framework configured or detected for the session project.
  - name: sandbox_tags
    expr: stg_vercel__sandboxes.tags
    semantic_role: categorical
    description: Tags from the named sandbox when a matching sandbox record is available.
  - name: region
    expr: stg_vercel__sandbox_session_details.region
    semantic_role: categorical
    description: Session region.
  - name: status
    expr: stg_vercel__sandbox_session_details.status
    semantic_role: categorical
    description: Session lifecycle status.
  - name: runtime
    expr: stg_vercel__sandbox_session_details.runtime
    semantic_role: categorical
    description: Session runtime.
  - name: timeout
    expr: stg_vercel__sandbox_session_details.timeout
    semantic_role: measure
    unit: milliseconds
    description: Session timeout configuration.
  - name: cwd
    expr: stg_vercel__sandbox_session_details.cwd
    semantic_role: categorical
    description: Session working directory.
  - name: memory
    expr: stg_vercel__sandbox_session_details.memory
    semantic_role: measure
    unit: megabytes
    description: Allocated session memory.
  - name: vcpus
    expr: stg_vercel__sandbox_session_details.vcpus
    semantic_role: measure
    unit: vcpu
    description: Allocated session virtual CPUs.
  - name: requested_at
    expr: stg_vercel__sandbox_session_details.requested_at
    semantic_role: event_timestamp
    description: Session request timestamp.
  - name: started_at
    expr: stg_vercel__sandbox_session_details.started_at
    semantic_role: event_timestamp
    description: Session start timestamp.
  - name: requested_stop_at
    expr: stg_vercel__sandbox_session_details.requested_stop_at
    semantic_role: event_timestamp
    description: Requested stop timestamp when available.
  - name: stopped_at
    expr: stg_vercel__sandbox_session_details.stopped_at
    semantic_role: event_timestamp
    description: Successful stop timestamp when available.
  - name: aborted_at
    expr: stg_vercel__sandbox_session_details.aborted_at
    semantic_role: event_timestamp
    description: Abort timestamp when available.
  - name: snapshotted_at
    expr: stg_vercel__sandbox_session_details.snapshotted_at
    semantic_role: event_timestamp
    description: Snapshot request timestamp when available.
  - name: duration
    expr: stg_vercel__sandbox_session_details.duration
    semantic_role: measure
    unit: milliseconds
    description: Session duration.
  - name: active_cpu_duration_ms
    expr: stg_vercel__sandbox_session_details.active_cpu_duration_ms
    semantic_role: measure
    unit: milliseconds
    description: Final active CPU duration when measured. Null is not zero.
  - name: network_transfer
    expr: stg_vercel__sandbox_session_details.network_transfer
    semantic_role: categorical
    description: Final network transfer measurements when available.
  - name: network_policy
    expr: stg_vercel__sandbox_session_details.network_policy
    semantic_role: categorical
    description: Session network policy.
  - name: source_snapshot_id
    expr: stg_vercel__sandbox_session_details.source_snapshot_id
    semantic_role: entity_id
    description: Snapshot from which the session was created.
  - name: created_at
    expr: stg_vercel__sandbox_session_details.created_at
    semantic_role: event_timestamp
    description: Session creation timestamp.
  - name: updated_at
    expr: stg_vercel__sandbox_session_details.updated_at
    semantic_role: event_timestamp
    description: Session update timestamp.
  - name: routes
    expr: stg_vercel__sandbox_session_details.routes
    semantic_role: categorical
    description: Public sandbox routes returned by Vercel.
tags:
  - vercel
  - sandboxes
  - sessions
trust_tier: gold
materialization:
  type: table

### vercel\_\_metric_query_results

spec_version: '0.2'
name: vercel__metric_query_results
type: model
description: One row per Vercel metric query key and UTC window, preserving result arrays and query coverage evidence.
grain:
  - query_key
  - start_time
  - end_time
source:
  ref: stg_vercel__metric_query
columns:
  - name: query_key
    expr: stg_vercel__metric_query.query_key
    primary_key: true
    semantic_role: entity_id
    description: Stable caller-supplied query recipe key.
  - name: metric
    expr: stg_vercel__metric_query.metric
    semantic_role: categorical
    description: Queried metric identifier.
  - name: scope
    expr: stg_vercel__metric_query.scope
    semantic_role: categorical
    description: Owner or project scope used by Vercel.
  - name: aggregation
    expr: stg_vercel__metric_query.aggregation
    semantic_role: categorical
    description: Requested aggregation.
  - name: group_by
    expr: stg_vercel__metric_query.group_by
    semantic_role: categorical
    description: Requested grouping dimensions.
  - name: filter
    expr: stg_vercel__metric_query.filter
    semantic_role: categorical
    description: Requested metric filter expression.
  - name: limit
    expr: stg_vercel__metric_query.limit
    semantic_role: measure
    description: Requested maximum grouped result count.
  - name: order_by
    expr: stg_vercel__metric_query.order_by
    semantic_role: categorical
    description: Requested result ordering column.
  - name: order_direction
    expr: stg_vercel__metric_query.order_direction
    semantic_role: categorical
    description: Requested result ordering direction.
  - name: granularity
    expr: stg_vercel__metric_query.granularity
    semantic_role: categorical
    description: Requested time bucket configuration.
  - name: start_time
    expr: stg_vercel__metric_query.start_time
    primary_key: true
    semantic_role: time_dimension
    description: Inclusive UTC query start.
  - name: end_time
    expr: stg_vercel__metric_query.end_time
    primary_key: true
    semantic_role: time_dimension
    description: Exclusive UTC query end.
  - name: bucket_timezone
    expr: stg_vercel__metric_query.bucket_timezone
    semantic_role: categorical
    description: Requested IANA timezone used to align calendar buckets.
  - name: retrieval_time
    expr: stg_vercel__metric_query.retrieval_time
    semantic_role: event_timestamp
    description: UTC retrieval time.
  - name: data
    expr: stg_vercel__metric_query.data
    semantic_role: categorical
    description: Metric result rows preserved as a JSON array.
  - name: summary
    expr: stg_vercel__metric_query.summary
    semantic_role: categorical
    description: Query summary or control totals.
  - name: statistics
    expr: stg_vercel__metric_query.statistics
    semantic_role: categorical
    description: Query execution statistics.
  - name: coverage
    expr: stg_vercel__metric_query.coverage
    semantic_role: categorical
    description: Coverage evidence when returned. Grouped result arrays are not assumed exhaustive.
tags:
  - vercel
  - observability
  - metrics
trust_tier: gold
materialization:
  type: table

### vercel\_\_daily_overview

spec_version: '0.2'
name: vercel__daily_overview
type: model
description: Daily Vercel financial overview derived from daily costs without joining operational data that could multiply spend.
grain:
  - snapshot_id
  - date
  - team_id
  - project_id
  - billing_currency
source:
  ref: vercel__daily_costs
columns:
  - name: snapshot_id
    expr: vercel__daily_costs.snapshot_id
    primary_key: true
    semantic_role: entity_id
    description: Selected complete billing snapshot.
  - name: date
    expr: vercel__daily_costs.date
    primary_key: true
    semantic_role: time_dimension
    description: UTC billing day.
  - name: team_id
    expr: vercel__daily_costs.team_id
    primary_key: true
    semantic_role: entity_id
    description: Vercel team identifier.
  - name: project_id
    expr: vercel__daily_costs.project_id
    primary_key: true
    semantic_role: entity_id
    references: stg_vercel__projects.project_id
    description: Project identifier when available; null remains unattributed.
  - name: billing_currency
    expr: vercel__daily_costs.billing_currency
    primary_key: true
    semantic_role: categorical
    description: Billing currency.
  - name: charge_count
    expr: SUM(vercel__daily_costs.charge_count)
    semantic_role: measure
    description: Charge line count across native service and unit buckets.
  - name: total_billed_cost
    expr: SUM(vercel__daily_costs.total_billed_cost)
    semantic_role: measure
    tags:
      - financial
    description: Daily native billed cost.
  - name: total_effective_cost
    expr: SUM(vercel__daily_costs.total_effective_cost)
    semantic_role: measure
    tags:
      - financial
    description: Daily native effective cost.
group_by:
  - snapshot_id
  - date
  - team_id
  - project_id
  - billing_currency
tags:
  - vercel
  - billing
  - daily
  - overview
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: vercel_total_billed_cost
description: Total billed Vercel cost for one complete snapshot. Group results by billing currency before comparing or combining values.
model: vercel__daily_overview
expression: SUM({vercel__daily_overview}.total_billed_cost)
synonyms: [billed cost, Vercel spend, gross Vercel cost]
tags: [vercel, billing, finance]
spec_version: '0.2'
type: metric
name: vercel_total_effective_cost
description: Total effective Vercel cost for one complete snapshot. Group results by billing currency before comparing or combining values.
model: vercel__daily_overview
expression: SUM({vercel__daily_overview}.total_effective_cost)
synonyms: [effective cost, net Vercel cost, adjusted Vercel spend]
tags: [vercel, billing, finance]
spec_version: '0.2'
type: metric
name: vercel_deployment_count
description: Number of Vercel deployments.
model: vercel__deployments
expression: COUNT({vercel__deployments}.deployment_id)
synonyms: [deployments, deployment volume, deploy count]
tags: [vercel, deployments, engineering]

## Relationships

spec_version: '0.2'
type: relationship
name: vercel_deployments_to_projects
description: Each Vercel deployment belongs to one project.
left_model: vercel__deployments
right_model: vercel__projects
join_columns:
  - left: project_id
    right: project_id
join_type: left
relationship_type: many_to_one
tags: [vercel, deployments, projects]
spec_version: '0.2'
type: relationship
name: vercel_daily_overview_to_projects
description: Each project-attributed Vercel daily cost row belongs to one project.
left_model: vercel__daily_overview
right_model: vercel__projects
join_columns:
  - left: project_id
    right: project_id
join_type: left
relationship_type: many_to_one
tags: [vercel, billing, projects]

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
