---
name: starter-models-smartlead
description: Curated starter analytics models, metrics, and relationships for Smartlead outbound sales. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - smartlead starter models
  - prebuilt smartlead models
  - curated smartlead analytics models
  - standard smartlead data models
  - build smartlead marts
  - Smartlead analytics shape
  - models for smartlead
---

# Starter data models — Smartlead

Outbound sales models for Smartlead campaigns, lead execution, and sender account capacity.

These are the **gold marts** for Smartlead — the canonical analytics
tables an analyst would build on top of the loaded Smartlead extract. Each
mart references a silver staging model named `stg_smartlead__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### smartlead\_\_campaign_lead_funnel

{{include: packages/models/marts/smartlead/smartlead__campaign_lead_funnel.yml}}

### smartlead\_\_campaign_leads

{{include: packages/models/marts/smartlead/smartlead__campaign_leads.yml}}

### smartlead\_\_campaign_statistics

{{include: packages/models/marts/smartlead/smartlead__campaign_statistics.yml}}

### smartlead\_\_campaigns

{{include: packages/models/marts/smartlead/smartlead__campaigns.yml}}

### smartlead\_\_email_account_capacity

{{include: packages/models/marts/smartlead/smartlead__email_account_capacity.yml}}

### smartlead\_\_email_account_performance

{{include: packages/models/marts/smartlead/smartlead__email_account_performance.yml}}

### smartlead\_\_email_accounts

{{include: packages/models/marts/smartlead/smartlead__email_accounts.yml}}

### smartlead\_\_lead_status_summary

{{include: packages/models/marts/smartlead/smartlead__lead_status_summary.yml}}

## Metrics

{{include: packages/models/marts/smartlead/metrics/smartlead_campaign_lead_count.yml}}
{{include: packages/models/marts/smartlead/metrics/smartlead_opened_sequence_count.yml}}
{{include: packages/models/marts/smartlead/metrics/smartlead_replied_sequence_count.yml}}

## Relationships

{{include: packages/models/marts/smartlead/relationships/smartlead_email_account_performance_to_accounts.yml}}
{{include: packages/models/marts/smartlead/relationships/smartlead_campaign_leads_to_status_summary.yml}}
