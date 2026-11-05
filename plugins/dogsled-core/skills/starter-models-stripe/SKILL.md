---
name: starter-models-stripe
description: Curated starter analytics models, metrics, and relationships for
  Stripe. Billing and payment semantics for Stripe customers, charges, invoices,
  refunds, and subscriptions. Pairs with the starter-data-models overview; adapt
  the bundle to the user's actually-loaded tables.
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

spec_version: '0.2'
name: stripe__balance_transactions
type: model
description: Stripe balance ledger activity enriched with charge and refund context.
grain: balance_transaction_id
source:
  ref: stg_stripe__balance_transactions
joins:
  - ref: stg_stripe__refunds
    type: left
    on: stg_stripe__balance_transactions.source_id = stg_stripe__refunds.refund_id
  - ref: stg_stripe__charges
    type: left
    on: stg_stripe__balance_transactions.source_id = stg_stripe__charges.charge_id OR stg_stripe__refunds.charge_id = stg_stripe__charges.charge_id
  - ref: stg_stripe__customers
    type: left
    on: stg_stripe__charges.customer_id = stg_stripe__customers.customer_id
columns:
  - name: balance_transaction_id
    expr: stg_stripe__balance_transactions.balance_transaction_id
    primary_key: true
    semantic_role: entity_id
    description: Unique balance transaction identifier.
  - name: source_id
    expr: stg_stripe__balance_transactions.source_id
    semantic_role: entity_id
    description: Stripe object that generated the ledger entry.
  - name: charge_id
    expr: stg_stripe__charges.charge_id
    semantic_role: entity_id
    references: stg_stripe__charges.charge_id
    description: Charge that generated the ledger row when applicable.
  - name: refund_id
    expr: stg_stripe__refunds.refund_id
    semantic_role: entity_id
    references: stg_stripe__refunds.refund_id
    description: Refund that generated the ledger row when applicable.
  - name: customer_id
    expr: stg_stripe__charges.customer_id
    semantic_role: entity_id
    references: stg_stripe__customers.customer_id
    description: Customer resolved through the related charge, including refund-sourced ledger rows.
  - name: customer_email
    expr: stg_stripe__customers.email
    semantic_role: categorical
    tags:
      - pii
    description: Email of the customer resolved from the related charge.
  - name: reporting_category
    expr: stg_stripe__balance_transactions.reporting_category
    semantic_role: categorical
    description: Reporting category assigned by Stripe.
  - name: type
    expr: stg_stripe__balance_transactions.type
    semantic_role: categorical
    description: Underlying ledger transaction type.
  - name: status
    expr: stg_stripe__balance_transactions.status
    semantic_role: categorical
    description: Availability state of the balance transaction.
  - name: amount
    expr: stg_stripe__balance_transactions.amount
    semantic_role: measure
    tags:
      - financial
    description: Gross amount of the balance transaction.
  - name: fee
    expr: stg_stripe__balance_transactions.fee
    semantic_role: measure
    tags:
      - financial
    description: Fees deducted from the balance transaction.
  - name: net
    expr: stg_stripe__balance_transactions.net
    semantic_role: measure
    tags:
      - financial
    description: Net effect of the transaction after fees.
  - name: currency
    expr: stg_stripe__balance_transactions.currency
    semantic_role: categorical
    description: Currency of the ledger entry.
  - name: available_on
    expr: stg_stripe__balance_transactions.available_on
    semantic_role: time_dimension
    description: When funds become available for payout.
  - name: created_at
    expr: stg_stripe__balance_transactions.created_at
    semantic_role: event_timestamp
    description: Timestamp when the balance transaction was created.
tags:
  - stripe
  - billing
  - ledger
trust_tier: gold
materialization:
  type: table

### stripe\_\_charges

spec_version: '0.2'
name: stripe__charges
type: model
description: Enriched Stripe charges with customer and invoice context.
grain: charge_id
source:
  ref: stg_stripe__charges
