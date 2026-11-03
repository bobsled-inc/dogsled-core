---
name: starter-models-chargebee
description: Curated starter analytics models, metrics, and relationships for
  Chargebee subscription billing. Pairs with the starter-data-models overview;
  adapt the bundle to the user's actually-loaded tables.
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

spec_version: '0.2'
name: chargebee__customers
type: model
description: Chargebee customers with curated fields extracted from the API payload.
grain: customer_id
source:
  ref: stg_chargebee__list_customers
columns:
  - name: customer_id
    expr: stg_chargebee__list_customers.customer_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Chargebee customer identifier.
  - name: customer_email
    expr: json_value(stg_chargebee__list_customers.customer, 'email')
    semantic_role: categorical
    tags:
      - pii
    description: Customer email address.
  - name: company
    expr: json_value(stg_chargebee__list_customers.customer, 'company')
    semantic_role: categorical
    description: Company name stored for the customer.
  - name: auto_collection
    expr: json_value(stg_chargebee__list_customers.customer, 'auto_collection')
    semantic_role: categorical
    description: Auto-collection setting for the customer.
  - name: net_term_days
    expr: CAST(NULLIF(json_value(stg_chargebee__list_customers.customer, 'net_term_days'), '') AS BIGINT)
    semantic_role: measure
    description: Customer net payment terms in days.
  - name: created_at
    expr: TO_TIMESTAMP(CAST(NULLIF(json_value(stg_chargebee__list_customers.customer, 'created_at'), '') AS BIGINT))
    semantic_role: event_timestamp
    description: Timestamp when the customer was created.
tags:
  - chargebee
  - customers
  - billing
trust_tier: gold
materialization:
  type: table

### chargebee\_\_invoices

spec_version: '0.2'
name: chargebee__invoices
type: model
description: Chargebee invoices enriched with customer context and normalized amounts.
grain: invoice_id
source:
  ref: stg_chargebee__list_invoices
joins:
  - ref: stg_chargebee__list_customers
    type: left
    on: json_value(stg_chargebee__list_invoices.invoice, 'customer_id') = stg_chargebee__list_customers.customer_id
columns:
  - name: invoice_id
    expr: stg_chargebee__list_invoices.invoice_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Chargebee invoice identifier.
  - name: customer_id
    expr: json_value(stg_chargebee__list_invoices.invoice, 'customer_id')
    semantic_role: entity_id
    references: stg_chargebee__list_customers.customer_id
    description: Customer tied to the invoice.
  - name: customer_email
    expr: json_value(stg_chargebee__list_customers.customer, 'email')
    semantic_role: categorical
    tags:
      - pii
    description: Customer email from the related Chargebee customer record.
  - name: subscription_id
    expr: json_value(stg_chargebee__list_invoices.invoice, 'subscription_id')
    semantic_role: entity_id
    description: Subscription tied to the invoice when present.
  - name: invoice_status
    expr: json_value(stg_chargebee__list_invoices.invoice, 'status')
    semantic_role: categorical
    description: Current invoice status.
  - name: currency_code
    expr: json_value(stg_chargebee__list_invoices.invoice, 'currency_code')
    semantic_role: categorical
    description: Currency used for the invoice.
  - name: total_amount
    expr: COALESCE(CAST(NULLIF(json_value(stg_chargebee__list_invoices.invoice, 'total'), '') AS NUMERIC(16, 2)) / 100.0, 0)
    semantic_role: measure
    tags:
      - financial
    description: Invoice total normalized into standard currency units.
  - name: amount_paid
    expr: COALESCE(CAST(NULLIF(json_value(stg_chargebee__list_invoices.invoice, 'amount_paid'), '') AS NUMERIC(16, 2)) / 100.0, 0)
    semantic_role: measure
    tags:
      - financial
    description: Amount paid against the invoice in standard currency units.
  - name: amount_due
    expr: COALESCE(CAST(NULLIF(json_value(stg_chargebee__list_invoices.invoice, 'amount_due'), '') AS NUMERIC(16, 2)) / 100.0, 0)
    semantic_role: measure
    tags:
      - financial
    description: Amount still due on the invoice in standard currency units.
  - name: invoice_date
    expr: TO_TIMESTAMP(CAST(NULLIF(json_value(stg_chargebee__list_invoices.invoice, 'date'), '') AS BIGINT))
    semantic_role: event_timestamp
    description: Invoice issue timestamp.
  - name: paid_at
    expr: TO_TIMESTAMP(CAST(NULLIF(json_value(stg_chargebee__list_invoices.invoice, 'paid_at'), '') AS BIGINT))
    semantic_role: event_timestamp
    description: Timestamp when the invoice was paid.
tags:
  - chargebee
  - invoices
  - billing
trust_tier: gold
materialization:
  type: table

### chargebee\_\_subscription_status_summary

