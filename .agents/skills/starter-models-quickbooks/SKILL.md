---
name: starter-models-quickbooks
description: Curated starter analytics models, metrics, and relationships for QuickBooks accounting. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - quickbooks starter models
  - prebuilt quickbooks models
  - curated quickbooks analytics models
  - standard quickbooks data models
  - build quickbooks marts
  - QuickBooks analytics shape
  - models for quickbooks
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

{{include: packages/models/marts/quickbooks/quickbooks__bills.yml}}

### quickbooks\_\_customers

{{include: packages/models/marts/quickbooks/quickbooks__customers.yml}}

### quickbooks\_\_invoices

{{include: packages/models/marts/quickbooks/quickbooks__invoices.yml}}

### quickbooks\_\_payments

{{include: packages/models/marts/quickbooks/quickbooks__payments.yml}}

### quickbooks\_\_payment_applications

{{include: packages/models/marts/quickbooks/quickbooks__payment_applications.yml}}

### quickbooks\_\_vendor_spend_summary

{{include: packages/models/marts/quickbooks/quickbooks__vendor_spend_summary.yml}}

## Metrics

{{include: packages/models/marts/quickbooks/metrics/quickbooks_total_invoice_amount.yml}}
{{include: packages/models/marts/quickbooks/metrics/quickbooks_outstanding_invoice_balance.yml}}
{{include: packages/models/marts/quickbooks/metrics/quickbooks_total_payment_amount.yml}}

## Relationships

{{include: packages/models/marts/quickbooks/relationships/quickbooks_invoices_to_customers.yml}}
{{include: packages/models/marts/quickbooks/relationships/quickbooks_payment_applications_to_invoices.yml}}
{{include: packages/models/marts/quickbooks/relationships/quickbooks_payment_applications_to_payments.yml}}