joins:
  - ref: stg_stripe__customers
    type: left
    on: stg_stripe__charges.customer_id = stg_stripe__customers.customer_id
  - ref: stg_stripe__invoices
    type: left
    on: stg_stripe__charges.invoice_id = stg_stripe__invoices.invoice_id
columns:
  - name: charge_id
    expr: stg_stripe__charges.charge_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Stripe charge identifier.
  - name: customer_id
    expr: stg_stripe__charges.customer_id
    semantic_role: entity_id
    references: stg_stripe__customers.customer_id
    description: Customer associated with the charge.
  - name: customer_email
    expr: stg_stripe__customers.email
    semantic_role: categorical
    tags:
      - pii
    description: Email address of the charged customer.
  - name: invoice_id
    expr: stg_stripe__charges.invoice_id
    semantic_role: entity_id
    references: stg_stripe__invoices.invoice_id
    description: Invoice generated by the charge when present.
  - name: invoice_number
    expr: stg_stripe__invoices.number
    semantic_role: categorical
    description: Human-readable invoice number when the charge came from an invoice.
  - name: amount
    expr: stg_stripe__charges.amount
    semantic_role: measure
    tags:
      - financial
    description: Gross charge amount in standard currency units.
  - name: amount_captured
    expr: stg_stripe__charges.amount_captured
    semantic_role: measure
    tags:
      - financial
    description: Captured amount in standard currency units.
  - name: amount_refunded
    expr: stg_stripe__charges.amount_refunded
    semantic_role: measure
    tags:
      - financial
    description: Refunded amount tied to the charge in standard currency units.
  - name: currency
    expr: stg_stripe__charges.currency
    semantic_role: categorical
    description: ISO currency code used for the charge.
  - name: status
    expr: stg_stripe__charges.status
    semantic_role: categorical
    description: Processing state of the charge.
  - name: paid
    expr: stg_stripe__charges.paid
    semantic_role: categorical
    description: Whether the charge has been paid successfully.
  - name: refunded
    expr: stg_stripe__charges.refunded
    semantic_role: categorical
    description: Whether the charge has been fully refunded.
  - name: captured
    expr: stg_stripe__charges.captured
    semantic_role: categorical
    description: Whether the charge has been captured.
  - name: failure_code
    expr: stg_stripe__charges.failure_code
    semantic_role: categorical
    description: Error code attached to a failed charge.
  - name: created_at
    expr: stg_stripe__charges.created_at
    semantic_role: event_timestamp
    description: Timestamp when the charge was created.
tags:
  - stripe
  - billing
  - charges
trust_tier: gold
materialization:
  type: table

### stripe\_\_customer_lifetime_value

spec_version: '0.2'
name: stripe__customer_lifetime_value
type: model
description: Customer lifetime value from charge history — total revenue, order count, and average order value.
grain: customer_id
source:
  ref: stg_stripe__charges
columns:
  - name: customer_id
    expr: stg_stripe__charges.customer_id
    semantic_role: entity_id
    description: Stripe customer identifier.
  - name: total_amount
    expr: SUM(stg_stripe__charges.amount)
    semantic_role: measure
    tags:
      - financial
    description: Total charge amount across all charges in standard currency units.
  - name: charge_count
    expr: COUNT(*)
    semantic_role: measure
    description: Total number of charges for this customer.
  - name: avg_amount
    expr: AVG(stg_stripe__charges.amount)
    semantic_role: measure
    tags:
      - financial
    description: Average charge amount in standard currency units.
  - name: first_charge_at
    expr: MIN(stg_stripe__charges.created_at)
    semantic_role: event_timestamp
    description: Timestamp of the first charge.
  - name: last_charge_at
    expr: MAX(stg_stripe__charges.created_at)
    semantic_role: event_timestamp
    description: Timestamp of the most recent charge.
group_by:
  - customer_id
tags:
  - stripe
  - billing
  - customers
trust_tier: gold
materialization:
  type: table

### stripe\_\_customer_overview

spec_version: '0.2'
name: stripe__customer_overview
type: model
description: Customer-level Stripe payment performance and subscription health.
grain: customer_id
source:
  ref: stg_stripe__customers
