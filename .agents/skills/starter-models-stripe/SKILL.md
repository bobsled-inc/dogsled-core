---
name: starter-models-stripe
description: Curated starter analytics models, metrics, and relationships for Stripe. Billing and payment semantics for Stripe customers, charges, invoices, refunds, and subscriptions. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - stripe starter models
  - prebuilt stripe models
  - curated stripe analytics models
  - standard stripe data models
  - build stripe marts
  - Stripe analytics shape
  - models for stripe
---

# Starter data models — Stripe

Billing and payment analytics models for Stripe customers, charges, invoices, and subscriptions.

This bundle contains the **gold marts, metrics, and relationships** for
Stripe—the canonical analytics layer an analyst would build on top of the loaded Stripe extract. Each
mart references a silver staging model named `stg_stripe__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
trim columns whose staging field is absent, and remove metadata that references
pruned models. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### stripe\_\_balance_transactions

{{include: packages/models/marts/stripe/stripe__balance_transactions.yml}}

### stripe\_\_charges

{{include: packages/models/marts/stripe/stripe__charges.yml}}

### stripe\_\_customer_lifetime_value

{{include: packages/models/marts/stripe/stripe__customer_lifetime_value.yml}}

### stripe\_\_customer_overview

{{include: packages/models/marts/stripe/stripe__customer_overview.yml}}

### stripe\_\_daily_overview

{{include: packages/models/marts/stripe/stripe__daily_overview.yml}}

### stripe\_\_dispute_impact

{{include: packages/models/marts/stripe/stripe__dispute_impact.yml}}

### stripe\_\_invoice_details

{{include: packages/models/marts/stripe/stripe__invoice_details.yml}}

### stripe\_\_payment_intents

{{include: packages/models/marts/stripe/stripe__payment_intents.yml}}

### stripe\_\_refund_details

{{include: packages/models/marts/stripe/stripe__refund_details.yml}}

### stripe\_\_subscription_details

{{include: packages/models/marts/stripe/stripe__subscription_details.yml}}

### stripe\_\_subscription_status_summary

{{include: packages/models/marts/stripe/stripe__subscription_status_summary.yml}}

## Metrics

{{include: packages/models/marts/stripe/metrics/stripe_total_charge_amount.yml}}

{{include: packages/models/marts/stripe/metrics/stripe_paid_charge_count.yml}}

{{include: packages/models/marts/stripe/metrics/stripe_total_refunded_amount.yml}}

{{include: packages/models/marts/stripe/metrics/stripe_active_subscription_count.yml}}

## Relationships

{{include: packages/models/marts/stripe/relationships/stripe_charges_to_customers.yml}}

{{include: packages/models/marts/stripe/relationships/stripe_invoices_to_customers.yml}}

{{include: packages/models/marts/stripe/relationships/stripe_subscriptions_to_customers.yml}}

{{include: packages/models/marts/stripe/relationships/stripe_refunds_to_charges.yml}}
