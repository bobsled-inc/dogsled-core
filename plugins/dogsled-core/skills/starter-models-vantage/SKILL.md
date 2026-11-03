---
name: starter-models-vantage
description: Curated starter analytics models, metrics, and relationships for
  Vantage cloud cost observability. Pairs with the starter-data-models overview;
  adapt the bundle to the user's actually-loaded tables.
---

# Starter data models — Vantage

Cloud cost observability models for Vantage spend detail, cost reports, and provider coverage.

These are the **gold marts** for Vantage — the canonical analytics
tables an analyst would build on top of the loaded Vantage extract. Each
mart references a silver staging model named `stg_vantage__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### vantage\_\_anomaly_alerts

spec_version: '0.2'
name: vantage__anomaly_alerts
type: model
description: Cost anomaly alerts with provider, service, and amount attribution.
grain: anomaly_alert_id
source:
  ref: stg_vantage__anomaly_alerts
columns:
  - name: anomaly_alert_id
    expr: stg_vantage__anomaly_alerts.token
    primary_key: true
    semantic_role: entity_id
    description: Unique anomaly alert identifier.
  - name: category
    expr: stg_vantage__anomaly_alerts.category
    semantic_role: categorical
    description: Anomaly alert category.
  - name: service
    expr: stg_vantage__anomaly_alerts.service
    semantic_role: categorical
    description: Provider service causing the anomaly.
  - name: provider
    expr: stg_vantage__anomaly_alerts.provider
    semantic_role: categorical
    description: Cloud provider of the anomalous service.
  - name: amount
    expr: CAST(stg_vantage__anomaly_alerts.amount AS DOUBLE)
    semantic_role: measure
    tags:
      - financial
    description: Observed cost amount.
  - name: previous_amount
    expr: CAST(stg_vantage__anomaly_alerts.previous_amount AS DOUBLE)
    semantic_role: measure
    tags:
      - financial
    description: Previous observed cost amount.
  - name: seven_day_average
    expr: CAST(stg_vantage__anomaly_alerts.seven_day_average AS DOUBLE)
    semantic_role: measure
    tags:
      - financial
    description: Seven-day average of the observed amount.
  - name: status
    expr: stg_vantage__anomaly_alerts.status
    semantic_role: categorical
    description: Anomaly alert status.
  - name: cost_report_token
    expr: stg_vantage__anomaly_alerts.cost_report_token
    semantic_role: entity_id
    description: Cost report associated with the alert.
  - name: alerted_at
    expr: stg_vantage__anomaly_alerts.alerted_at
    semantic_role: event_timestamp
    description: Timestamp when the alert was sent.
  - name: created_at
    expr: stg_vantage__anomaly_alerts.created_at
    semantic_role: event_timestamp
    description: Timestamp when the anomaly alert was created.
tags:
  - vantage
  - anomalies
  - costs
trust_tier: gold
materialization:
  type: table

### vantage\_\_budgets

spec_version: '0.2'
name: vantage__budgets
type: model
description: Budget detail records with cost report and workspace association.
grain: budget_id
source:
  ref: stg_vantage__budgets
columns:
  - name: budget_id
    expr: stg_vantage__budgets.token
    primary_key: true
    semantic_role: entity_id
    description: Unique budget identifier.
  - name: name
    expr: stg_vantage__budgets.name
    semantic_role: categorical
    description: Budget name.
  - name: workspace_token
    expr: stg_vantage__budgets.workspace_token
    semantic_role: entity_id
    description: Workspace the budget belongs to.
  - name: cost_report_token
    expr: stg_vantage__budgets.cost_report_token
    semantic_role: entity_id
    description: Cost report associated with the budget.
  - name: user_token
    expr: stg_vantage__budgets.user_token
    semantic_role: entity_id
    description: User who created the budget.
  - name: created_at
    expr: stg_vantage__budgets.created_at
    semantic_role: event_timestamp
    description: Timestamp when the budget was created.
tags:
  - vantage
  - budgets
  - costs
trust_tier: gold
materialization:
  type: table

### vantage\_\_cost_report_summary

spec_version: '0.2'
name: vantage__cost_report_summary
type: model
description: Cost report metadata enriched with aggregated spend and row counts.
grain: token
source:
  ref: stg_vantage__cost_reports
joins:
  - ref: stg_vantage__costs
    type: left
    on: stg_vantage__cost_reports.token = stg_vantage__costs.cost_report_token
    pre_aggregate:
      group_by:
        - cost_report_token
      columns:
        - name: cost_row_count
          expr: COUNT(*)
        - name: total_amount
          expr: SUM(CAST(amount AS DOUBLE))
        - name: first_cost_date
          expr: MIN(accrued_at)
        - name: last_cost_date
          expr: MAX(accrued_at)
columns:
  - name: token
    expr: stg_vantage__cost_reports.token
    primary_key: true
    semantic_role: entity_id
    description: Unique Vantage cost report token.
  - name: title
    expr: stg_vantage__cost_reports.title
    semantic_role: categorical
    description: Title of the cost report.
  - name: date_interval
    expr: stg_vantage__cost_reports.date_interval
    semantic_role: categorical
    description: Configured report date interval.
  - name: date_bin
    expr: stg_vantage__cost_reports.date_bin
    semantic_role: categorical
    description: Configured date bin for the report.
  - name: workspace_token
    expr: stg_vantage__cost_reports.workspace_token
    semantic_role: entity_id
    description: Workspace owning the cost report.
  - name: cost_row_count
    expr: COALESCE(stg_vantage__costs.cost_row_count, 0)
    semantic_role: measure
    description: Number of cost rows associated with the report.
  - name: total_amount
    expr: COALESCE(stg_vantage__costs.total_amount, 0)
    semantic_role: measure
    tags:
      - financial
    description: Total spend associated with the report.
  - name: first_cost_date
    expr: stg_vantage__costs.first_cost_date
    semantic_role: time_dimension
    description: First cost accrual timestamp observed for the report.
  - name: last_cost_date
    expr: stg_vantage__costs.last_cost_date
    semantic_role: time_dimension
    description: Last cost accrual timestamp observed for the report.
tags:
  - vantage
  - cost-reports
trust_tier: gold
materialization:
  type: table

### vantage\_\_costs

spec_version: '0.2'
name: vantage__costs
type: model
description: Detailed Vantage cloud cost observations by report, provider account, service, and accrual time.
grain:
  - cost_report_token
  - accrued_at
  - provider
  - account_id
  - service
source:
  ref: stg_vantage__costs
columns:
  - name: cost_report_token
    expr: stg_vantage__costs.cost_report_token
    semantic_role: entity_id
    references: stg_vantage__cost_reports.token
    description: Cost report token that produced the cost row.
  - name: accrued_at
    expr: stg_vantage__costs.accrued_at
    semantic_role: time_dimension
    description: Timestamp when the cost accrued.
  - name: provider
    expr: stg_vantage__costs.provider
    semantic_role: categorical
    description: Cloud or SaaS provider that incurred the cost.
  - name: account_id
    expr: stg_vantage__costs.account_id
    semantic_role: entity_id
    description: Provider account that incurred the cost.
  - name: service
    expr: stg_vantage__costs.service
    semantic_role: categorical
    description: Provider service that incurred the cost.
  - name: currency
    expr: stg_vantage__costs.currency
    semantic_role: categorical
    description: Currency of the cost amount.
  - name: amount
    expr: CAST(stg_vantage__costs.amount AS DOUBLE)
    semantic_role: measure
    tags:
      - financial
    description: Cloud spend amount for the row.
tags:
  - vantage
  - costs
trust_tier: gold
materialization:
  type: table

### vantage\_\_daily_costs

spec_version: '0.2'
name: vantage__daily_costs
type: model
description: Daily cloud spend summarized within each cost report, provider, and currency.
grain:
  - cost_report_token
  - date
  - provider
  - currency
source:
  ref: stg_vantage__costs
columns:
  - name: cost_report_token
    expr: stg_vantage__costs.cost_report_token
    semantic_role: entity_id
    description: Cost report that produced the spend bucket.
  - name: date
    expr: CAST(stg_vantage__costs.accrued_at AS DATE)
    semantic_role: time_dimension
    description: Date associated with the cost bucket.
  - name: provider
    expr: stg_vantage__costs.provider
    semantic_role: categorical
    description: Cloud or SaaS provider for the spend bucket.
  - name: currency
    expr: stg_vantage__costs.currency
    semantic_role: categorical
    description: Currency of the spend bucket.
  - name: row_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of cost rows in the bucket.
  - name: total_amount
    expr: SUM(CAST(stg_vantage__costs.amount AS DOUBLE))
    semantic_role: measure
    tags:
      - financial
    description: Total spend in the bucket.
group_by:
  - cost_report_token
  - date
  - provider
  - currency
tags:
  - vantage
  - costs
  - daily
trust_tier: gold
materialization:
  type: table

### vantage\_\_provider_footprint

spec_version: '0.2'
name: vantage__provider_footprint
type: model
description: Provider-account coverage summary grouped by connected provider type.
grain: provider
source:
  ref: stg_vantage__cost_provider_accounts
columns:
  - name: provider
    expr: stg_vantage__cost_provider_accounts.provider
    semantic_role: categorical
    description: Cloud or SaaS provider type.
  - name: account_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of connected accounts for the provider.
group_by:
  - provider
tags:
  - vantage
  - providers
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: vantage_cost_report_total_cost
description: Total cloud cost within a Vantage cost report. Filter or group by cost report and currency to avoid combining overlapping reports or currencies.
model: vantage__daily_costs
expression: SUM({vantage__daily_costs}.total_amount)
synonyms: [cost report spend, report cloud cost, cost report total]
tags: [vantage, cloud, finance]
spec_version: '0.2'
type: metric
name: vantage_anomaly_alert_count
description: Number of Vantage anomaly alerts.
model: vantage__anomaly_alerts
expression: COUNT({vantage__anomaly_alerts}.anomaly_alert_id)
synonyms: [cost anomalies, anomaly alerts, spend alerts]
tags: [vantage, cloud, anomalies]
spec_version: '0.2'
type: metric
name: vantage_budget_count
description: Number of Vantage budgets.
model: vantage__budgets
expression: COUNT({vantage__budgets}.budget_id)
synonyms: [budgets, cloud budgets, budget count]
tags: [vantage, cloud, budgets]

## Relationships

spec_version: '0.2'
type: relationship
name: vantage_costs_to_cost_reports
description: Each Vantage cost row belongs to one cost report.
left_model: vantage__costs
right_model: vantage__cost_report_summary
join_columns:
  - left: cost_report_token
    right: token
join_type: left
relationship_type: many_to_one
tags: [vantage, costs, reports]
spec_version: '0.2'
type: relationship
name: vantage_anomaly_alerts_to_cost_reports
description: Each Vantage anomaly alert can belong to one cost report.
left_model: vantage__anomaly_alerts
right_model: vantage__cost_report_summary
join_columns:
  - left: cost_report_token
    right: token
join_type: left
relationship_type: many_to_one
tags: [vantage, anomalies, reports]