spec_version: '0.2'
name: chargebee__subscription_status_summary
type: model
description: Chargebee subscription counts and MRR summarized by status and currency.
grain:
  - subscription_status
  - currency_code
source:
  ref: stg_chargebee__list_subscriptions
columns:
  - name: subscription_status
    expr: json_value(stg_chargebee__list_subscriptions.subscription, 'status')
    semantic_role: categorical
    description: Chargebee subscription status.
  - name: currency_code
    expr: json_value(stg_chargebee__list_subscriptions.subscription, 'currency_code')
    semantic_role: categorical
    description: Currency used by subscriptions in the bucket.
  - name: subscription_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of subscriptions in the bucket.
  - name: distinct_customer_count
    expr: count_distinct(COALESCE(json_value(stg_chargebee__list_subscriptions.subscription, 'customer_id'), json_value(stg_chargebee__list_subscriptions.customer, 'id')))
    semantic_role: measure
    description: Number of distinct customers represented in the bucket.
  - name: total_mrr
    expr: SUM(COALESCE(CAST(NULLIF(json_value(stg_chargebee__list_subscriptions.subscription, 'mrr'), '') AS NUMERIC(16, 2)) / 100.0, 0))
    semantic_role: measure
    tags:
      - financial
    description: Total monthly recurring revenue in the bucket, normalized into standard currency units.
group_by:
  - subscription_status
  - currency_code
tags:
  - chargebee
  - subscriptions
  - summary
trust_tier: gold
materialization:
  type: table

### chargebee\_\_subscriptions

spec_version: '0.2'
name: chargebee__subscriptions
type: model
description: Chargebee subscriptions with curated plan, billing, and customer context.
grain: subscription_id
source:
  ref: stg_chargebee__list_subscriptions
columns:
  - name: subscription_id
    expr: stg_chargebee__list_subscriptions.subscription_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Chargebee subscription identifier.
  - name: customer_id
    expr: COALESCE(json_value(stg_chargebee__list_subscriptions.subscription, 'customer_id'), json_value(stg_chargebee__list_subscriptions.customer, 'id'))
    semantic_role: entity_id
    references: stg_chargebee__list_customers.customer_id
    description: Customer tied to the subscription.
  - name: customer_email
    expr: json_value(stg_chargebee__list_subscriptions.customer, 'email')
    semantic_role: categorical
    tags:
      - pii
    description: Email address of the subscribed customer.
  - name: plan_id
    expr: json_value(stg_chargebee__list_subscriptions.subscription, 'plan_id')
    semantic_role: entity_id
    description: Plan identifier on the subscription.
  - name: subscription_status
    expr: json_value(stg_chargebee__list_subscriptions.subscription, 'status')
    semantic_role: categorical
    description: Current subscription status.
  - name: currency_code
    expr: json_value(stg_chargebee__list_subscriptions.subscription, 'currency_code')
    semantic_role: categorical
    description: Currency used for the subscription.
  - name: billing_period
    expr: CAST(NULLIF(json_value(stg_chargebee__list_subscriptions.subscription, 'billing_period'), '') AS BIGINT)
    semantic_role: measure
    description: Billing period count for the subscription.
  - name: billing_period_unit
    expr: json_value(stg_chargebee__list_subscriptions.subscription, 'billing_period_unit')
    semantic_role: categorical
    description: Billing period unit for the subscription.
  - name: mrr
    expr: COALESCE(CAST(NULLIF(json_value(stg_chargebee__list_subscriptions.subscription, 'mrr'), '') AS NUMERIC(16, 2)) / 100.0, 0)
    semantic_role: measure
    tags:
      - financial
    description: Monthly recurring revenue value normalized into standard currency units.
  - name: current_term_end_at
    expr: TO_TIMESTAMP(CAST(NULLIF(json_value(stg_chargebee__list_subscriptions.subscription, 'current_term_end'), '') AS BIGINT))
    semantic_role: event_timestamp
    description: Timestamp when the current billing term ends.
  - name: next_billing_at
    expr: TO_TIMESTAMP(CAST(NULLIF(json_value(stg_chargebee__list_subscriptions.subscription, 'next_billing_at'), '') AS BIGINT))
    semantic_role: event_timestamp
    description: Timestamp of the next scheduled billing event.
  - name: cancelled_at
    expr: TO_TIMESTAMP(CAST(NULLIF(json_value(stg_chargebee__list_subscriptions.subscription, 'cancelled_at'), '') AS BIGINT))
    semantic_role: event_timestamp
    description: Timestamp when the subscription was canceled.
  - name: created_at
    expr: TO_TIMESTAMP(CAST(NULLIF(json_value(stg_chargebee__list_subscriptions.subscription, 'created_at'), '') AS BIGINT))
    semantic_role: event_timestamp
    description: Timestamp when the subscription was created.
tags:
  - chargebee
  - subscriptions
  - billing
