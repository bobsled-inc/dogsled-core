---
name: starter-models-vantage
description: Curated starter analytics models, metrics, and relationships for Vantage cloud cost observability. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - vantage starter models
  - prebuilt vantage models
  - curated vantage analytics models
  - standard vantage data models
  - build vantage marts
  - Vantage analytics shape
  - models for vantage
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

{{include: packages/models/marts/vantage/vantage__anomaly_alerts.yml}}

### vantage\_\_budgets

{{include: packages/models/marts/vantage/vantage__budgets.yml}}

### vantage\_\_cost_report_summary

{{include: packages/models/marts/vantage/vantage__cost_report_summary.yml}}

### vantage\_\_costs

{{include: packages/models/marts/vantage/vantage__costs.yml}}

### vantage\_\_daily_costs

{{include: packages/models/marts/vantage/vantage__daily_costs.yml}}

### vantage\_\_provider_footprint

{{include: packages/models/marts/vantage/vantage__provider_footprint.yml}}

## Metrics

{{include: packages/models/marts/vantage/metrics/vantage_cost_report_total_cost.yml}}
{{include: packages/models/marts/vantage/metrics/vantage_anomaly_alert_count.yml}}
{{include: packages/models/marts/vantage/metrics/vantage_budget_count.yml}}

## Relationships

{{include: packages/models/marts/vantage/relationships/vantage_costs_to_cost_reports.yml}}
{{include: packages/models/marts/vantage/relationships/vantage_anomaly_alerts_to_cost_reports.yml}}
