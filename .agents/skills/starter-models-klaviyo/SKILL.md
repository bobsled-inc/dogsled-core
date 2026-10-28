---
name: starter-models-klaviyo
description: Curated starter analytics models, metrics, and relationships for Klaviyo marketing. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - klaviyo starter models
  - prebuilt klaviyo models
  - curated klaviyo analytics models
  - standard klaviyo data models
  - build klaviyo marts
  - Klaviyo analytics shape
  - models for klaviyo
---

# Starter data models — Klaviyo

Email and SMS marketing analytics models for Klaviyo campaigns, flows, profiles, and events.

These are the **gold marts** for Klaviyo — the canonical analytics
tables an analyst would build on top of the loaded Klaviyo extract. Each
mart references a silver staging model named `stg_klaviyo__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### klaviyo\_\_campaign_performance_summary

{{include: packages/models/marts/klaviyo/klaviyo__campaign_performance_summary.yml}}

### klaviyo\_\_campaigns

{{include: packages/models/marts/klaviyo/klaviyo__campaigns.yml}}

### klaviyo\_\_events

{{include: packages/models/marts/klaviyo/klaviyo__events.yml}}

### klaviyo\_\_flows

{{include: packages/models/marts/klaviyo/klaviyo__flows.yml}}

### klaviyo\_\_profiles

{{include: packages/models/marts/klaviyo/klaviyo__profiles.yml}}

## Metrics

{{include: packages/models/marts/klaviyo/metrics/klaviyo_event_count.yml}}
{{include: packages/models/marts/klaviyo/metrics/klaviyo_campaign_count.yml}}
{{include: packages/models/marts/klaviyo/metrics/klaviyo_profile_count.yml}}

## Relationships

{{include: packages/models/marts/klaviyo/relationships/klaviyo_events_to_profiles.yml}}
