---
name: starter-models-zendesk
description: Curated starter analytics models, metrics, and relationships for Zendesk support operations. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - zendesk starter models
  - prebuilt zendesk models
  - curated zendesk analytics models
  - standard zendesk data models
  - build zendesk marts
  - Zendesk analytics shape
  - models for zendesk
---

# Starter data models — Zendesk

Support analytics models for Zendesk tickets, agents, organizations, and ticket volume.

These are the **gold marts** for Zendesk — the canonical analytics
tables an analyst would build on top of the loaded Zendesk extract. Each
mart references a silver staging model named `stg_zendesk__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### zendesk\_\_organizations

{{include: packages/models/marts/zendesk/zendesk__organizations.yml}}

### zendesk\_\_ticket_volume_summary

{{include: packages/models/marts/zendesk/zendesk__ticket_volume_summary.yml}}

### zendesk\_\_tickets

{{include: packages/models/marts/zendesk/zendesk__tickets.yml}}

### zendesk\_\_users

{{include: packages/models/marts/zendesk/zendesk__users.yml}}

## Metrics

{{include: packages/models/marts/zendesk/metrics/zendesk_ticket_count.yml}}
{{include: packages/models/marts/zendesk/metrics/zendesk_open_ticket_count.yml}}
{{include: packages/models/marts/zendesk/metrics/zendesk_high_priority_ticket_count.yml}}

## Relationships

{{include: packages/models/marts/zendesk/relationships/zendesk_tickets_to_organizations.yml}}
{{include: packages/models/marts/zendesk/relationships/zendesk_tickets_to_users.yml}}