joins:
  - ref: stg_stripe__charges
    type: left
    on: stg_stripe__customers.customer_id = stg_stripe__charges.customer_id
    pre_aggregate:
      group_by:
        - customer_id
      columns:
        - name: charge_count
          expr: COUNT(*)
        - name: total_charge_amount
          expr: SUM(amount)
        - name: total_refunded_amount
          expr: SUM(amount_refunded)
        - name: most_recent_charge_at
          expr: MAX(created_at)
  - ref: stg_stripe__subscriptions
    type: left
    on: stg_stripe__customers.customer_id = stg_stripe__subscriptions.customer_id
    pre_aggregate:
      group_by:
        - customer_id
      columns:
        - name: active_subscription_count
          expr: SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)
        - name: trialing_subscription_count
          expr: SUM(CASE WHEN status = 'trialing' THEN 1 ELSE 0 END)
columns:
  - name: customer_id
    expr: stg_stripe__customers.customer_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Stripe customer identifier.
  - name: email
    expr: stg_stripe__customers.email
    semantic_role: categorical
    tags:
      - pii
    description: Customer email address.
  - name: currency
    expr: stg_stripe__customers.currency
    semantic_role: categorical
    description: Default currency configured for the customer.
  - name: delinquent
    expr: stg_stripe__customers.delinquent
    semantic_role: categorical
    description: Whether the customer currently has unpaid invoices.
  - name: balance
    expr: stg_stripe__customers.balance
    semantic_role: measure
    tags:
      - financial
    description: Outstanding customer balance in standard currency units.
  - name: charge_count
    expr: COALESCE(stg_stripe__charges.charge_count, 0)
    semantic_role: measure
    description: Total number of charges associated with the customer.
  - name: total_charge_amount
    expr: COALESCE(stg_stripe__charges.total_charge_amount, 0)
    semantic_role: measure
    tags:
      - financial
    description: Lifetime gross charge volume for the customer.
  - name: total_refunded_amount
    expr: COALESCE(stg_stripe__charges.total_refunded_amount, 0)
    semantic_role: measure
    tags:
      - financial
    description: Lifetime refunded volume associated with the customer.
  - name: active_subscription_count
    expr: COALESCE(stg_stripe__subscriptions.active_subscription_count, 0)
    semantic_role: measure
    description: Count of currently active subscriptions for the customer.
  - name: trialing_subscription_count
    expr: COALESCE(stg_stripe__subscriptions.trialing_subscription_count, 0)
    semantic_role: measure
    description: Count of subscriptions that are presently in trial.
  - name: most_recent_charge_at
    expr: stg_stripe__charges.most_recent_charge_at
    semantic_role: event_timestamp
    description: Timestamp of the customer’s most recent charge.
  - name: created_at
    expr: stg_stripe__customers.created_at
    semantic_role: event_timestamp
    description: Timestamp when the Stripe customer record was created.
tags:
  - stripe
  - billing
  - customers
trust_tier: gold
materialization:
  type: table

### stripe\_\_daily_overview

spec_version: '0.2'
name: stripe__daily_overview
type: model
description: Daily Stripe charge activity by currency and charge status.
grain:
  - charge_day
  - currency
  - status
source:
  ref: stg_stripe__charges
columns:
  - name: charge_day
    expr: date_trunc('day', stg_stripe__charges.created_at)
    semantic_role: time_dimension
    description: Calendar day when the charge was created.
  - name: currency
    expr: stg_stripe__charges.currency
    semantic_role: categorical
    description: Currency used by the charges in the group.
  - name: status
    expr: stg_stripe__charges.status
    semantic_role: categorical
    description: Charge processing status.
  - name: charge_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of charges created for the day and status.
  - name: paid_charge_count
    expr: SUM(CASE WHEN stg_stripe__charges.paid THEN 1 ELSE 0 END)
    semantic_role: measure
    description: Count of successfully paid charges.
  - name: total_charge_amount
    expr: SUM(stg_stripe__charges.amount)
    semantic_role: measure
    tags:
      - financial
    description: Total charged volume for the day and status.
  - name: total_refunded_amount
    expr: SUM(stg_stripe__charges.amount_refunded)
    semantic_role: measure
    tags:
      - financial
    description: Total refunded amount associated with charges in the group.
