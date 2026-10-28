---
name: starter-models-pipedrive
description: Curated starter analytics models, metrics, and relationships for Pipedrive CRM. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - pipedrive starter models
  - prebuilt pipedrive models
  - curated pipedrive analytics models
  - standard pipedrive data models
  - build pipedrive marts
  - Pipedrive analytics shape
  - models for pipedrive
---

# Starter data models — Pipedrive

SMB CRM analytics models for Pipedrive deals, contacts, organizations, activities, and pipeline flow.

These are the **gold marts** for Pipedrive — the canonical analytics
tables an analyst would build on top of the loaded Pipedrive extract. Each
mart references a silver staging model named `stg_pipedrive__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### pipedrive\_\_activities

{{include: packages/models/marts/pipedrive/pipedrive__activities.yml}}

### pipedrive\_\_deals

{{include: packages/models/marts/pipedrive/pipedrive__deals.yml}}

### pipedrive\_\_organizations

{{include: packages/models/marts/pipedrive/pipedrive__organizations.yml}}

### pipedrive\_\_persons

{{include: packages/models/marts/pipedrive/pipedrive__persons.yml}}

### pipedrive\_\_pipeline_summary

{{include: packages/models/marts/pipedrive/pipedrive__pipeline_summary.yml}}

## Metrics

{{include: packages/models/marts/pipedrive/metrics/pipedrive_deal_count.yml}}
{{include: packages/models/marts/pipedrive/metrics/pipedrive_total_deal_value.yml}}
{{include: packages/models/marts/pipedrive/metrics/pipedrive_completed_activity_count.yml}}

## Relationships

{{include: packages/models/marts/pipedrive/relationships/pipedrive_activities_to_deals.yml}}
{{include: packages/models/marts/pipedrive/relationships/pipedrive_deals_to_organizations.yml}}
