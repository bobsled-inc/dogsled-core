---
name: starter-models-hubspot
description: Curated starter analytics models, metrics, and relationships for HubSpot CRM and support. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - hubspot starter models
  - prebuilt hubspot models
  - curated hubspot analytics models
  - standard hubspot data models
  - build hubspot marts
  - HubSpot analytics shape
  - models for hubspot
---

# Starter data models — HubSpot

CRM and support analytics models for HubSpot contacts, companies, deals, tickets, and email engagements.

These are the **gold marts** for HubSpot — the canonical analytics
tables an analyst would build on top of the loaded HubSpot extract. Each
mart references a silver staging model named `stg_hubspot__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### hubspot\_\_companies

{{include: packages/models/marts/hubspot/hubspot__companies.yml}}

### hubspot\_\_contact_lifecycle_summary

{{include: packages/models/marts/hubspot/hubspot__contact_lifecycle_summary.yml}}

### hubspot\_\_contacts

{{include: packages/models/marts/hubspot/hubspot__contacts.yml}}

### hubspot\_\_deal_pipeline_summary

{{include: packages/models/marts/hubspot/hubspot__deal_pipeline_summary.yml}}

### hubspot\_\_deals

{{include: packages/models/marts/hubspot/hubspot__deals.yml}}

### hubspot\_\_emails

{{include: packages/models/marts/hubspot/hubspot__emails.yml}}

### hubspot\_\_owners

{{include: packages/models/marts/hubspot/hubspot__owners.yml}}

### hubspot\_\_tickets

{{include: packages/models/marts/hubspot/hubspot__tickets.yml}}

## Metrics

{{include: packages/models/marts/hubspot/metrics/hubspot_deal_count.yml}}
{{include: packages/models/marts/hubspot/metrics/hubspot_total_deal_amount.yml}}
{{include: packages/models/marts/hubspot/metrics/hubspot_ticket_count.yml}}

## Relationships

{{include: packages/models/marts/hubspot/relationships/hubspot_deals_to_owners.yml}}
{{include: packages/models/marts/hubspot/relationships/hubspot_companies_to_owners.yml}}