group_by:
  - charge_day
  - currency
  - status
tags:
  - stripe
  - billing
  - daily
trust_tier: gold
materialization:
  type: table

### stripe\_\_dispute_impact

spec_version: '0.2'
name: stripe__dispute_impact
type: model
description: Chargeback and dispute analysis grouped by reason.
grain: reason
source:
  ref: stg_stripe__disputes
columns:
  - name: reason
    expr: stg_stripe__disputes.reason
    semantic_role: categorical
    description: Dispute reason category (duplicate, fraudulent, subscription_canceled, etc.).
  - name: dispute_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of disputes for this reason.
  - name: total_amount
    expr: SUM(stg_stripe__disputes.amount)
    semantic_role: measure
    tags:
      - financial
    description: Total disputed amount in standard currency units.
group_by:
  - reason
tags:
  - stripe
  - billing
  - disputes
trust_tier: gold
materialization:
  type: table

### stripe\_\_invoice_details

spec_version: '0.2'
name: stripe__invoice_details
type: model
description: Invoice facts with customer and subscription enrichment.
grain: invoice_id
source:
  ref: stg_stripe__invoices
joins:
  - ref: stg_stripe__customers
    type: left
    on: stg_stripe__invoices.customer_id = stg_stripe__customers.customer_id
  - ref: stg_stripe__subscriptions
    type: left
    on: stg_stripe__invoices.subscription_id = stg_stripe__subscriptions.subscription_id
columns:
  - name: invoice_id
    expr: stg_stripe__invoices.invoice_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Stripe invoice identifier.
  - name: invoice_number
    expr: stg_stripe__invoices.number
    semantic_role: categorical
    description: Human-readable invoice number.
  - name: customer_id
    expr: stg_stripe__invoices.customer_id
    semantic_role: entity_id
    references: stg_stripe__customers.customer_id
    description: Customer billed on the invoice.
  - name: customer_email
    expr: stg_stripe__customers.email
    semantic_role: categorical
    tags:
      - pii
    description: Email address of the invoiced customer.
  - name: subscription_id
    expr: stg_stripe__invoices.subscription_id
    semantic_role: entity_id
    references: stg_stripe__subscriptions.subscription_id
    description: Subscription that generated the invoice when present.
  - name: subscription_status
    expr: stg_stripe__subscriptions.status
    semantic_role: categorical
    description: Current subscription status at the time of analysis.
  - name: status
    expr: stg_stripe__invoices.status
    semantic_role: categorical
    description: Invoice state such as draft, open, paid, or void.
  - name: amount_due
    expr: stg_stripe__invoices.amount_due
    semantic_role: measure
    tags:
      - financial
    description: Total invoice amount due.
  - name: amount_paid
    expr: stg_stripe__invoices.amount_paid
    semantic_role: measure
    tags:
      - financial
    description: Amount already paid toward the invoice.
  - name: amount_remaining
    expr: stg_stripe__invoices.amount_remaining
    semantic_role: measure
    tags:
      - financial
    description: Remaining balance outstanding on the invoice.
  - name: total
    expr: stg_stripe__invoices.total
    semantic_role: measure
    tags:
      - financial
    description: Total invoice amount including tax.
  - name: subtotal
    expr: stg_stripe__invoices.subtotal
    semantic_role: measure
    tags:
      - financial
    description: Invoice subtotal before tax.
  - name: tax
    expr: stg_stripe__invoices.tax
    semantic_role: measure
    tags:
      - financial
    description: Tax amount applied to the invoice.
  - name: currency
    expr: stg_stripe__invoices.currency
    semantic_role: categorical
    description: Invoice currency code.
  - name: due_date
    expr: stg_stripe__invoices.due_date
    semantic_role: time_dimension
    description: Timestamp when payment for the invoice is due.
  - name: period_start
    expr: stg_stripe__invoices.period_start
    semantic_role: time_dimension
    description: Start of the billing period covered by the invoice.
  - name: period_end
    expr: stg_stripe__invoices.period_end
    semantic_role: time_dimension
    description: End of the billing period covered by the invoice.
  - name: created_at
    expr: stg_stripe__invoices.created_at
    semantic_role: event_timestamp
    description: Timestamp when the invoice was created.
