---
name: starter-models-salesforce
description: Curated starter analytics models, metrics, and relationships for Salesforce CRM and revenue. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - salesforce starter models
  - prebuilt salesforce models
  - curated salesforce analytics models
  - standard salesforce data models
  - build salesforce marts
  - Salesforce analytics shape
  - models for salesforce
---

# Starter data models — Salesforce

CRM and revenue analytics models for Salesforce accounts, pipeline, support, and campaign activity.

These are the **gold marts** for Salesforce — the canonical analytics
tables an analyst would build on top of the loaded Salesforce extract. Each
mart references a silver staging model named `stg_salesforce__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### salesforce\_\_accounts

{{include: packages/models/marts/salesforce/salesforce__accounts.yml}}

### salesforce\_\_campaign_members

{{include: packages/models/marts/salesforce/salesforce__campaign_members.yml}}

### salesforce\_\_cases

{{include: packages/models/marts/salesforce/salesforce__cases.yml}}

### salesforce\_\_contacts

{{include: packages/models/marts/salesforce/salesforce__contacts.yml}}

### salesforce\_\_opportunities

{{include: packages/models/marts/salesforce/salesforce__opportunities.yml}}

### salesforce\_\_opportunity_line_items

{{include: packages/models/marts/salesforce/salesforce__opportunity_line_items.yml}}

## Metrics

{{include: packages/models/marts/salesforce/metrics/salesforce_opportunity_count.yml}}
{{include: packages/models/marts/salesforce/metrics/salesforce_total_opportunity_amount.yml}}
{{include: packages/models/marts/salesforce/metrics/salesforce_open_case_count.yml}}

## Relationships

{{include: packages/models/marts/salesforce/relationships/salesforce_opportunities_to_accounts.yml}}
{{include: packages/models/marts/salesforce/relationships/salesforce_opportunity_line_items_to_opportunities.yml}}
