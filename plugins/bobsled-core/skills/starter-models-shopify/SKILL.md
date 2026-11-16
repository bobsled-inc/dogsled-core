---
name: starter-models-shopify
description: Curated starter analytics models, metrics, and relationships for
  Shopify commerce. Pairs with the starter-data-models overview; adapt the
  bundle to the user's actually-loaded tables.
---

# Starter data models — Shopify

Commerce models for Shopify customers, orders, product catalog, and inventory.

These are the **gold marts** for Shopify — the canonical analytics
tables an analyst would build on top of the loaded Shopify extract. Each
mart references a silver staging model named `stg_shopify__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### shopify\_\_catalog_summary

spec_version: '0.2'
name: shopify__catalog_summary
type: model
description: Product-level catalog summary with variant counts, inventory, and average sell price.
grain: product_id
source:
  ref: stg_shopify__products
joins:
  - ref: stg_shopify__product_variants
    type: left
    on: stg_shopify__products.product_id = stg_shopify__product_variants.product_id
    pre_aggregate:
      group_by:
        - product_id
      columns:
        - name: variant_count
          expr: COUNT(*)
        - name: total_inventory_quantity
          expr: SUM(inventory_quantity)
        - name: avg_variant_price
          expr: AVG(price)
columns:
  - name: product_id
    expr: stg_shopify__products.product_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Shopify product identifier.
  - name: title
    expr: stg_shopify__products.title
    semantic_role: categorical
    description: Product title.
  - name: vendor
    expr: stg_shopify__products.vendor
    semantic_role: categorical
    description: Vendor associated with the product.
  - name: product_type
    expr: stg_shopify__products.product_type
    semantic_role: categorical
    description: Merchant-defined product type.
  - name: status
    expr: stg_shopify__products.status
    semantic_role: categorical
    description: Current product status.
  - name: variant_count
    expr: COALESCE(stg_shopify__product_variants.variant_count, 0)
    semantic_role: measure
    description: Number of variants defined for the product.
  - name: total_inventory_quantity
    expr: COALESCE(stg_shopify__product_variants.total_inventory_quantity, 0)
    semantic_role: measure
    description: Sum of variant inventory quantities for the product.
  - name: avg_variant_price
    expr: stg_shopify__product_variants.avg_variant_price
    semantic_role: measure
    tags:
      - financial
    description: Average configured sell price across variants.
tags:
  - shopify
  - catalog
trust_tier: gold
materialization:
  type: table

### shopify\_\_customers

spec_version: '0.2'
name: shopify__customers
type: model
description: Shopify customers enriched with observed order activity by email address.
grain: customer_id
source:
  ref: stg_shopify__customers
joins:
  - ref: stg_shopify__orders
    type: left
    on: stg_shopify__customers.email = stg_shopify__orders.email
    pre_aggregate:
      group_by:
        - email
      columns:
        - name: order_count
          expr: COUNT(*)
        - name: first_order_at
          expr: MIN(created_at)
        - name: most_recent_order_at
          expr: MAX(created_at)
columns:
  - name: customer_id
    expr: stg_shopify__customers.customer_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Shopify customer identifier.
  - name: email
    expr: stg_shopify__customers.email
    semantic_role: categorical
    tags:
      - pii
    description: Customer email address.
  - name: first_name
    expr: stg_shopify__customers.first_name
    semantic_role: categorical
    tags:
      - pii
    description: Customer first name.
  - name: last_name
    expr: stg_shopify__customers.last_name
    semantic_role: categorical
    tags:
      - pii
    description: Customer last name.
  - name: order_count
    expr: COALESCE(stg_shopify__orders.order_count, 0)
    semantic_role: measure
    description: Observed order count for the customer email address.
  - name: first_order_at
    expr: stg_shopify__orders.first_order_at
    semantic_role: event_timestamp
    description: First order timestamp observed for the customer email.
  - name: most_recent_order_at
    expr: stg_shopify__orders.most_recent_order_at
    semantic_role: event_timestamp
    description: Most recent order timestamp observed for the customer email.
  - name: created_at
    expr: stg_shopify__customers.created_at
    semantic_role: event_timestamp
    description: Timestamp when the customer record was created.
tags:
  - shopify
  - customers
trust_tier: gold
materialization:
  type: table

### shopify\_\_daily_orders

spec_version: '0.2'
name: shopify__daily_orders
type: model
description: Daily Shopify order counts grouped by financial and fulfillment status.
grain:
  - order_day
  - financial_status
  - fulfillment_status
source:
  ref: stg_shopify__orders
columns:
  - name: order_day
    expr: date_trunc('day', stg_shopify__orders.created_at)
    semantic_role: time_dimension
    description: Calendar day when the order was created.
  - name: financial_status
    expr: stg_shopify__orders.financial_status
    semantic_role: categorical
    description: Financial status bucket.
  - name: fulfillment_status
    expr: stg_shopify__orders.fulfillment_status
    semantic_role: categorical
    description: Fulfillment status bucket.
  - name: order_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of Shopify orders in the bucket.
group_by:
  - order_day
  - financial_status
  - fulfillment_status
tags:
  - shopify
  - daily
trust_tier: gold
materialization:
  type: table

### shopify\_\_fulfillments

spec_version: '0.2'
name: shopify__fulfillments
type: model
description: Fulfillment events joined back to their source orders.
grain: fulfillment_id
source:
  ref: stg_shopify__fulfillments
joins:
  - ref: stg_shopify__orders
    type: left
    on: stg_shopify__fulfillments.order_id = stg_shopify__orders.order_id
columns:
  - name: fulfillment_id
    expr: stg_shopify__fulfillments.fulfillment_id
    primary_key: true
    semantic_role: entity_id
    description: Unique fulfillment identifier.
  - name: order_id
    expr: stg_shopify__fulfillments.order_id
    semantic_role: entity_id
    references: stg_shopify__orders.order_id
    description: Associated Shopify order identifier.
  - name: order_name
    expr: stg_shopify__orders.name
    semantic_role: categorical
    description: Human-readable order name.
  - name: email
    expr: stg_shopify__orders.email
    semantic_role: categorical
    tags:
      - pii
    description: Customer email attached to the fulfilled order.
  - name: status
    expr: stg_shopify__fulfillments.status
    semantic_role: categorical
    description: Fulfillment processing status.
  - name: tracking_company
    expr: stg_shopify__fulfillments.tracking_company
    semantic_role: categorical
    description: Shipping carrier handling the fulfillment.
  - name: tracking_number
    expr: stg_shopify__fulfillments.tracking_number
    semantic_role: categorical
    description: Shipment tracking number.
  - name: created_at
    expr: stg_shopify__fulfillments.created_at
    semantic_role: event_timestamp
    description: Timestamp when the fulfillment was created.
tags:
  - shopify
  - fulfillment
trust_tier: gold
materialization:
  type: table

### shopify\_\_inventory_levels

spec_version: '0.2'
name: shopify__inventory_levels
type: model
description: Inventory position by item and location with item and location metadata.
grain:
  - inventory_item_id
  - location_id
source:
  ref: stg_shopify__inventory_levels
joins:
  - ref: stg_shopify__inventory_items
    type: left
    on: stg_shopify__inventory_levels.inventory_item_id = stg_shopify__inventory_items.inventory_item_id
  - ref: stg_shopify__locations
    type: left
    on: stg_shopify__inventory_levels.location_id = stg_shopify__locations.location_id
columns:
  - name: inventory_item_id
    expr: stg_shopify__inventory_levels.inventory_item_id
    semantic_role: entity_id
    references: stg_shopify__inventory_items.inventory_item_id
    description: Inventory item identifier.
    not_null: true
    primary_key: true
  - name: location_id
    expr: stg_shopify__inventory_levels.location_id
    semantic_role: entity_id
    references: stg_shopify__locations.location_id
    description: Location identifier.
    not_null: true
    primary_key: true
  - name: location_name
    expr: stg_shopify__locations.name
    semantic_role: categorical
    description: Location name.
  - name: sku
    expr: stg_shopify__inventory_items.sku
    semantic_role: categorical
    description: SKU for the inventory item.
  - name: tracked
    expr: stg_shopify__inventory_items.tracked
    semantic_role: categorical
    description: Whether inventory tracking is enabled for the item.
  - name: cost
    expr: stg_shopify__inventory_items.cost
    semantic_role: measure
    tags:
      - financial
    description: Unit cost of the inventory item.
  - name: available
    expr: stg_shopify__inventory_levels.available
    semantic_role: measure
    description: Available quantity at the location.
  - name: updated_at
    expr: stg_shopify__inventory_levels.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the inventory level was last updated.
tags:
  - shopify
  - inventory
trust_tier: gold
tests:
  - type: custom
    sql: SELECT inventory_item_id, location_id, COUNT(*) AS duplicate_count FROM {name} GROUP BY inventory_item_id, location_id HAVING COUNT(*) > 1
materialization:
  type: table

### shopify\_\_orders

spec_version: '0.2'
name: shopify__orders
type: model
description: Normalized Shopify orders at one row per order.
grain: order_id
source:
  ref: stg_shopify__orders
columns:
  - name: order_id
    expr: stg_shopify__orders.order_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Shopify order identifier.
  - name: order_name
    expr: stg_shopify__orders.name
    semantic_role: categorical
    description: Human-readable Shopify order name.
  - name: email
    expr: stg_shopify__orders.email
    semantic_role: categorical
    tags:
      - pii
    description: Customer email captured on the order.
  - name: financial_status
    expr: stg_shopify__orders.financial_status
    semantic_role: categorical
    description: Financial processing state of the order.
  - name: fulfillment_status
    expr: stg_shopify__orders.fulfillment_status
    semantic_role: categorical
    description: Fulfillment state of the order.
  - name: created_at
    expr: stg_shopify__orders.created_at
    semantic_role: event_timestamp
    description: Timestamp when the order was created.
  - name: updated_at
    expr: stg_shopify__orders.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the order was last updated.
tags:
  - shopify
  - orders
trust_tier: gold
materialization:
  type: table

### shopify\_\_product_variants

spec_version: '0.2'
name: shopify__product_variants
type: model
description: Variant-level Shopify catalog detail with product enrichment.
grain: product_variant_id
source:
  ref: stg_shopify__product_variants
joins:
  - ref: stg_shopify__products
    type: left
    on: stg_shopify__product_variants.product_id = stg_shopify__products.product_id
columns:
  - name: product_variant_id
    expr: stg_shopify__product_variants.product_variant_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Shopify variant identifier.
  - name: product_id
    expr: stg_shopify__product_variants.product_id
    semantic_role: entity_id
    references: stg_shopify__products.product_id
    description: Parent product identifier.
  - name: product_title
    expr: stg_shopify__products.title
    semantic_role: categorical
    description: Title of the parent product.
  - name: vendor
    expr: stg_shopify__products.vendor
    semantic_role: categorical
    description: Vendor of the parent product.
  - name: title
    expr: stg_shopify__product_variants.title
    semantic_role: categorical
    description: Variant title.
  - name: sku
    expr: stg_shopify__product_variants.sku
    semantic_role: categorical
    description: Stock keeping unit for the variant.
  - name: price
    expr: stg_shopify__product_variants.price
    semantic_role: measure
    tags:
      - financial
    description: Current selling price of the variant.
  - name: compare_at_price
    expr: stg_shopify__product_variants.compare_at_price
    semantic_role: measure
    tags:
      - financial
    description: Reference price used to show markdowns.
  - name: inventory_quantity
    expr: stg_shopify__product_variants.inventory_quantity
    semantic_role: measure
    description: Available inventory quantity for the variant.
  - name: weight
    expr: stg_shopify__product_variants.weight
    semantic_role: measure
    description: Weight of the variant.
  - name: weight_unit
    expr: stg_shopify__product_variants.weight_unit
    semantic_role: categorical
    description: Unit of measure for the variant weight.
tags:
  - shopify
  - catalog
  - variants
trust_tier: gold
materialization:
  type: table

### shopify\_\_products

spec_version: '0.2'
name: shopify__products
type: model
description: Product catalog detail for Shopify products.
grain: product_id
source:
  ref: stg_shopify__products
columns:
  - name: product_id
    expr: stg_shopify__products.product_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Shopify product identifier.
  - name: title
    expr: stg_shopify__products.title
    semantic_role: categorical
    description: Product title shown in the Shopify catalog.
  - name: vendor
    expr: stg_shopify__products.vendor
    semantic_role: categorical
    description: Vendor associated with the product.
  - name: product_type
    expr: stg_shopify__products.product_type
    semantic_role: categorical
    description: Merchant-defined product type.
  - name: status
    expr: stg_shopify__products.status
    semantic_role: categorical
    description: Current status of the product.
  - name: created_at
    expr: stg_shopify__products.created_at
    semantic_role: event_timestamp
    description: Timestamp when the product was created.
  - name: updated_at
    expr: stg_shopify__products.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the product was last updated.
tags:
  - shopify
  - catalog
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: shopify_order_count
description: Number of Shopify orders.
model: shopify__orders
expression: COUNT({shopify__orders}.order_id)
synonyms: [orders, order volume, number of orders]
tags: [shopify, commerce, orders]
spec_version: '0.2'
type: metric
name: shopify_product_count
description: Number of Shopify products.
model: shopify__products
expression: COUNT({shopify__products}.product_id)
synonyms: [products, catalog size, product count]
tags: [shopify, commerce, catalog]
spec_version: '0.2'
type: metric
name: shopify_inventory_quantity
description: Total available Shopify inventory across inventory items and locations.
model: shopify__inventory_levels
expression: SUM({shopify__inventory_levels}.available)
synonyms: [available inventory, units in stock, inventory quantity]
tags: [shopify, commerce, inventory]

## Relationships

spec_version: '0.2'
type: relationship
name: shopify_product_variants_to_products
description: Each Shopify product variant belongs to one product.
left_model: shopify__product_variants
right_model: shopify__products
join_columns:
  - left: product_id
    right: product_id
join_type: left
relationship_type: many_to_one
tags: [shopify, variants, products]
spec_version: '0.2'
type: relationship
name: shopify_fulfillments_to_orders
description: Each Shopify fulfillment belongs to one order.
left_model: shopify__fulfillments
right_model: shopify__orders
join_columns:
  - left: order_id
    right: order_id
join_type: left
relationship_type: many_to_one
tags: [shopify, fulfillments, orders]