tags:
  - stripe
  - billing
  - invoices
trust_tier: gold
materialization:
  type: table

### stripe\_\_payment_intents

spec_version: '0.2'
name: stripe__payment_intents
type: model
description: Payment intent records tracking the payment lifecycle from creation to completion.
grain: payment_intent_id
source:
  ref: stg_stripe__payment_intents
columns:
  - name: payment_intent_id
    expr: stg_stripe__payment_intents.payment_intent_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Stripe payment intent identifier.
  - name: amount
    expr: stg_stripe__payment_intents.amount
    semantic_role: measure
    tags:
      - financial
    description: Amount intended to collect in standard currency units.
  - name: amount_received
    expr: stg_stripe__payment_intents.amount_received
    semantic_role: measure
    tags:
      - financial
    description: Amount actually collected in standard currency units.
  - name: currency
    expr: stg_stripe__payment_intents.currency
    semantic_role: categorical
    description: ISO currency code.
  - name: status
    expr: stg_stripe__payment_intents.status
    semantic_role: categorical
    description: Payment lifecycle status (requires_payment_method, processing, succeeded, canceled, etc.).
  - name: customer_id
    expr: stg_stripe__payment_intents.customer_id
    semantic_role: entity_id
    references: stg_stripe__customers.customer_id
    description: Customer associated with this payment intent.
  - name: payment_method_id
    expr: stg_stripe__payment_intents.payment_method_id
    semantic_role: entity_id
    description: Payment method used for this intent.
  - name: capture_method
    expr: stg_stripe__payment_intents.capture_method
    semantic_role: categorical
    description: How funds are captured (automatic, manual).
  - name: latest_charge_id
    expr: stg_stripe__payment_intents.latest_charge_id
    semantic_role: entity_id
    description: Most recent charge created by this payment intent.
  - name: created_at
    expr: stg_stripe__payment_intents.created_at
    semantic_role: event_timestamp
    description: Timestamp when the payment intent was created.
tags:
  - stripe
  - billing
  - payments
trust_tier: gold
materialization:
  type: table

### stripe\_\_refund_details

spec_version: '0.2'
name: stripe__refund_details
type: model
description: Refund details enriched with their original charge and customer context.
grain: refund_id
source:
  ref: stg_stripe__refunds
joins:
  - ref: stg_stripe__charges
    type: left
    on: stg_stripe__refunds.charge_id = stg_stripe__charges.charge_id
  - ref: stg_stripe__customers
    type: left
    on: stg_stripe__charges.customer_id = stg_stripe__customers.customer_id
columns:
  - name: refund_id
    expr: stg_stripe__refunds.refund_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Stripe refund identifier.
  - name: charge_id
    expr: stg_stripe__refunds.charge_id
    semantic_role: entity_id
    references: stg_stripe__charges.charge_id
    description: Charge that the refund reverses.
  - name: customer_id
    expr: stg_stripe__charges.customer_id
    semantic_role: entity_id
    references: stg_stripe__customers.customer_id
    description: Customer tied to the refunded charge.
  - name: customer_email
    expr: stg_stripe__customers.email
    semantic_role: categorical
    tags:
      - pii
    description: Email address of the refunded customer.
  - name: payment_intent_id
    expr: stg_stripe__refunds.payment_intent_id
    semantic_role: entity_id
    description: Payment intent tied to the refunded charge.
  - name: reason
    expr: stg_stripe__refunds.reason
    semantic_role: categorical
    description: Stated reason for the refund.
  - name: status
    expr: stg_stripe__refunds.status
    semantic_role: categorical
    description: Current refund processing status.
  - name: amount
    expr: stg_stripe__refunds.amount
    semantic_role: measure
    tags:
      - financial
    description: Refund amount in standard currency units.
  - name: currency
    expr: stg_stripe__refunds.currency
    semantic_role: categorical
    description: Currency used for the refund.
  - name: balance_transaction_id
    expr: stg_stripe__refunds.balance_transaction_id
    semantic_role: entity_id
    references: stg_stripe__balance_transactions.balance_transaction_id
    description: Balance transaction representing the refund ledger impact.
  - name: created_at
    expr: stg_stripe__refunds.created_at
    semantic_role: event_timestamp
    description: Timestamp when the refund was created.
