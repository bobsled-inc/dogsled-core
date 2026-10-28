---
name: starter-models-shopify
description: Curated starter analytics models, metrics, and relationships for Shopify commerce. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - shopify starter models
  - prebuilt shopify models
  - curated shopify analytics models
  - standard shopify data models
  - build shopify marts
  - Shopify analytics shape
  - models for shopify
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

{{include: packages/models/marts/shopify/shopify__catalog_summary.yml}}

### shopify\_\_customers

{{include: packages/models/marts/shopify/shopify__customers.yml}}

### shopify\_\_daily_orders

{{include: packages/models/marts/shopify/shopify__daily_orders.yml}}

### shopify\_\_fulfillments

{{include: packages/models/marts/shopify/shopify__fulfillments.yml}}

### shopify\_\_inventory_levels

{{include: packages/models/marts/shopify/shopify__inventory_levels.yml}}

### shopify\_\_orders

{{include: packages/models/marts/shopify/shopify__orders.yml}}

### shopify\_\_product_variants

{{include: packages/models/marts/shopify/shopify__product_variants.yml}}

### shopify\_\_products

{{include: packages/models/marts/shopify/shopify__products.yml}}

## Metrics

{{include: packages/models/marts/shopify/metrics/shopify_order_count.yml}}
{{include: packages/models/marts/shopify/metrics/shopify_product_count.yml}}
{{include: packages/models/marts/shopify/metrics/shopify_inventory_quantity.yml}}

## Relationships

{{include: packages/models/marts/shopify/relationships/shopify_product_variants_to_products.yml}}
{{include: packages/models/marts/shopify/relationships/shopify_fulfillments_to_orders.yml}}
