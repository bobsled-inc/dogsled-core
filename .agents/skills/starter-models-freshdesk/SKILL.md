---
name: starter-models-freshdesk
description: Curated starter analytics models, metrics, and relationships for Freshdesk support operations. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - freshdesk starter models
  - prebuilt freshdesk models
  - curated freshdesk analytics models
  - standard freshdesk data models
  - build freshdesk marts
  - Freshdesk analytics shape
  - models for freshdesk
---

# Starter data models — Freshdesk

Support analytics models for Freshdesk tickets, contacts, agents, companies, and conversation activity.

These are the **gold marts** for Freshdesk — the canonical analytics
tables an analyst would build on top of the loaded Freshdesk extract. Each
mart references a silver staging model named `stg_freshdesk__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### freshdesk\_\_agents

{{include: packages/models/marts/freshdesk/freshdesk__agents.yml}}

### freshdesk\_\_companies

{{include: packages/models/marts/freshdesk/freshdesk__companies.yml}}

### freshdesk\_\_contacts

{{include: packages/models/marts/freshdesk/freshdesk__contacts.yml}}

### freshdesk\_\_conversations

{{include: packages/models/marts/freshdesk/freshdesk__conversations.yml}}

### freshdesk\_\_ticket_volume_summary

{{include: packages/models/marts/freshdesk/freshdesk__ticket_volume_summary.yml}}

### freshdesk\_\_tickets

{{include: packages/models/marts/freshdesk/freshdesk__tickets.yml}}

## Metrics

{{include: packages/models/marts/freshdesk/metrics/freshdesk_ticket_count.yml}}
{{include: packages/models/marts/freshdesk/metrics/freshdesk_conversation_count.yml}}
{{include: packages/models/marts/freshdesk/metrics/freshdesk_active_contact_count.yml}}

## Relationships

{{include: packages/models/marts/freshdesk/relationships/freshdesk_contacts_to_companies.yml}}
{{include: packages/models/marts/freshdesk/relationships/freshdesk_tickets_to_companies.yml}}