trust_tier: gold
materialization:
  type: table

### chargebee\_\_transactions

spec_version: '0.2'
name: chargebee__transactions
type: model
description: Chargebee transactions enriched with customer context and normalized amounts.
grain: transaction_id
source:
  ref: stg_chargebee__list_transactions
joins:
  - ref: stg_chargebee__list_customers
    type: left
    on: json_value(stg_chargebee__list_transactions.transaction, 'customer_id') = stg_chargebee__list_customers.customer_id
columns:
  - name: transaction_id
    expr: stg_chargebee__list_transactions.transaction_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Chargebee transaction identifier.
  - name: customer_id
    expr: json_value(stg_chargebee__list_transactions.transaction, 'customer_id')
    semantic_role: entity_id
    references: stg_chargebee__list_customers.customer_id
    description: Customer tied to the transaction.
  - name: customer_email
    expr: json_value(stg_chargebee__list_customers.customer, 'email')
    semantic_role: categorical
    tags:
      - pii
    description: Customer email from the related Chargebee customer record.
  - name: subscription_id
    expr: json_value(stg_chargebee__list_transactions.transaction, 'subscription_id')
    semantic_role: entity_id
    description: Subscription tied to the transaction when present.
  - name: transaction_status
    expr: json_value(stg_chargebee__list_transactions.transaction, 'status')
    semantic_role: categorical
    description: Current transaction status.
  - name: transaction_type
    expr: json_value(stg_chargebee__list_transactions.transaction, 'type')
    semantic_role: categorical
    description: Transaction type.
  - name: gateway
    expr: json_value(stg_chargebee__list_transactions.transaction, 'gateway')
    semantic_role: categorical
    description: Payment gateway used for the transaction.
  - name: payment_method
    expr: json_value(stg_chargebee__list_transactions.transaction, 'payment_method')
    semantic_role: categorical
    description: Payment method used for the transaction.
  - name: currency_code
    expr: json_value(stg_chargebee__list_transactions.transaction, 'currency_code')
    semantic_role: categorical
    description: Currency used for the transaction.
  - name: amount
    expr: COALESCE(CAST(NULLIF(json_value(stg_chargebee__list_transactions.transaction, 'amount'), '') AS NUMERIC(16, 2)) / 100.0, 0)
    semantic_role: measure
    tags:
      - financial
    description: Transaction amount normalized into standard currency units.
  - name: transaction_date
    expr: TO_TIMESTAMP(CAST(NULLIF(json_value(stg_chargebee__list_transactions.transaction, 'date'), '') AS BIGINT))
    semantic_role: event_timestamp
    description: Transaction timestamp.
tags:
  - chargebee
  - transactions
  - billing
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: chargebee_total_mrr
description: Monthly recurring revenue from active and non-renewing Chargebee subscriptions. Group results by currency before comparing or combining values.
model: chargebee__subscription_status_summary
expression: SUM(CASE WHEN {chargebee__subscription_status_summary}.subscription_status IN ('active', 'non_renewing') THEN {chargebee__subscription_status_summary}.total_mrr ELSE 0 END)
synonyms: [active subscription MRR, recurring subscription revenue, active and non-renewing MRR]
tags: [chargebee, subscriptions, finance]
spec_version: '0.2'
type: metric
name: chargebee_active_subscription_count
description: Number of Chargebee subscriptions with an active status.
model: chargebee__subscriptions
expression: SUM(CASE WHEN {chargebee__subscriptions}.subscription_status = 'active' THEN 1 ELSE 0 END)
synonyms: [active subscriptions, current subscriptions, live subscriptions]
tags: [chargebee, subscriptions, finance]
spec_version: '0.2'
type: metric
name: chargebee_successful_payment_amount
description: Total amount from successful Chargebee payment transactions. Group results by currency before comparing or combining values.
model: chargebee__transactions
expression: SUM(CASE WHEN {chargebee__transactions}.transaction_type = 'payment' AND {chargebee__transactions}.transaction_status = 'success' THEN {chargebee__transactions}.amount ELSE 0 END)
synonyms: [successful payment volume, collected payment amount, successful payments]
tags: [chargebee, payments, finance]

## Relationships

spec_version: '0.2'
type: relationship
name: chargebee_subscriptions_to_customers
description: Each Chargebee subscription belongs to one customer.
left_model: chargebee__subscriptions
right_model: chargebee__customers
join_columns:
  - left: customer_id
    right: customer_id
join_type: left
relationship_type: many_to_one
tags: [chargebee, subscriptions, customers]
spec_version: '0.2'
type: relationship
name: chargebee_invoices_to_customers
description: Each Chargebee invoice belongs to one customer.
left_model: chargebee__invoices
right_model: chargebee__customers
join_columns:
  - left: customer_id
    right: customer_id
join_type: left
relationship_type: many_to_one
tags: [chargebee, invoices, customers]
