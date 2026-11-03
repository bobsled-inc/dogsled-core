---
name: starter-models-notion
description: Curated starter analytics models, metrics, and relationships for
  Notion content and collaboration. Pairs with the starter-data-models overview;
  adapt the bundle to the user's actually-loaded tables.
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

spec_version: '0.2'
name: notion__database_items
type: model
description: Database item detail with creator context for Notion structured data.
grain: database_item_id
source:
  ref: stg_notion__database_items
joins:
  - ref: stg_notion__users
    type: left
    on: stg_notion__database_items.created_by_id = stg_notion__users.user_id
columns:
  - name: database_item_id
    expr: stg_notion__database_items.database_item_id
    primary_key: true
    semantic_role: entity_id
    description: Unique database item identifier.
  - name: parent_database_id
    expr: stg_notion__database_items.parent_database_id
    semantic_role: entity_id
    description: Identifier of the parent database.
  - name: creator_name
    expr: stg_notion__users.name
    semantic_role: categorical
    description: Name of the user who created the item.
  - name: created_time
    expr: stg_notion__database_items.created_time
    semantic_role: event_timestamp
    description: Timestamp when the item was created.
  - name: last_edited_time
    expr: stg_notion__database_items.last_edited_time
    semantic_role: event_timestamp
    description: Timestamp when the item was last edited.
  - name: archived
    expr: stg_notion__database_items.archived
    semantic_role: categorical
    description: Whether the database item is archived.
  - name: url
    expr: stg_notion__database_items.url
    semantic_role: categorical
    description: URL to the database item in Notion.
tags:
  - notion
  - collaboration
  - database_items
trust_tier: gold
materialization:
  type: table

### notion\_\_page_activity_summary

spec_version: '0.2'
name: notion__page_activity_summary
type: model
description: Page counts by parent type and archive status for Notion workspace activity overview.
grain:
  - parent_type
  - is_archived
source:
  ref: stg_notion__pages
columns:
  - name: parent_type
    expr: stg_notion__pages.parent_type
    primary_key: true
    semantic_role: categorical
    description: Type of parent object (workspace, page, or database).
  - name: is_archived
    expr: stg_notion__pages.archived
    primary_key: true
    semantic_role: categorical
    description: Whether the pages in this bucket are archived.
  - name: page_count
    expr: COUNT(*)
    semantic_role: measure
    description: Total number of pages in the parent type and archive status bucket.
  - name: most_recent_created_time
    expr: MAX(stg_notion__pages.created_time)
    semantic_role: event_timestamp
    description: Most recent page creation timestamp in the bucket.
  - name: most_recent_edited_time
    expr: MAX(stg_notion__pages.last_edited_time)
    semantic_role: event_timestamp
    description: Most recent page edit timestamp in the bucket.
group_by:
  - parent_type
  - is_archived
tags:
  - notion
  - collaboration
  - pages
trust_tier: gold
materialization:
  type: table

### notion\_\_pages

spec_version: '0.2'
name: notion__pages
type: model
description: Page detail with creator context for Notion workspace content.
grain: page_id
source:
  ref: stg_notion__pages
joins:
  - ref: stg_notion__users
    type: left
    on: stg_notion__pages.created_by_id = stg_notion__users.user_id
columns:
  - name: page_id
    expr: stg_notion__pages.page_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Notion page identifier.
  - name: creator_name
    expr: stg_notion__users.name
    semantic_role: categorical
    description: Name of the user who created the page.
  - name: created_time
    expr: stg_notion__pages.created_time
    semantic_role: event_timestamp
    description: Timestamp when the page was created.
  - name: last_edited_time
    expr: stg_notion__pages.last_edited_time
    semantic_role: event_timestamp
    description: Timestamp when the page was last edited.
  - name: parent_type
    expr: stg_notion__pages.parent_type
    semantic_role: categorical
    description: Type of parent object (workspace, page, or database).
  - name: archived
    expr: stg_notion__pages.archived
    semantic_role: categorical
    description: Whether the page is archived.
  - name: url
    expr: stg_notion__pages.url
    semantic_role: categorical
    description: URL to the page in Notion.
tags:
  - notion
  - collaboration
  - pages
trust_tier: gold
materialization:
  type: table

### notion\_\_users

spec_version: '0.2'
name: notion__users
type: model
description: User detail with page creation rollups for Notion workspace members.
grain: user_id
source:
  ref: stg_notion__users
joins:
  - ref: stg_notion__pages
    type: left
    on: stg_notion__users.user_id = stg_notion__pages.created_by_id
    pre_aggregate:
      group_by:
        - created_by_id
      columns:
        - name: page_count
          expr: COUNT(*)
        - name: most_recent_page_at
          expr: MAX(created_time)
columns:
  - name: user_id
    expr: stg_notion__users.user_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Notion user identifier.
  - name: name
    expr: stg_notion__users.name
    semantic_role: categorical
    description: Display name of the user.
  - name: type
    expr: stg_notion__users.type
    semantic_role: categorical
    description: User type (person or bot).
  - name: email
    expr: stg_notion__users.email
    semantic_role: categorical
    tags:
      - pii
    description: Email address of the user.
  - name: page_count
    expr: COALESCE(stg_notion__pages.page_count, 0)
    semantic_role: measure
    description: Number of pages created by the user.
  - name: most_recent_page_at
    expr: stg_notion__pages.most_recent_page_at
    semantic_role: event_timestamp
    description: Timestamp of the most recent page created by the user.
tags:
  - notion
  - collaboration
  - users
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: notion_page_count
description: Number of Notion pages.
model: notion__pages
expression: COUNT({notion__pages}.page_id)
synonyms: [pages, page count, workspace pages]
tags: [notion, content, collaboration]
spec_version: '0.2'
type: metric
name: notion_archived_page_count
description: Number of archived Notion pages.
model: notion__pages
expression: SUM(CASE WHEN {notion__pages}.archived THEN 1 ELSE 0 END)
synonyms: [archived pages, deleted pages, inactive pages]
tags: [notion, content, collaboration]
spec_version: '0.2'
type: metric
name: notion_database_item_count
description: Number of Notion database items.
model: notion__database_items
expression: COUNT({notion__database_items}.database_item_id)
synonyms: [database items, database rows, Notion records]
tags: [notion, content, databases]

## Relationships

spec_version: '0.2'
type: relationship
name: notion_database_items_to_pages
description: Each Notion database item corresponds to one page.
left_model: notion__database_items
right_model: notion__pages
join_columns:
  - left: database_item_id
    right: page_id
join_type: left
relationship_type: one_to_one
tags: [notion, databases, pages]
spec_version: '0.2'
type: relationship
name: notion_pages_to_activity_summary
description: Each Notion page contributes to one parent and archive-state activity summary.
left_model: notion__pages
right_model: notion__page_activity_summary
join_columns:
  - left: parent_type
    right: parent_type
  - left: archived
    right: is_archived
join_type: left
relationship_type: many_to_one
tags: [notion, pages, activity]
