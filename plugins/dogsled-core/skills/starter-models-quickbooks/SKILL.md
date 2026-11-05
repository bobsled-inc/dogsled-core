---
name: starter-models-quickbooks
description: Curated starter analytics models, metrics, and relationships for
  QuickBooks accounting. Pairs with the starter-data-models overview; adapt the
  bundle to the user's actually-loaded tables.
---

# Starter data models — QuickBooks

Accounting and financial analytics models for QuickBooks customers, invoices, bills, payments, and vendors.

These are the **gold marts** for QuickBooks — the canonical analytics
tables an analyst would build on top of the loaded QuickBooks extract. Each
mart references a silver staging model named `stg_quickbooks__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### quickbooks\_\_bills

spec_version: '0.2'
name: quickbooks__bills
type: model
description: QuickBooks bills enriched with vendor context.
grain: bill_id
source:
  ref: stg_quickbooks__bills
joins:
  - ref: stg_quickbooks__vendors
    type: left
    on: stg_quickbooks__bills.vendor_id = stg_quickbooks__vendors.vendor_id
columns:
  - name: bill_id
    expr: stg_quickbooks__bills.bill_id
    primary_key: true
    semantic_role: entity_id
    description: Unique QuickBooks bill identifier.
  - name: vendor_id
    expr: stg_quickbooks__bills.vendor_id
    semantic_role: entity_id
    references: stg_quickbooks__vendors.vendor_id
    description: Vendor tied to the bill.
  - name: vendor_name
    expr: stg_quickbooks__vendors.name
    semantic_role: categorical
    description: Vendor display name from the related vendor record.
  - name: total_amount
    expr: stg_quickbooks__bills.total_amt
    semantic_role: measure
    tags:
      - financial
    description: Total bill amount.
  - name: balance
    expr: stg_quickbooks__bills.balance
    semantic_role: measure
    tags:
      - financial
    description: Outstanding balance on the bill.
  - name: due_date
    expr: stg_quickbooks__bills.due_date
    semantic_role: event_timestamp
    description: Date when the bill payment is due.
  - name: created_at
    expr: stg_quickbooks__bills.created_at
    semantic_role: event_timestamp
    description: Timestamp when the bill was created.
tags:
  - quickbooks
  - bills
  - finance
trust_tier: gold
materialization:
  type: table

### quickbooks\_\_customers

spec_version: '0.2'
name: quickbooks__customers
type: model
description: QuickBooks customers enriched with invoice and payment rollups.
grain: customer_id
source:
  ref: stg_quickbooks__customers
joins:
  - ref: stg_quickbooks__invoices
    type: left
    on: stg_quickbooks__customers.customer_id = stg_quickbooks__invoices.customer_id
    pre_aggregate:
      group_by:
        - customer_id
      columns:
        - name: total_invoice_count
          expr: COUNT(*)
        - name: total_invoice_amount
          expr: COALESCE(SUM(stg_quickbooks__invoices.total_amt), 0)
        - name: total_invoice_balance
          expr: COALESCE(SUM(stg_quickbooks__invoices.balance), 0)
  - ref: stg_quickbooks__payments
    type: left
    on: stg_quickbooks__customers.customer_id = stg_quickbooks__payments.customer_id
    pre_aggregate:
      group_by:
        - customer_id
      columns:
        - name: total_payment_amount
          expr: COALESCE(SUM(stg_quickbooks__payments.amount), 0)
        - name: payment_count
          expr: COUNT(*)
columns:
  - name: customer_id
    expr: stg_quickbooks__customers.customer_id
    primary_key: true
    semantic_role: entity_id
    description: Unique QuickBooks customer identifier.
  - name: name
    expr: stg_quickbooks__customers.name
    semantic_role: categorical
    description: Customer display name.
  - name: email
    expr: stg_quickbooks__customers.email
    semantic_role: categorical
    tags:
      - pii
    description: Customer email address.
  - name: balance
    expr: stg_quickbooks__customers.balance
    semantic_role: measure
    tags:
      - financial
    description: Outstanding balance on the customer account.
  - name: total_invoice_count
    expr: COALESCE(stg_quickbooks__invoices.total_invoice_count, 0)
    semantic_role: measure
    description: Total number of invoices for the customer.
  - name: total_invoice_amount
    expr: COALESCE(stg_quickbooks__invoices.total_invoice_amount, 0)
    semantic_role: measure
    tags:
      - financial
    description: Total invoice amount for the customer.
  - name: total_invoice_balance
    expr: COALESCE(stg_quickbooks__invoices.total_invoice_balance, 0)
    semantic_role: measure
    tags:
      - financial
    description: Total outstanding invoice balance for the customer.
  - name: total_payment_amount
    expr: COALESCE(stg_quickbooks__payments.total_payment_amount, 0)
    semantic_role: measure
    tags:
      - financial
    description: Total payment amount received from the customer.
  - name: payment_count
    expr: COALESCE(stg_quickbooks__payments.payment_count, 0)
    semantic_role: measure
    description: Total number of payments received from the customer.
  - name: created_at
    expr: stg_quickbooks__customers.created_at
    semantic_role: event_timestamp
    description: Timestamp when the customer was created.
tags:
  - quickbooks
  - customers
  - finance
trust_tier: gold
materialization:
  type: table

### quickbooks\_\_invoices

spec_version: '0.2'
name: quickbooks__invoices
type: model
description: QuickBooks invoices enriched with customer and payment context.
grain: invoice_id
source:
  ref: stg_quickbooks__invoices
joins:
  - ref: stg_quickbooks__customers
    type: left
    on: stg_quickbooks__invoices.customer_id = stg_quickbooks__customers.customer_id
  - ref: stg_quickbooks__payment_applications
    type: left
    on: stg_quickbooks__invoices.invoice_id = stg_quickbooks__payment_applications.invoice_id
    pre_aggregate:
      group_by:
        - invoice_id
      columns:
        - name: total_paid_amount
          expr: COALESCE(SUM(stg_quickbooks__payment_applications.applied_amount), 0)
columns:
  - name: invoice_id
    expr: stg_quickbooks__invoices.invoice_id
    primary_key: true
    semantic_role: entity_id
    description: Unique QuickBooks invoice identifier.
  - name: customer_id
    expr: stg_quickbooks__invoices.customer_id
    semantic_role: entity_id
    references: stg_quickbooks__customers.customer_id
    description: Customer tied to the invoice.
  - name: customer_name
    expr: stg_quickbooks__customers.name
    semantic_role: categorical
    description: Customer display name from the related customer record.
  - name: total_amount
    expr: stg_quickbooks__invoices.total_amt
    semantic_role: measure
    tags:
      - financial
    description: Total invoice amount.
  - name: balance
    expr: stg_quickbooks__invoices.balance
    semantic_role: measure
    tags:
      - financial
    description: Outstanding balance on the invoice.
  - name: total_paid_amount
    expr: COALESCE(stg_quickbooks__payment_applications.total_paid_amount, 0)
    semantic_role: measure
    tags:
      - financial
    description: Total amount paid against the invoice.
  - name: due_date
    expr: stg_quickbooks__invoices.due_date
    semantic_role: event_timestamp
    description: Date when the invoice payment is due.
  - name: created_at
    expr: stg_quickbooks__invoices.created_at
    semantic_role: event_timestamp
    description: Timestamp when the invoice was created.
tags:
  - quickbooks
  - invoices
  - finance
trust_tier: gold
materialization:
  type: table

### quickbooks\_\_payments

spec_version: '0.2'
name: quickbooks__payments
type: model
description: QuickBooks payments enriched with customer context.
grain: payment_id
source:
  ref: stg_quickbooks__payments
joins:
  - ref: stg_quickbooks__customers
    type: left
    on: stg_quickbooks__payments.customer_id = stg_quickbooks__customers.customer_id
columns:
  - name: payment_id
    expr: stg_quickbooks__payments.payment_id
    primary_key: true
    semantic_role: entity_id
    description: Unique QuickBooks payment identifier.
  - name: customer_id
    expr: stg_quickbooks__payments.customer_id
    semantic_role: entity_id
    references: stg_quickbooks__customers.customer_id
    description: Customer tied to the payment.
  - name: customer_name
    expr: stg_quickbooks__customers.name
    semantic_role: categorical
    description: Customer display name from the related customer record.
  - name: amount
    expr: stg_quickbooks__payments.amount
    semantic_role: measure
    tags:
      - financial
    description: Payment amount.
  - name: unapplied_amount
    expr: stg_quickbooks__payments.unapplied_amount
    semantic_role: measure
    tags:
      - financial
    description: Portion of the payment not applied to a transaction.
  - name: method
    expr: stg_quickbooks__payments.payment_method
    semantic_role: categorical
    description: Payment method used.
  - name: created_at
    expr: stg_quickbooks__payments.created_at
    semantic_role: event_timestamp
    description: Timestamp when the payment was created.
tags:
  - quickbooks
  - payments
  - finance
trust_tier: gold
materialization:
  type: table

### quickbooks\_\_payment_applications

spec_version: '0.2'
name: quickbooks__payment_applications
type: model
description: Amounts from QuickBooks payments applied to individual invoices.
grain:
  - payment_id
  - invoice_id
source:
  ref: stg_quickbooks__payment_applications
  filter: transaction_type = 'Invoice' AND invoice_id IS NOT NULL
columns:
  - name: payment_id
    expr: stg_quickbooks__payment_applications.payment_id
    primary_key: true
    semantic_role: entity_id
    references: stg_quickbooks__payments.payment_id
    description: Payment that supplied the applied amount.
  - name: invoice_id
    expr: stg_quickbooks__payment_applications.invoice_id
    primary_key: true
    semantic_role: entity_id
    references: stg_quickbooks__invoices.invoice_id
    description: Invoice that received the applied amount.
  - name: applied_amount
    expr: stg_quickbooks__payment_applications.applied_amount
    semantic_role: measure
    tags:
      - financial
    description: Portion of the payment applied to the invoice.
tags:
  - quickbooks
  - payments
  - invoices
trust_tier: gold
materialization:
  type: table

### quickbooks\_\_vendor_spend_summary

spec_version: '0.2'
name: quickbooks__vendor_spend_summary
type: model
description: QuickBooks vendor spend summarized by vendor.
grain:
  - vendor_id
  - vendor_name
source:
  ref: stg_quickbooks__bills
joins:
  - ref: stg_quickbooks__vendors
    type: left
    on: stg_quickbooks__bills.vendor_id = stg_quickbooks__vendors.vendor_id
columns:
  - name: vendor_id
    expr: stg_quickbooks__bills.vendor_id
    primary_key: true
    semantic_role: entity_id
    references: stg_quickbooks__vendors.vendor_id
    description: Vendor identifier for the spend bucket.
  - name: vendor_name
    expr: stg_quickbooks__vendors.name
    semantic_role: categorical
    description: Vendor display name.
  - name: total_spend
    expr: COALESCE(SUM(stg_quickbooks__bills.total_amt), 0)
    semantic_role: measure
    tags:
      - financial
    description: Total bill amount for the vendor.
  - name: outstanding_balance
    expr: COALESCE(SUM(stg_quickbooks__bills.balance), 0)
    semantic_role: measure
    tags:
      - financial
    description: Total outstanding bill balance for the vendor.
  - name: bill_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of bills for the vendor.
group_by:
  - vendor_id
  - vendor_name
tags:
  - quickbooks
  - vendors
  - summary
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: quickbooks_total_invoice_amount
description: Total amount invoiced in QuickBooks. Use only when the company file uses a common reporting currency.
model: quickbooks__invoices
expression: SUM({quickbooks__invoices}.total_amount)
synonyms: [invoice amount, invoice value, total billed amount]
tags: [quickbooks, accounting, finance]
spec_version: '0.2'
type: metric
name: quickbooks_outstanding_invoice_balance
description: Total outstanding balance on QuickBooks invoices. Use only when the company file uses a common reporting currency.
model: quickbooks__invoices
expression: SUM({quickbooks__invoices}.balance)
synonyms: [accounts receivable, invoice balance, outstanding invoices]
tags: [quickbooks, accounting, finance]
spec_version: '0.2'
type: metric
name: quickbooks_total_payment_amount
description: Total amount of QuickBooks customer payments. Use only when the company file uses a common reporting currency.
model: quickbooks__payments
expression: SUM({quickbooks__payments}.amount)
synonyms: [payments received, customer payments, payment total]
tags: [quickbooks, accounting, finance]

## Relationships

spec_version: '0.2'
type: relationship
name: quickbooks_invoices_to_customers
description: Each QuickBooks invoice belongs to one customer.
left_model: quickbooks__invoices
right_model: quickbooks__customers
join_columns:
  - left: customer_id
    right: customer_id
join_type: left
relationship_type: many_to_one
tags: [quickbooks, invoices, customers]
spec_version: '0.2'
type: relationship
name: quickbooks_payment_applications_to_invoices
description: Each QuickBooks payment application belongs to one invoice.
left_model: quickbooks__payment_applications
right_model: quickbooks__invoices
join_columns:
  - left: invoice_id
    right: invoice_id
join_type: left
relationship_type: many_to_one
tags: [quickbooks, payments, invoices]
spec_version: '0.2'
type: relationship
name: quickbooks_payment_applications_to_payments
description: Each QuickBooks payment application belongs to one payment.
left_model: quickbooks__payment_applications
right_model: quickbooks__payments
join_columns:
  - left: payment_id
    right: payment_id
join_type: left
relationship_type: many_to_one
tags: [quickbooks, payment-applications, payments]
