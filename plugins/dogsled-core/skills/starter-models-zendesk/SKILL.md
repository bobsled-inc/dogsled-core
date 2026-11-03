---
name: starter-models-zendesk
description: Curated starter analytics models, metrics, and relationships for
  Zendesk support operations. Pairs with the starter-data-models overview; adapt
  the bundle to the user's actually-loaded tables.
---

# Starter data models — Zendesk

Support analytics models for Zendesk tickets, agents, organizations, and ticket volume.

These are the **gold marts** for Zendesk — the canonical analytics
tables an analyst would build on top of the loaded Zendesk extract. Each
mart references a silver staging model named `stg_zendesk__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### zendesk\_\_organizations

spec_version: '0.2'
name: zendesk__organizations
type: model
description: Zendesk organizations enriched with ticket volume rollups.
grain: organization_id
source:
  ref: stg_zendesk__organizations
joins:
  - ref: stg_zendesk__tickets
    type: left
    on: stg_zendesk__organizations.organization_id = stg_zendesk__tickets.organization_id
    pre_aggregate:
      group_by:
        - organization_id
      columns:
        - name: ticket_count
          expr: COUNT(*)
        - name: open_ticket_count
          expr: countif(status != 'closed' AND status != 'solved')
        - name: high_priority_ticket_count
          expr: countif(priority = 'high' OR priority = 'urgent')
columns:
  - name: organization_id
    expr: stg_zendesk__organizations.organization_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Zendesk organization identifier.
  - name: organization_name
    expr: stg_zendesk__organizations.name
    semantic_role: categorical
    description: Organization name.
  - name: shared_tickets
    expr: stg_zendesk__organizations.shared_tickets
    semantic_role: categorical
    description: Whether tickets are shared with end users in the organization.
  - name: shared_comments
    expr: stg_zendesk__organizations.shared_comments
    semantic_role: categorical
    description: Whether comments are shared with end users in the organization.
  - name: ticket_count
    expr: COALESCE(stg_zendesk__tickets.ticket_count, 0)
    semantic_role: measure
    description: Number of tickets linked to the organization.
  - name: open_ticket_count
    expr: COALESCE(stg_zendesk__tickets.open_ticket_count, 0)
    semantic_role: measure
    description: Number of linked tickets that are not solved or closed.
  - name: high_priority_ticket_count
    expr: COALESCE(stg_zendesk__tickets.high_priority_ticket_count, 0)
    semantic_role: measure
    description: Number of high- or urgent-priority tickets linked to the organization.
  - name: created_at
    expr: stg_zendesk__organizations.created_at
    semantic_role: event_timestamp
    description: Timestamp when the organization was created.
  - name: updated_at
    expr: stg_zendesk__organizations.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the organization was last updated.
tags:
  - zendesk
  - organizations
  - support
trust_tier: gold
materialization:
  type: table

### zendesk\_\_ticket_volume_summary

spec_version: '0.2'
name: zendesk__ticket_volume_summary
type: model
description: Zendesk ticket volume summarized by status and priority.
grain:
  - status
  - priority
source:
  ref: stg_zendesk__tickets
columns:
  - name: status
    expr: stg_zendesk__tickets.status
    semantic_role: categorical
    description: Zendesk ticket status.
  - name: priority
    expr: stg_zendesk__tickets.priority
    semantic_role: categorical
    description: Zendesk ticket priority.
  - name: ticket_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of tickets in the bucket.
  - name: assigned_ticket_count
    expr: countif(assignee_id IS NOT NULL)
    semantic_role: measure
    description: Number of tickets in the bucket with an assignee.
  - name: distinct_organization_count
    expr: count_distinct(organization_id)
    semantic_role: measure
    description: Number of distinct organizations represented in the bucket.
group_by:
  - status
  - priority
tags:
  - zendesk
  - tickets
  - summary
trust_tier: gold
materialization:
  type: table

### zendesk\_\_tickets

spec_version: '0.2'
name: zendesk__tickets
type: model
description: Zendesk tickets enriched with assignee and organization context.
grain: ticket_id
source:
  ref: stg_zendesk__tickets
joins:
  - ref: stg_zendesk__users
    type: left
    on: stg_zendesk__tickets.assignee_id = stg_zendesk__users.user_id
  - ref: stg_zendesk__organizations
    type: left
    on: stg_zendesk__tickets.organization_id = stg_zendesk__organizations.organization_id
columns:
  - name: ticket_id
    expr: stg_zendesk__tickets.ticket_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Zendesk ticket identifier.
  - name: subject
    expr: stg_zendesk__tickets.subject
    semantic_role: categorical
    description: Ticket subject line.
  - name: status
    expr: stg_zendesk__tickets.status
    semantic_role: categorical
    description: Current ticket status.
  - name: priority
    expr: stg_zendesk__tickets.priority
    semantic_role: categorical
    description: Ticket priority.
  - name: requester_id
    expr: stg_zendesk__tickets.requester_id
    semantic_role: entity_id
    description: Requester user identifier.
  - name: submitter_id
    expr: stg_zendesk__tickets.submitter_id
    semantic_role: entity_id
    description: Submitter user identifier.
  - name: assignee_id
    expr: stg_zendesk__tickets.assignee_id
    semantic_role: entity_id
    references: stg_zendesk__users.user_id
    description: Assigned agent identifier.
  - name: assignee_name
    expr: stg_zendesk__users.name
    semantic_role: categorical
    description: Name of the assigned agent.
  - name: assignee_email
    expr: stg_zendesk__users.email
    semantic_role: categorical
    tags:
      - pii
    description: Email of the assigned agent.
  - name: organization_id
    expr: stg_zendesk__tickets.organization_id
    semantic_role: entity_id
    references: stg_zendesk__organizations.organization_id
    description: Related organization identifier.
  - name: organization_name
    expr: stg_zendesk__organizations.name
    semantic_role: categorical
    description: Name of the related organization.
  - name: created_at
    expr: stg_zendesk__tickets.created_at
    semantic_role: event_timestamp
    description: Timestamp when the ticket was created.
  - name: updated_at
    expr: stg_zendesk__tickets.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the ticket was last updated.
tags:
  - zendesk
  - tickets
  - support
trust_tier: gold
materialization:
  type: table

### zendesk\_\_users

spec_version: '0.2'
name: zendesk__users
type: model
description: Zendesk users enriched with assigned-ticket rollups.
grain: user_id
source:
  ref: stg_zendesk__users
joins:
  - ref: stg_zendesk__tickets
    type: left
    on: stg_zendesk__users.user_id = stg_zendesk__tickets.assignee_id
    pre_aggregate:
      group_by:
        - assignee_id
      columns:
        - name: assigned_ticket_count
          expr: COUNT(*)
        - name: open_assigned_ticket_count
          expr: countif(status != 'closed' AND status != 'solved')
        - name: high_priority_ticket_count
          expr: countif(priority = 'high' OR priority = 'urgent')
columns:
  - name: user_id
    expr: stg_zendesk__users.user_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Zendesk user identifier.
  - name: user_name
    expr: stg_zendesk__users.name
    semantic_role: categorical
    description: Zendesk user display name.
  - name: email
    expr: stg_zendesk__users.email
    semantic_role: categorical
    tags:
      - pii
    description: Zendesk user email address.
  - name: role
    expr: stg_zendesk__users.role
    semantic_role: categorical
    description: Zendesk role assigned to the user.
  - name: active
    expr: stg_zendesk__users.active
    semantic_role: categorical
    description: Whether the user is active.
  - name: assigned_ticket_count
    expr: COALESCE(stg_zendesk__tickets.assigned_ticket_count, 0)
    semantic_role: measure
    description: Number of tickets currently or historically assigned to the user.
  - name: open_assigned_ticket_count
    expr: COALESCE(stg_zendesk__tickets.open_assigned_ticket_count, 0)
    semantic_role: measure
    description: Number of assigned tickets that are not solved or closed.
  - name: high_priority_ticket_count
    expr: COALESCE(stg_zendesk__tickets.high_priority_ticket_count, 0)
    semantic_role: measure
    description: Number of high- or urgent-priority tickets assigned to the user.
  - name: created_at
    expr: stg_zendesk__users.created_at
    semantic_role: event_timestamp
    description: Timestamp when the user was created.
  - name: updated_at
    expr: stg_zendesk__users.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the user was last updated.
tags:
  - zendesk
  - users
  - support
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: zendesk_ticket_count
description: Number of Zendesk tickets.
model: zendesk__tickets
expression: COUNT({zendesk__tickets}.ticket_id)
synonyms: [tickets, support tickets, ticket volume]
tags: [zendesk, support, tickets]
spec_version: '0.2'
type: metric
name: zendesk_open_ticket_count
description: Number of Zendesk tickets in new, open, pending, or hold status.
model: zendesk__tickets
expression: SUM(CASE WHEN {zendesk__tickets}.status IN ('new', 'open', 'pending', 'hold') THEN 1 ELSE 0 END)
synonyms: [open tickets, unresolved tickets, active tickets]
tags: [zendesk, support, tickets]
spec_version: '0.2'
type: metric
name: zendesk_high_priority_ticket_count
description: Number of Zendesk tickets with high or urgent priority.
model: zendesk__tickets
expression: SUM(CASE WHEN {zendesk__tickets}.priority IN ('high', 'urgent') THEN 1 ELSE 0 END)
synonyms: [high priority tickets, urgent priority tickets, high and urgent tickets]
tags: [zendesk, support, tickets]

## Relationships

spec_version: '0.2'
type: relationship
name: zendesk_tickets_to_organizations
description: Each Zendesk ticket can belong to one organization.
left_model: zendesk__tickets
right_model: zendesk__organizations
join_columns:
  - left: organization_id
    right: organization_id
join_type: left
relationship_type: many_to_one
tags: [zendesk, tickets, organizations]
spec_version: '0.2'
type: relationship
name: zendesk_tickets_to_users
description: Each Zendesk ticket can be assigned to one user.
left_model: zendesk__tickets
right_model: zendesk__users
join_columns:
  - left: assignee_id
    right: user_id
join_type: left
relationship_type: many_to_one
tags: [zendesk, tickets, users]
