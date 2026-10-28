---
name: starter-models-chargebee
description: Curated starter analytics models, metrics, and relationships for Chargebee subscription billing. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - chargebee starter models
  - prebuilt chargebee models
  - curated chargebee analytics models
  - standard chargebee data models
  - build chargebee marts
  - Chargebee analytics shape
  - models for chargebee
---

# Starter data models — Chargebee

Subscription billing analytics models for Chargebee customers, subscriptions, invoices, and transactions.

These are the **gold marts** for Chargebee — the canonical analytics
tables an analyst would build on top of the loaded Chargebee extract. Each
mart references a silver staging model named `stg_chargebee__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### chargebee\_\_customers

{{include: packages/models/marts/chargebee/chargebee__customers.yml}}

### chargebee\_\_invoices

{{include: packages/models/marts/chargebee/chargebee__invoices.yml}}

### chargebee\_\_subscription_status_summary

{{include: packages/models/marts/chargebee/chargebee__subscription_status_summary.yml}}

### chargebee\_\_subscriptions

{{include: packages/models/marts/chargebee/chargebee__subscriptions.yml}}

### chargebee\_\_transactions

{{include: packages/models/marts/chargebee/chargebee__transactions.yml}}

## Metrics

{{include: packages/models/marts/chargebee/metrics/chargebee_total_mrr.yml}}
{{include: packages/models/marts/chargebee/metrics/chargebee_active_subscription_count.yml}}
{{include: packages/models/marts/chargebee/metrics/chargebee_successful_payment_amount.yml}}

## Relationships

{{include: packages/models/marts/chargebee/relationships/chargebee_subscriptions_to_customers.yml}}
{{include: packages/models/marts/chargebee/relationships/chargebee_invoices_to_customers.yml}}
