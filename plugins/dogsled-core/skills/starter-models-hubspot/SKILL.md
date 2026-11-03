---
name: starter-models-hubspot
description: Curated starter analytics models, metrics, and relationships for
  HubSpot CRM and support. Pairs with the starter-data-models overview; adapt
  the bundle to the user's actually-loaded tables.
---

# Starter data models — HubSpot

CRM and support analytics models for HubSpot contacts, companies, deals, tickets, and email engagements.

These are the **gold marts** for HubSpot — the canonical analytics
tables an analyst would build on top of the loaded HubSpot extract. Each
mart references a silver staging model named `stg_hubspot__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### hubspot\_\_companies

spec_version: '0.2'
name: hubspot__companies
type: model
description: HubSpot company records enriched with owner metadata.
grain: company_id
source:
  ref: stg_hubspot__companies
joins:
  - ref: stg_hubspot__owners
    type: left
    on: stg_hubspot__companies.owner_id = stg_hubspot__owners.owner_id
columns:
  - name: company_id
    expr: stg_hubspot__companies.company_id
    primary_key: true
    semantic_role: entity_id
    description: Unique HubSpot company identifier.
  - name: name
    expr: stg_hubspot__companies.name
    semantic_role: categorical
    description: Display name of the company.
  - name: domain
    expr: stg_hubspot__companies.domain
    semantic_role: categorical
    description: Primary company domain.
  - name: industry
    expr: stg_hubspot__companies.industry
    semantic_role: categorical
    description: Industry classification for the company.
  - name: annual_revenue
    expr: stg_hubspot__companies.annual_revenue
    semantic_role: measure
    tags:
      - financial
    description: Reported annual revenue for the company.
  - name: number_of_employees
    expr: stg_hubspot__companies.number_of_employees
    semantic_role: measure
    description: Employee count captured on the company record.
  - name: lifecycle_stage
    expr: stg_hubspot__companies.lifecycle_stage
    semantic_role: categorical
    description: Current company lifecycle stage.
  - name: owner_id
    expr: stg_hubspot__companies.owner_id
    semantic_role: entity_id
    references: stg_hubspot__owners.owner_id
    description: Assigned HubSpot owner identifier.
  - name: owner_email
    expr: stg_hubspot__owners.email
    semantic_role: categorical
    tags:
      - pii
    description: Email address of the assigned owner.
tags:
  - hubspot
  - companies
trust_tier: gold
materialization:
  type: table

### hubspot\_\_contact_lifecycle_summary

spec_version: '0.2'
name: hubspot__contact_lifecycle_summary
type: model
description: Contact counts grouped by lifecycle stage and company name.
grain:
  - lifecycle_stage
  - company
source:
  ref: stg_hubspot__contacts
columns:
  - name: lifecycle_stage
    expr: stg_hubspot__contacts.lifecycle_stage
    semantic_role: categorical
    description: HubSpot contact lifecycle stage.
  - name: company
    expr: stg_hubspot__contacts.company
    semantic_role: categorical
    description: Company name stored on the contact record.
  - name: contact_count
    expr: COUNT(*)
    semantic_role: measure
    description: Count of contacts in the lifecycle-stage and company bucket.
group_by:
  - lifecycle_stage
  - company
tags:
  - hubspot
  - contacts
  - lifecycle
trust_tier: gold
materialization:
  type: table

### hubspot\_\_contacts

spec_version: '0.2'
name: hubspot__contacts
type: model
description: Core HubSpot contact records with lifecycle and company fields.
grain: contact_id
source:
  ref: stg_hubspot__contacts
columns:
  - name: contact_id
    expr: stg_hubspot__contacts.contact_id
    primary_key: true
    semantic_role: entity_id
    description: Unique HubSpot contact identifier.
  - name: firstname
    expr: stg_hubspot__contacts.firstname
    semantic_role: categorical
    tags:
      - pii
    description: Contact first name.
  - name: lastname
    expr: stg_hubspot__contacts.lastname
    semantic_role: categorical
    tags:
      - pii
    description: Contact last name.
  - name: email
    expr: stg_hubspot__contacts.email
    semantic_role: categorical
    tags:
      - pii
    description: Primary contact email address.
  - name: phone
    expr: stg_hubspot__contacts.phone
    semantic_role: categorical
    tags:
      - pii
    description: Primary contact phone number.
  - name: company
    expr: stg_hubspot__contacts.company
    semantic_role: categorical
    description: Company name captured on the contact record.
  - name: lifecycle_stage
    expr: stg_hubspot__contacts.lifecycle_stage
    semantic_role: categorical
    description: Contact lifecycle stage in HubSpot.
  - name: created_at
    expr: stg_hubspot__contacts.created_at
    semantic_role: event_timestamp
    description: Timestamp when the contact was created.
  - name: updated_at
    expr: stg_hubspot__contacts.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the contact was last updated.
tags:
  - hubspot
  - contacts
trust_tier: gold
materialization:
  type: table

### hubspot\_\_deal_pipeline_summary

spec_version: '0.2'
name: hubspot__deal_pipeline_summary
type: model
description: Pipeline-stage summary of HubSpot deals and pipeline value.
grain:
  - pipeline_id
  - deal_stage_id
source:
  ref: stg_hubspot__deals
joins:
  - ref: stg_hubspot__pipelines
    type: left
    on: stg_hubspot__deals.pipeline = stg_hubspot__pipelines.pipeline_id
  - ref: stg_hubspot__pipeline_stages
    type: left
    on: stg_hubspot__deals.deal_stage = stg_hubspot__pipeline_stages.pipeline_stage_id
columns:
  - name: pipeline_id
    expr: stg_hubspot__deals.pipeline
    semantic_role: entity_id
    references: stg_hubspot__pipelines.pipeline_id
    description: Stable pipeline identifier.
  - name: deal_stage_id
    expr: stg_hubspot__deals.deal_stage
    semantic_role: entity_id
    references: stg_hubspot__pipeline_stages.pipeline_stage_id
    description: Stable deal stage identifier.
  - name: pipeline_label
    expr: stg_hubspot__pipelines.label
    semantic_role: categorical
    description: Human-readable pipeline label.
  - name: deal_stage_label
    expr: stg_hubspot__pipeline_stages.label
    semantic_role: categorical
    description: Human-readable deal stage label.
  - name: deal_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of deals in the pipeline stage.
  - name: total_amount
    expr: SUM(stg_hubspot__deals.amount)
    semantic_role: measure
    tags:
      - financial
    description: Total pipeline amount for the pipeline stage.
group_by:
  - pipeline_id
  - deal_stage_id
  - pipeline_label
  - deal_stage_label
tags:
  - hubspot
  - deals
  - pipeline
trust_tier: gold
materialization:
  type: table

### hubspot\_\_deals

spec_version: '0.2'
name: hubspot__deals
type: model
description: HubSpot deals enriched with owner, pipeline, and stage labels.
grain: deal_id
source:
  ref: stg_hubspot__deals
joins:
  - ref: stg_hubspot__owners
    type: left
    on: stg_hubspot__deals.owner_id = stg_hubspot__owners.owner_id
  - ref: stg_hubspot__pipelines
    type: left
    on: stg_hubspot__deals.pipeline = stg_hubspot__pipelines.pipeline_id
  - ref: stg_hubspot__pipeline_stages
    type: left
    on: stg_hubspot__deals.deal_stage = stg_hubspot__pipeline_stages.pipeline_stage_id
columns:
  - name: deal_id
    expr: stg_hubspot__deals.deal_id
    primary_key: true
    semantic_role: entity_id
    description: Unique HubSpot deal identifier.
  - name: deal_name
    expr: stg_hubspot__deals.deal_name
    semantic_role: categorical
    description: Display name of the deal.
  - name: amount
    expr: stg_hubspot__deals.amount
    semantic_role: measure
    tags:
      - financial
    description: Deal amount in the portal currency.
  - name: pipeline_id
    expr: stg_hubspot__deals.pipeline
    semantic_role: entity_id
    references: stg_hubspot__pipelines.pipeline_id
    description: Pipeline identifier for the deal.
  - name: pipeline_label
    expr: stg_hubspot__pipelines.label
    semantic_role: categorical
    description: Display label of the deal pipeline.
  - name: deal_stage_id
    expr: stg_hubspot__deals.deal_stage
    semantic_role: entity_id
    references: stg_hubspot__pipeline_stages.pipeline_stage_id
    description: Current stage identifier for the deal.
  - name: deal_stage_label
    expr: stg_hubspot__pipeline_stages.label
    semantic_role: categorical
    description: Current stage label for the deal.
  - name: owner_id
    expr: stg_hubspot__deals.owner_id
    semantic_role: entity_id
    references: stg_hubspot__owners.owner_id
    description: Assigned owner of the deal.
  - name: owner_email
    expr: stg_hubspot__owners.email
    semantic_role: categorical
    tags:
      - pii
    description: Email address of the assigned deal owner.
  - name: close_date
    expr: stg_hubspot__deals.close_date
    semantic_role: time_dimension
    description: Expected or actual close date of the deal.
  - name: created_at
    expr: stg_hubspot__deals.created_at
    semantic_role: event_timestamp
    description: Timestamp when the deal was created.
tags:
  - hubspot
  - deals
trust_tier: gold
materialization:
  type: table

### hubspot\_\_emails

spec_version: '0.2'
name: hubspot__emails
type: model
description: HubSpot CRM email engagements enriched with owner details.
grain: email_id
source:
  ref: stg_hubspot__emails
joins:
  - ref: stg_hubspot__owners
    type: left
    on: stg_hubspot__emails.owner_id = stg_hubspot__owners.owner_id
columns:
  - name: email_id
    expr: stg_hubspot__emails.email_id
    primary_key: true
    semantic_role: entity_id
    description: Unique HubSpot email engagement identifier.
  - name: timestamp
    expr: stg_hubspot__emails.timestamp
    semantic_role: event_timestamp
    description: When the email was sent or received.
  - name: subject
    expr: stg_hubspot__emails.subject
    semantic_role: categorical
    description: Subject line of the email.
  - name: status
    expr: stg_hubspot__emails.status
    semantic_role: categorical
    description: Delivery or processing status of the email.
  - name: direction
    expr: stg_hubspot__emails.direction
    semantic_role: categorical
    description: Direction of the email, such as outbound or inbound.
  - name: owner_email
    expr: stg_hubspot__owners.email
    semantic_role: categorical
    tags:
      - pii
    description: Email address of the owner responsible for the email record.
tags:
  - hubspot
  - emails
trust_tier: gold
materialization:
  type: table

### hubspot\_\_owners

spec_version: '0.2'
name: hubspot__owners
type: model
description: Owner-level activity summary across deals, tickets, and emails.
grain: owner_id
source:
  ref: stg_hubspot__owners
joins:
  - ref: stg_hubspot__deals
    type: left
    on: stg_hubspot__owners.owner_id = stg_hubspot__deals.owner_id
    pre_aggregate:
      group_by:
        - owner_id
      columns:
        - name: deal_count
          expr: COUNT(*)
        - name: pipeline_value
          expr: SUM(amount)
  - ref: stg_hubspot__tickets
    type: left
    on: stg_hubspot__owners.owner_id = stg_hubspot__tickets.owner_id
    pre_aggregate:
      group_by:
        - owner_id
      columns:
        - name: ticket_count
          expr: COUNT(*)
  - ref: stg_hubspot__emails
    type: left
    on: stg_hubspot__owners.owner_id = stg_hubspot__emails.owner_id
    pre_aggregate:
      group_by:
        - owner_id
      columns:
        - name: email_count
          expr: COUNT(*)
columns:
  - name: owner_id
    expr: stg_hubspot__owners.owner_id
    primary_key: true
    semantic_role: entity_id
    description: Unique HubSpot owner identifier.
  - name: email
    expr: stg_hubspot__owners.email
    semantic_role: categorical
    tags:
      - pii
    description: Owner email address.
  - name: first_name
    expr: stg_hubspot__owners.first_name
    semantic_role: categorical
    tags:
      - pii
    description: Owner first name.
  - name: last_name
    expr: stg_hubspot__owners.last_name
    semantic_role: categorical
    tags:
      - pii
    description: Owner last name.
  - name: deal_count
    expr: COALESCE(stg_hubspot__deals.deal_count, 0)
    semantic_role: measure
    description: Count of deals assigned to the owner.
  - name: pipeline_value
    expr: COALESCE(stg_hubspot__deals.pipeline_value, 0)
    semantic_role: measure
    tags:
      - financial
    description: Sum of deal amounts assigned to the owner.
  - name: ticket_count
    expr: COALESCE(stg_hubspot__tickets.ticket_count, 0)
    semantic_role: measure
    description: Count of support tickets assigned to the owner.
  - name: email_count
    expr: COALESCE(stg_hubspot__emails.email_count, 0)
    semantic_role: measure
    description: Count of email engagement records assigned to the owner.
tags:
  - hubspot
  - owners
trust_tier: gold
materialization:
  type: table

### hubspot\_\_tickets

spec_version: '0.2'
name: hubspot__tickets
type: model
description: HubSpot support tickets enriched with owner and pipeline stage labels.
grain: ticket_id
source:
  ref: stg_hubspot__tickets
joins:
  - ref: stg_hubspot__owners
    type: left
    on: stg_hubspot__tickets.owner_id = stg_hubspot__owners.owner_id
  - ref: stg_hubspot__ticket_pipelines
    type: left
    on: stg_hubspot__tickets.pipeline = stg_hubspot__ticket_pipelines.ticket_pipeline_id
  - ref: stg_hubspot__ticket_pipeline_stages
    type: left
    on: stg_hubspot__tickets.pipeline_stage = stg_hubspot__ticket_pipeline_stages.ticket_pipeline_stage_id
columns:
  - name: ticket_id
    expr: stg_hubspot__tickets.ticket_id
    primary_key: true
    semantic_role: entity_id
    description: Unique HubSpot ticket identifier.
  - name: subject
    expr: stg_hubspot__tickets.subject
    semantic_role: categorical
    description: Subject line of the ticket.
  - name: priority
    expr: stg_hubspot__tickets.priority
    semantic_role: categorical
    description: Priority level assigned to the ticket.
  - name: pipeline_label
    expr: stg_hubspot__ticket_pipelines.label
    semantic_role: categorical
    description: Display label of the ticket pipeline.
  - name: stage_label
    expr: stg_hubspot__ticket_pipeline_stages.label
    semantic_role: categorical
    description: Display label of the current ticket stage.
  - name: ticket_state
    expr: stg_hubspot__ticket_pipeline_stages.metadata_ticket_state
    semantic_role: categorical
    description: Open or closed state derived from the ticket stage metadata.
  - name: owner_email
    expr: stg_hubspot__owners.email
    semantic_role: categorical
    tags:
      - pii
    description: Email address of the assigned ticket owner.
  - name: created_at
    expr: stg_hubspot__tickets.created_at
    semantic_role: event_timestamp
    description: Timestamp when the ticket was created.
tags:
  - hubspot
  - tickets
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: hubspot_deal_count
description: Number of HubSpot deals.
model: hubspot__deals
expression: COUNT({hubspot__deals}.deal_id)
synonyms: [deals, deal count, opportunities]
tags: [hubspot, crm, pipeline]
spec_version: '0.2'
type: metric
name: hubspot_total_deal_amount
description: Total amount across HubSpot deals. Use only when the portal stores deal amounts in a common currency.
model: hubspot__deals
expression: SUM({hubspot__deals}.amount)
synonyms: [pipeline value, deal value, total deal amount]
tags: [hubspot, crm, finance]
spec_version: '0.2'
type: metric
name: hubspot_ticket_count
description: Number of HubSpot tickets.
model: hubspot__tickets
expression: COUNT({hubspot__tickets}.ticket_id)
synonyms: [tickets, support tickets, ticket volume]
tags: [hubspot, support, tickets]

## Relationships

spec_version: '0.2'
type: relationship
name: hubspot_deals_to_owners
description: Each HubSpot deal can belong to one owner.
left_model: hubspot__deals
right_model: hubspot__owners
join_columns:
  - left: owner_id
    right: owner_id
join_type: left
relationship_type: many_to_one
tags: [hubspot, deals, owners]
spec_version: '0.2'
type: relationship
name: hubspot_companies_to_owners
description: Each HubSpot company can belong to one owner.
left_model: hubspot__companies
right_model: hubspot__owners
join_columns:
  - left: owner_id
    right: owner_id
join_type: left
relationship_type: many_to_one
tags: [hubspot, companies, owners]
