---
name: starter-models-gong
description: Curated starter analytics models, metrics, and relationships for Gong revenue intelligence. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - gong starter models
  - prebuilt gong models
  - curated gong analytics models
  - standard gong data models
  - build gong marts
  - Gong analytics shape
  - models for gong
---

# Starter data models — Gong

Revenue intelligence analytics models for Gong calls, meetings, and users.

These are the **gold marts** for Gong — the canonical analytics
tables an analyst would build on top of the loaded Gong extract. Each
mart references a silver staging model named `stg_gong__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### gong\_\_call_activity_summary

{{include: packages/models/marts/gong/gong__call_activity_summary.yml}}

### gong\_\_calls

{{include: packages/models/marts/gong/gong__calls.yml}}

### gong\_\_meetings

{{include: packages/models/marts/gong/gong__meetings.yml}}

### gong\_\_users

{{include: packages/models/marts/gong/gong__users.yml}}

## Metrics

{{include: packages/models/marts/gong/metrics/gong_call_count.yml}}
{{include: packages/models/marts/gong/metrics/gong_total_call_duration.yml}}
{{include: packages/models/marts/gong/metrics/gong_meeting_count.yml}}

## Relationships

{{include: packages/models/marts/gong/relationships/gong_calls_to_users.yml}}
{{include: packages/models/marts/gong/relationships/gong_meetings_to_users.yml}}
