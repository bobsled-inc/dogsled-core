---
name: starter-models-notion
description: Curated starter analytics models, metrics, and relationships for Notion content and collaboration. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - notion starter models
  - prebuilt notion models
  - curated notion analytics models
  - standard notion data models
  - build notion marts
  - Notion analytics shape
  - models for notion
---

# Starter data models — Notion

Workspace content and collaboration analytics models for Notion pages, database items, and users.

These are the **gold marts** for Notion — the canonical analytics
tables an analyst would build on top of the loaded Notion extract. Each
mart references a silver staging model named `stg_notion__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

> **Notion blocks carry text under a type-discriminated key**
> (`paragraph.rich_text`, `heading_1.rich_text`, `code.rich_text`, …). When you
> author the bronze source for a block-extraction resource, use the
> "type-discriminated nested payloads" recipe in the `add-custom-api-integration`
> skill — the ordered `output.<field>.paths` fallback collapses every block
> variant into one `text` column, so the silver staging model doesn't need a
> hand-written COALESCE over ~30 per-type columns.

## Marts

### notion\_\_database_items

{{include: packages/models/marts/notion/notion__database_items.yml}}

### notion\_\_page_activity_summary

{{include: packages/models/marts/notion/notion__page_activity_summary.yml}}

### notion\_\_pages

{{include: packages/models/marts/notion/notion__pages.yml}}

### notion\_\_users

{{include: packages/models/marts/notion/notion__users.yml}}

## Metrics

{{include: packages/models/marts/notion/metrics/notion_page_count.yml}}
{{include: packages/models/marts/notion/metrics/notion_archived_page_count.yml}}
{{include: packages/models/marts/notion/metrics/notion_database_item_count.yml}}

## Relationships

{{include: packages/models/marts/notion/relationships/notion_database_items_to_pages.yml}}
{{include: packages/models/marts/notion/relationships/notion_pages_to_activity_summary.yml}}
