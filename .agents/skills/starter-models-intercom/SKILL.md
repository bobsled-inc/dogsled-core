---
name: starter-models-intercom
description: Curated starter analytics models, metrics, and relationships for Intercom support and engagement. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - intercom starter models
  - prebuilt intercom models
  - curated intercom analytics models
  - standard intercom data models
  - build intercom marts
  - Intercom analytics shape
  - models for intercom
---

# Starter data models — Intercom

Customer support and engagement analytics models for Intercom contacts, conversations, and admins.

These are the **gold marts** for Intercom — the canonical analytics
tables an analyst would build on top of the loaded Intercom extract. Each
mart references a silver staging model named `stg_intercom__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### intercom\_\_admins

{{include: packages/models/marts/intercom/intercom__admins.yml}}

### intercom\_\_contacts

{{include: packages/models/marts/intercom/intercom__contacts.yml}}

### intercom\_\_conversation_volume_summary

{{include: packages/models/marts/intercom/intercom__conversation_volume_summary.yml}}

### intercom\_\_conversations

{{include: packages/models/marts/intercom/intercom__conversations.yml}}

## Metrics

{{include: packages/models/marts/intercom/metrics/intercom_conversation_count.yml}}
{{include: packages/models/marts/intercom/metrics/intercom_open_conversation_count.yml}}
{{include: packages/models/marts/intercom/metrics/intercom_priority_conversation_count.yml}}

## Relationships

{{include: packages/models/marts/intercom/relationships/intercom_conversations_to_admins.yml}}
{{include: packages/models/marts/intercom/relationships/intercom_contacts_to_admins.yml}}
