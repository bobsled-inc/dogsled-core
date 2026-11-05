---
name: starter-models-salesforce
description: Curated starter analytics models, metrics, and relationships for
  Salesforce CRM and revenue. Pairs with the starter-data-models overview; adapt
  the bundle to the user's actually-loaded tables.
---

# Starter data models — Salesforce

CRM and revenue analytics models for Salesforce accounts, pipeline, support, and campaign activity.

These are the **gold marts** for Salesforce — the canonical analytics
tables an analyst would build on top of the loaded Salesforce extract. Each
mart references a silver staging model named `stg_salesforce__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### salesforce\_\_accounts

spec_version: '0.2'
name: salesforce__accounts
type: model
description: Salesforce accounts enriched with contact and case rollups.
grain: account_id
source:
  ref: stg_salesforce__accounts
joins:
  - ref: stg_salesforce__contacts
    type: left
    on: stg_salesforce__accounts.account_id = stg_salesforce__contacts.account_id
    pre_aggregate:
      group_by:
        - account_id
      columns:
        - name: contact_count
          expr: COUNT(*)
  - ref: stg_salesforce__cases
    type: left
    on: stg_salesforce__accounts.account_id = stg_salesforce__cases.account_id
    pre_aggregate:
      group_by:
        - account_id
      columns:
        - name: case_count
          expr: COUNT(*)
        - name: open_case_count
          expr: countif(is_closed = FALSE)
columns:
  - name: account_id
    expr: stg_salesforce__accounts.account_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Salesforce account identifier.
  - name: account_name
    expr: stg_salesforce__accounts.name
    semantic_role: categorical
    description: Account name.
  - name: account_type
    expr: stg_salesforce__accounts.type
    semantic_role: categorical
    description: Salesforce account type.
  - name: industry
    expr: stg_salesforce__accounts.industry
    semantic_role: categorical
    description: Industry assigned to the account.
  - name: contact_count
    expr: COALESCE(stg_salesforce__contacts.contact_count, 0)
    semantic_role: measure
    description: Number of contacts associated with the account.
  - name: case_count
    expr: COALESCE(stg_salesforce__cases.case_count, 0)
    semantic_role: measure
    description: Number of support cases attached to the account.
  - name: open_case_count
    expr: COALESCE(stg_salesforce__cases.open_case_count, 0)
    semantic_role: measure
    description: Number of still-open cases attached to the account.
  - name: created_at
    expr: stg_salesforce__accounts.created_at
    semantic_role: event_timestamp
    description: Timestamp when the account was created.
  - name: updated_at
    expr: stg_salesforce__accounts.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the account was last updated.
tags:
  - salesforce
  - crm
  - accounts
trust_tier: gold
materialization:
  type: table

### salesforce\_\_campaign_members

spec_version: '0.2'
name: salesforce__campaign_members
type: model
description: Salesforce campaign membership records enriched with campaign, contact, and lead context.
grain: campaign_member_id
source:
  ref: stg_salesforce__campaign_members
joins:
  - ref: stg_salesforce__campaigns
    type: left
    on: stg_salesforce__campaign_members.campaign_id = stg_salesforce__campaigns.campaign_id
  - ref: stg_salesforce__contacts
    type: left
    on: stg_salesforce__campaign_members.contact_id = stg_salesforce__contacts.contact_id
  - ref: stg_salesforce__leads
    type: left
    on: stg_salesforce__campaign_members.lead_id = stg_salesforce__leads.lead_id
columns:
  - name: campaign_member_id
    expr: stg_salesforce__campaign_members.campaign_member_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Salesforce campaign membership identifier.
  - name: campaign_id
    expr: stg_salesforce__campaign_members.campaign_id
    semantic_role: entity_id
    references: stg_salesforce__campaigns.campaign_id
    description: Campaign tied to the membership.
  - name: campaign_name
    expr: stg_salesforce__campaigns.name
    semantic_role: categorical
    description: Campaign name.
  - name: campaign_status
    expr: stg_salesforce__campaigns.status
    semantic_role: categorical
    description: Current status of the campaign.
  - name: campaign_type
    expr: stg_salesforce__campaigns.type
    semantic_role: categorical
    description: Campaign type classification.
  - name: member_status
    expr: stg_salesforce__campaign_members.status
    semantic_role: categorical
    description: Participation status for the member.
  - name: contact_id
    expr: stg_salesforce__campaign_members.contact_id
    semantic_role: entity_id
    references: stg_salesforce__contacts.contact_id
    description: Contact attached to the campaign membership when present.
  - name: contact_email
    expr: stg_salesforce__contacts.email
    semantic_role: categorical
    tags:
      - pii
    description: Contact email for the campaign member.
  - name: lead_id
    expr: stg_salesforce__campaign_members.lead_id
    semantic_role: entity_id
    references: stg_salesforce__leads.lead_id
    description: Lead attached to the campaign membership when present.
  - name: lead_first_name
    expr: stg_salesforce__leads.first_name
    semantic_role: categorical
    tags:
      - pii
    description: Lead first name.
  - name: lead_last_name
    expr: stg_salesforce__leads.last_name
    semantic_role: categorical
    tags:
      - pii
    description: Lead last name.
  - name: lead_company
    expr: stg_salesforce__leads.company
    semantic_role: categorical
    description: Company captured on the lead.
  - name: lead_status
    expr: stg_salesforce__leads.status
    semantic_role: categorical
    description: Current lead status.
  - name: first_responded_date
    expr: stg_salesforce__campaign_members.first_responded_date
    semantic_role: event_timestamp
    description: Timestamp when the member first responded to the campaign.
  - name: created_at
    expr: stg_salesforce__campaign_members.created_at
    semantic_role: event_timestamp
    description: Timestamp when the campaign membership was created.
  - name: updated_at
    expr: stg_salesforce__campaign_members.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the campaign membership was last updated.
tags:
  - salesforce
  - marketing
  - campaigns
trust_tier: gold
materialization:
  type: table

### salesforce\_\_cases

spec_version: '0.2'
name: salesforce__cases
type: model
description: Salesforce support cases enriched with account, contact, and owner context.
grain: case_id
source:
  ref: stg_salesforce__cases
joins:
  - ref: stg_salesforce__accounts
    type: left
    on: stg_salesforce__cases.account_id = stg_salesforce__accounts.account_id
  - ref: stg_salesforce__contacts
    type: left
    on: stg_salesforce__cases.contact_id = stg_salesforce__contacts.contact_id
  - ref: stg_salesforce__users
    type: left
    on: stg_salesforce__cases.owner_id = stg_salesforce__users.user_id
columns:
  - name: case_id
    expr: stg_salesforce__cases.case_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Salesforce case identifier.
  - name: case_number
    expr: stg_salesforce__cases.case_number
    semantic_role: categorical
    description: Human-readable case number.
  - name: subject
    expr: stg_salesforce__cases.subject
    semantic_role: categorical
    description: Support case subject line.
  - name: status
    expr: stg_salesforce__cases.status
    semantic_role: categorical
    description: Current case status.
  - name: priority
    expr: stg_salesforce__cases.priority
    semantic_role: categorical
    description: Priority assigned to the case.
  - name: origin
    expr: stg_salesforce__cases.origin
    semantic_role: categorical
    description: Intake channel for the case.
  - name: account_id
    expr: stg_salesforce__cases.account_id
    semantic_role: entity_id
    references: stg_salesforce__accounts.account_id
    description: Account related to the case.
  - name: account_name
    expr: stg_salesforce__accounts.name
    semantic_role: categorical
    description: Name of the related account.
  - name: contact_id
    expr: stg_salesforce__cases.contact_id
    semantic_role: entity_id
    references: stg_salesforce__contacts.contact_id
    description: Contact tied to the case.
  - name: contact_email
    expr: stg_salesforce__contacts.email
    semantic_role: categorical
    tags:
      - pii
    description: Contact email for the case.
  - name: owner_id
    expr: stg_salesforce__cases.owner_id
    semantic_role: entity_id
    references: stg_salesforce__users.user_id
    description: Salesforce user that owns the case.
  - name: owner_name
    expr: stg_salesforce__users.name
    semantic_role: categorical
    description: Name of the owning Salesforce user.
  - name: owner_email
    expr: stg_salesforce__users.email
    semantic_role: categorical
    tags:
      - pii
    description: Email of the owning Salesforce user.
  - name: is_closed
    expr: stg_salesforce__cases.is_closed
    semantic_role: categorical
    description: Whether the case is closed.
  - name: created_at
    expr: stg_salesforce__cases.created_at
    semantic_role: event_timestamp
    description: Timestamp when the case was created.
  - name: updated_at
    expr: stg_salesforce__cases.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the case was last updated.
tags:
  - salesforce
  - support
  - cases
trust_tier: gold
materialization:
  type: table

### salesforce\_\_contacts

spec_version: '0.2'
name: salesforce__contacts
type: model
description: Salesforce contacts enriched with account context and opportunity role counts.
grain: contact_id
source:
  ref: stg_salesforce__contacts
joins:
  - ref: stg_salesforce__accounts
    type: left
    on: stg_salesforce__contacts.account_id = stg_salesforce__accounts.account_id
  - ref: stg_salesforce__opportunity_contact_roles
    type: left
    on: stg_salesforce__contacts.contact_id = stg_salesforce__opportunity_contact_roles.contact_id
    pre_aggregate:
      group_by:
        - contact_id
      columns:
        - name: opportunity_role_count
          expr: COUNT(*)
        - name: primary_opportunity_role_count
          expr: countif(is_primary = TRUE)
columns:
  - name: contact_id
    expr: stg_salesforce__contacts.contact_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Salesforce contact identifier.
  - name: account_id
    expr: stg_salesforce__contacts.account_id
    semantic_role: entity_id
    references: stg_salesforce__accounts.account_id
    description: Account associated with the contact.
  - name: account_name
    expr: stg_salesforce__accounts.name
    semantic_role: categorical
    description: Name of the related account.
  - name: first_name
    expr: stg_salesforce__contacts.first_name
    semantic_role: categorical
    tags:
      - pii
    description: Contact first name.
  - name: last_name
    expr: stg_salesforce__contacts.last_name
    semantic_role: categorical
    tags:
      - pii
    description: Contact last name.
  - name: email
    expr: stg_salesforce__contacts.email
    semantic_role: categorical
    tags:
      - pii
    description: Contact email address.
  - name: opportunity_role_count
    expr: COALESCE(stg_salesforce__opportunity_contact_roles.opportunity_role_count, 0)
    semantic_role: measure
    description: Number of opportunity-contact-role assignments for the contact.
  - name: primary_opportunity_role_count
    expr: COALESCE(stg_salesforce__opportunity_contact_roles.primary_opportunity_role_count, 0)
    semantic_role: measure
    description: Number of primary opportunity roles owned by the contact.
  - name: created_at
    expr: stg_salesforce__contacts.created_at
    semantic_role: event_timestamp
    description: Timestamp when the contact was created.
  - name: updated_at
    expr: stg_salesforce__contacts.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the contact was last updated.
tags:
  - salesforce
  - crm
  - contacts
trust_tier: gold
materialization:
  type: table

### salesforce\_\_opportunities

spec_version: '0.2'
name: salesforce__opportunities
type: model
description: Salesforce opportunities with rolled-up product and contact-role activity.
grain: opportunity_id
source:
  ref: stg_salesforce__opportunities
joins:
  - ref: stg_salesforce__accounts
    type: left
    on: stg_salesforce__opportunities.account_id = stg_salesforce__accounts.account_id
  - ref: stg_salesforce__opportunity_line_items
    type: left
    on: stg_salesforce__opportunities.opportunity_id = stg_salesforce__opportunity_line_items.opportunity_id
    pre_aggregate:
      group_by:
        - opportunity_id
      columns:
        - name: line_item_count
          expr: COUNT(*)
        - name: product_count
          expr: count_distinct(product2_id)
        - name: total_quantity
          expr: SUM(quantity)
        - name: total_line_amount
          expr: SUM(total_price)
  - ref: stg_salesforce__opportunity_contact_roles
    type: left
    on: stg_salesforce__opportunities.opportunity_id = stg_salesforce__opportunity_contact_roles.opportunity_id
    pre_aggregate:
      group_by:
        - opportunity_id
      columns:
        - name: contact_role_count
          expr: COUNT(*)
        - name: primary_contact_role_count
          expr: countif(is_primary = TRUE)
columns:
  - name: opportunity_id
    expr: stg_salesforce__opportunities.opportunity_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Salesforce opportunity identifier.
  - name: opportunity_name
    expr: stg_salesforce__opportunities.name
    semantic_role: categorical
    description: Opportunity name.
  - name: account_id
    expr: stg_salesforce__opportunities.account_id
    semantic_role: entity_id
    references: stg_salesforce__accounts.account_id
    description: Account tied to the opportunity.
  - name: account_name
    expr: stg_salesforce__accounts.name
    semantic_role: categorical
    description: Name of the account tied to the opportunity.
  - name: stage_name
    expr: stg_salesforce__opportunities.stage_name
    semantic_role: categorical
    description: Current pipeline stage of the opportunity.
  - name: amount
    expr: stg_salesforce__opportunities.amount
    semantic_role: measure
    tags:
      - financial
    description: Opportunity amount.
  - name: close_date
    expr: CAST(stg_salesforce__opportunities.close_date AS DATE)
    semantic_role: time_dimension
    description: Expected or actual opportunity close date.
  - name: line_item_count
    expr: COALESCE(stg_salesforce__opportunity_line_items.line_item_count, 0)
    semantic_role: measure
    description: Number of line items attached to the opportunity.
  - name: product_count
    expr: COALESCE(stg_salesforce__opportunity_line_items.product_count, 0)
    semantic_role: measure
    description: Count of distinct products attached to the opportunity.
  - name: total_quantity
    expr: COALESCE(stg_salesforce__opportunity_line_items.total_quantity, 0)
    semantic_role: measure
    description: Total product quantity across opportunity line items.
  - name: total_line_amount
    expr: COALESCE(stg_salesforce__opportunity_line_items.total_line_amount, 0)
    semantic_role: measure
    tags:
      - financial
    description: Sum of opportunity line-item totals.
  - name: contact_role_count
    expr: COALESCE(stg_salesforce__opportunity_contact_roles.contact_role_count, 0)
    semantic_role: measure
    description: Number of contacts linked to the opportunity.
  - name: primary_contact_role_count
    expr: COALESCE(stg_salesforce__opportunity_contact_roles.primary_contact_role_count, 0)
    semantic_role: measure
    description: Number of primary contact roles on the opportunity.
  - name: created_at
    expr: stg_salesforce__opportunities.created_at
    semantic_role: event_timestamp
    description: Timestamp when the opportunity was created.
  - name: updated_at
    expr: stg_salesforce__opportunities.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the opportunity was last updated.
tags:
  - salesforce
  - revenue
  - opportunities
trust_tier: gold
materialization:
  type: table

### salesforce\_\_opportunity_line_items

spec_version: '0.2'
name: salesforce__opportunity_line_items
type: model
description: Salesforce opportunity line items enriched with product and pricebook metadata.
grain: opportunity_line_item_id
source:
  ref: stg_salesforce__opportunity_line_items
joins:
  - ref: stg_salesforce__opportunities
    type: left
    on: stg_salesforce__opportunity_line_items.opportunity_id = stg_salesforce__opportunities.opportunity_id
  - ref: stg_salesforce__pricebook_entries
    type: left
    on: stg_salesforce__opportunity_line_items.pricebook_entry_id = stg_salesforce__pricebook_entries.pricebook_entry_id
  - ref: stg_salesforce__products
    type: left
    on: stg_salesforce__opportunity_line_items.product2_id = stg_salesforce__products.product_id
columns:
  - name: opportunity_line_item_id
    expr: stg_salesforce__opportunity_line_items.opportunity_line_item_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Salesforce opportunity line item identifier.
  - name: opportunity_id
    expr: stg_salesforce__opportunity_line_items.opportunity_id
    semantic_role: entity_id
    references: stg_salesforce__opportunities.opportunity_id
    description: Opportunity that owns the line item.
  - name: opportunity_name
    expr: stg_salesforce__opportunities.name
    semantic_role: categorical
    description: Opportunity name.
  - name: pricebook_entry_id
    expr: stg_salesforce__opportunity_line_items.pricebook_entry_id
    semantic_role: entity_id
    references: stg_salesforce__pricebook_entries.pricebook_entry_id
    description: Pricebook entry selected for the line item.
  - name: pricebook_entry_name
    expr: stg_salesforce__pricebook_entries.name
    semantic_role: categorical
    description: Name of the selected pricebook entry.
  - name: product_id
    expr: stg_salesforce__opportunity_line_items.product2_id
    semantic_role: entity_id
    references: stg_salesforce__products.product_id
    description: Product sold on the line item.
  - name: product_name
    expr: stg_salesforce__products.name
    semantic_role: categorical
    description: Product name.
  - name: product_code
    expr: stg_salesforce__products.product_code
    semantic_role: categorical
    description: Product code for the sold item.
  - name: product_family
    expr: stg_salesforce__products.family
    semantic_role: categorical
    description: Product family classification.
  - name: line_item_name
    expr: stg_salesforce__opportunity_line_items.name
    semantic_role: categorical
    description: Line item display name.
  - name: quantity
    expr: stg_salesforce__opportunity_line_items.quantity
    semantic_role: measure
    description: Quantity sold on the line item.
  - name: unit_price
    expr: stg_salesforce__opportunity_line_items.unit_price
    semantic_role: measure
    tags:
      - financial
    description: Unit price for the line item.
  - name: total_price
    expr: stg_salesforce__opportunity_line_items.total_price
    semantic_role: measure
    tags:
      - financial
    description: Extended total for the line item.
  - name: created_at
    expr: stg_salesforce__opportunity_line_items.created_at
    semantic_role: event_timestamp
    description: Timestamp when the line item was created.
  - name: updated_at
    expr: stg_salesforce__opportunity_line_items.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the line item was last updated.
tags:
  - salesforce
  - revenue
  - line-items
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: salesforce_opportunity_count
description: Number of Salesforce opportunities.
model: salesforce__opportunities
expression: COUNT({salesforce__opportunities}.opportunity_id)
synonyms: [opportunities, deal count, pipeline opportunities]
tags: [salesforce, crm, pipeline]
spec_version: '0.2'
type: metric
name: salesforce_total_opportunity_amount
description: Total amount across Salesforce opportunities. Use only when the org stores opportunity amounts in a common currency.
model: salesforce__opportunities
expression: SUM({salesforce__opportunities}.amount)
synonyms: [pipeline value, opportunity value, total opportunity amount]
tags: [salesforce, crm, finance]
spec_version: '0.2'
type: metric
name: salesforce_open_case_count
description: Number of Salesforce cases that are not closed.
model: salesforce__cases
expression: SUM(CASE WHEN {salesforce__cases}.is_closed THEN 0 ELSE 1 END)
synonyms: [open cases, unresolved cases, active support cases]
tags: [salesforce, support, cases]

## Relationships

spec_version: '0.2'
type: relationship
name: salesforce_opportunities_to_accounts
description: Each Salesforce opportunity can belong to one account.
left_model: salesforce__opportunities
right_model: salesforce__accounts
join_columns:
  - left: account_id
    right: account_id
join_type: left
relationship_type: many_to_one
tags: [salesforce, opportunities, accounts]
spec_version: '0.2'
type: relationship
name: salesforce_opportunity_line_items_to_opportunities
description: Each Salesforce opportunity line item belongs to one opportunity.
left_model: salesforce__opportunity_line_items
right_model: salesforce__opportunities
join_columns:
  - left: opportunity_id
    right: opportunity_id
join_type: left
relationship_type: many_to_one
tags: [salesforce, line-items, opportunities]