tags:
  - stripe
  - billing
  - refunds
trust_tier: gold
materialization:
  type: table

### stripe\_\_subscription_details

spec_version: '0.2'
name: stripe__subscription_details
type: model
description: Current subscription state with customer and invoice context.
grain: subscription_id
source:
  ref: stg_stripe__subscriptions
joins:
  - ref: stg_stripe__customers
    type: left
    on: stg_stripe__subscriptions.customer_id = stg_stripe__customers.customer_id
  - ref: stg_stripe__invoices
    type: left
    on: stg_stripe__subscriptions.latest_invoice_id = stg_stripe__invoices.invoice_id
columns:
  - name: subscription_id
    expr: stg_stripe__subscriptions.subscription_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Stripe subscription identifier.
  - name: customer_id
    expr: stg_stripe__subscriptions.customer_id
    semantic_role: entity_id
    references: stg_stripe__customers.customer_id
    description: Customer attached to the subscription.
  - name: customer_email
    expr: stg_stripe__customers.email
    semantic_role: categorical
    tags:
      - pii
    description: Email address of the subscribed customer.
  - name: status
    expr: stg_stripe__subscriptions.status
    semantic_role: categorical
    description: Subscription status such as active, trialing, or canceled.
  - name: collection_method
    expr: stg_stripe__subscriptions.collection_method
    semantic_role: categorical
    description: How Stripe attempts to collect payment for the subscription.
  - name: current_period_start
    expr: stg_stripe__subscriptions.current_period_start
    semantic_role: time_dimension
    description: Beginning of the active billing period.
  - name: current_period_end
    expr: stg_stripe__subscriptions.current_period_end
    semantic_role: time_dimension
    description: End of the active billing period.
  - name: trial_start
    expr: stg_stripe__subscriptions.trial_start
    semantic_role: time_dimension
    description: Timestamp when the subscription trial started.
  - name: trial_end
    expr: stg_stripe__subscriptions.trial_end
    semantic_role: time_dimension
    description: Timestamp when the trial period ends or ended.
  - name: cancel_at_period_end
    expr: stg_stripe__subscriptions.cancel_at_period_end
    semantic_role: categorical
    description: Whether the subscription will cancel at the end of the current term.
  - name: latest_invoice_id
    expr: stg_stripe__subscriptions.latest_invoice_id
    semantic_role: entity_id
    references: stg_stripe__invoices.invoice_id
    description: Most recent invoice generated for the subscription.
  - name: latest_invoice_status
    expr: stg_stripe__invoices.status
    semantic_role: categorical
    description: Status of the most recent invoice.
  - name: billing_cycle_anchor
    expr: stg_stripe__subscriptions.billing_cycle_anchor
    semantic_role: time_dimension
    description: Anchor date used for the recurring billing cycle.
  - name: created_at
    expr: stg_stripe__subscriptions.created_at
    semantic_role: event_timestamp
    description: Timestamp when the subscription was created.
tags:
  - stripe
  - billing
  - subscriptions
trust_tier: gold
materialization:
  type: table

### stripe\_\_subscription_status_summary

spec_version: '0.2'
name: stripe__subscription_status_summary
type: model
description: Subscription volume and billing timing summarized by subscription status and collection method.
grain:
  - status
  - collection_method
