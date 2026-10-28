# Model Bundle Authoring Patterns

Date: 2026-04-06

## Context

The `@bobsled-inc/models` bundle catalog includes integrations with generated staging names that need explicit mapping:

- prefixed resources such as `search_issues`, `get_deals`, and `list_subscriptions`
- object-heavy APIs such as Chargebee, where the extractor publishes top-level JSON objects instead of flattened scalar fields

Those two cases create most of the avoidable errors when authoring marts by hand.

## Pattern 1: Always author against the generated staging contract

`packages/models/src/normalizers.ts` and `packages/models/src/utils.ts` define the real staging names:

- staging models keep the full resource name: `stg_jira__search_issues`, `stg_pipedrive__get_deals`
- a resource-level `id` field becomes `<singularized_resource_name>_id`: `search_issue_id`, `get_deal_id`, `get_user_id`

Implication:

- never assume `issue_id`, `deal_id`, or `user_id` exists just because the upstream API entity is called an issue, deal, or user
- inspect the resource name and normalize mentally before writing joins or references
- keep mart-facing column names clean by aliasing those generated fields back to the business name in the curated mart (`issue_id`, `deal_id`, `organization_id`, etc.)

## Pattern 2: Use curated JSON extraction in marts instead of mutating the generator

For integrations like Chargebee, the extractor resources intentionally preserve nested API objects:

- `subscription`
- `customer`
- `invoice`
- `transaction`

The model compiler already supports `json_value(...)`, so the safest approach is:

1. leave source/staging generation mechanical
2. extract only stable, documented scalar fields in curated marts
3. normalize amount and timestamp fields inside the mart expressions

Examples:

- `json_value(stg_chargebee__list_subscriptions.subscription, 'status')`
- `COALESCE(CAST(NULLIF(json_value(..., 'mrr'), '') AS NUMERIC(16, 2)) / 100.0, 0)`
- `TO_TIMESTAMP(CAST(NULLIF(json_value(..., 'created_at'), '') AS BIGINT))`

This keeps the generator generic and makes JSON-backed assumptions explicit in the marts where they belong.

## Practical Rule

When adding a new bundle:

- start from the exact generated staging names, not the API entity names
- if a resource is object-shaped, prefer a thin curated mart over generator changes
- reserve generator changes for patterns that should apply to many integrations, not for one-off API quirks