source:
  ref: stg_stripe__subscriptions
columns:
  - name: status
    expr: stg_stripe__subscriptions.status
    semantic_role: categorical
    description: Subscription lifecycle state.
  - name: collection_method
    expr: stg_stripe__subscriptions.collection_method
    semantic_role: categorical
    description: How Stripe collects payment for the subscription.
  - name: subscription_count
    expr: COUNT(*)
    semantic_role: measure
    description: Total subscriptions in the status and collection method bucket.
  - name: cancel_at_period_end_count
    expr: SUM(CASE WHEN stg_stripe__subscriptions.cancel_at_period_end THEN 1 ELSE 0 END)
    semantic_role: measure
    description: Count of subscriptions scheduled to cancel at period end.
  - name: latest_period_end
    expr: MAX(stg_stripe__subscriptions.current_period_end)
    semantic_role: measure
    description: Latest current-period end timestamp among subscriptions in the bucket.
group_by:
  - status
  - collection_method
tags:
  - stripe
  - billing
  - subscriptions
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: stripe_total_charge_amount
description: Total Stripe charge amount. Group results by currency before comparing or combining values.
model: stripe__daily_overview
expression: SUM({stripe__daily_overview}.total_charge_amount)
synonyms:
  - charge volume
  - gross charge amount
  - total charges
tags:
  - stripe
  - billing
  - finance

spec_version: '0.2'
type: metric
name: stripe_paid_charge_count
description: Number of Stripe charges marked as paid.
model: stripe__daily_overview
expression: SUM({stripe__daily_overview}.paid_charge_count)
synonyms:
  - paid charges
  - successful charges
  - paid charge count
tags:
  - stripe
  - billing
  - finance

spec_version: '0.2'
type: metric
name: stripe_total_refunded_amount
description: Total amount refunded through Stripe. Group results by currency before comparing or combining values.
model: stripe__daily_overview
expression: SUM({stripe__daily_overview}.total_refunded_amount)
synonyms:
  - refunds
  - refunded amount
  - total refunds
tags:
  - stripe
  - billing
  - finance

spec_version: '0.2'
type: metric
name: stripe_active_subscription_count
description: Number of Stripe subscriptions whose current status is active or trialing.
model: stripe__subscription_details
expression: SUM(CASE WHEN {stripe__subscription_details}.status IN ('active', 'trialing') THEN 1 ELSE 0 END)
synonyms:
  - active subscriptions
  - current subscriptions
  - live subscriptions
tags:
  - stripe
  - subscriptions
  - finance

## Relationships

spec_version: '0.2'
type: relationship
name: stripe_charges_to_customers
description: Each Stripe charge can belong to one customer.
left_model: stripe__charges
right_model: stripe__customer_overview
join_columns:
  - left: customer_id
    right: customer_id
join_type: left
relationship_type: many_to_one
tags:
  - stripe
  - billing
  - customers

spec_version: '0.2'
type: relationship
name: stripe_invoices_to_customers
description: Each Stripe invoice can belong to one customer.
left_model: stripe__invoice_details
right_model: stripe__customer_overview
join_columns:
  - left: customer_id
    right: customer_id
join_type: left
relationship_type: many_to_one
tags:
  - stripe
  - billing
  - customers

spec_version: '0.2'
type: relationship
name: stripe_subscriptions_to_customers
description: Each Stripe subscription belongs to one customer.
left_model: stripe__subscription_details
right_model: stripe__customer_overview
join_columns:
  - left: customer_id
    right: customer_id
join_type: left
relationship_type: many_to_one
tags:
  - stripe
  - subscriptions
  - customers

spec_version: '0.2'
type: relationship
name: stripe_refunds_to_charges
description: Each Stripe refund belongs to one charge.
left_model: stripe__refund_details
right_model: stripe__charges
join_columns:
  - left: charge_id
    right: charge_id
join_type: left
relationship_type: many_to_one
tags:
  - stripe
  - billing
  - refunds
