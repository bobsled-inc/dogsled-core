---
name: starter-models-intercom
description: Curated starter analytics models, metrics, and relationships for
  Intercom support and engagement. Pairs with the starter-data-models overview;
  adapt the bundle to the user's actually-loaded tables.
---

# Starter data models — Intercom

Customer support and engagement analytics models for Intercom contacts, conversations, and admins.

These are the **gold marts** for Intercom — the canonical analytics
tables an analyst would build on top of the loaded Intercom extract. Each
mart references a silver staging model named `stg_intercom__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### intercom\_\_admins

spec_version: '0.2'
name: intercom__admins
type: model
description: Admin detail with conversation rollups from Intercom.
grain: admin_id
source:
  ref: stg_intercom__list_admins
joins:
  - ref: stg_intercom__list_conversations
    type: left
    on: stg_intercom__list_admins.list_admin_id = stg_intercom__list_conversations.admin_assignee_id
    pre_aggregate:
      group_by:
        - admin_assignee_id
      columns:
        - name: conversation_count
          expr: COUNT(*)
        - name: open_conversation_count
          expr: SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END)
        - name: closed_conversation_count
          expr: SUM(CASE WHEN state = 'closed' THEN 1 ELSE 0 END)
columns:
  - name: admin_id
    expr: stg_intercom__list_admins.list_admin_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Intercom admin identifier.
  - name: name
    expr: stg_intercom__list_admins.name
    semantic_role: categorical
    description: Admin display name.
  - name: email
    expr: stg_intercom__list_admins.email
    semantic_role: categorical
    tags:
      - pii
    description: Admin email address.
  - name: has_inbox_seat
    expr: stg_intercom__list_admins.has_inbox_seat
    semantic_role: categorical
    description: Whether the admin has inbox access.
  - name: conversation_count
    expr: COALESCE(stg_intercom__list_conversations.conversation_count, 0)
    semantic_role: measure
    description: Total number of conversations assigned to the admin.
  - name: open_conversation_count
    expr: COALESCE(stg_intercom__list_conversations.open_conversation_count, 0)
    semantic_role: measure
    description: Count of open conversations assigned to the admin.
  - name: closed_conversation_count
    expr: COALESCE(stg_intercom__list_conversations.closed_conversation_count, 0)
    semantic_role: measure
    description: Count of closed conversations assigned to the admin.
tags:
  - intercom
  - support
  - admins
trust_tier: gold
materialization:
  type: table

### intercom\_\_contacts

spec_version: '0.2'
name: intercom__contacts
type: model
description: Contact detail from Intercom.
grain: contact_id
source:
  ref: stg_intercom__list_contacts
columns:
  - name: contact_id
    expr: stg_intercom__list_contacts.list_contact_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Intercom contact identifier.
  - name: email
    expr: stg_intercom__list_contacts.email
    semantic_role: categorical
    tags:
      - pii
    description: Contact email address.
  - name: name
    expr: stg_intercom__list_contacts.name
    semantic_role: categorical
    description: Contact display name.
  - name: phone
    expr: stg_intercom__list_contacts.phone
    semantic_role: categorical
    tags:
      - pii
    description: Contact phone number.
  - name: role
    expr: stg_intercom__list_contacts.role
    semantic_role: categorical
    description: Contact role (user or lead).
  - name: owner_id
    expr: stg_intercom__list_contacts.owner_id
    semantic_role: entity_id
    description: Admin ID of the contact owner.
  - name: created_at
    expr: stg_intercom__list_contacts.created_at
    semantic_role: event_timestamp
    description: Timestamp when the contact was created.
  - name: last_seen_at
    expr: stg_intercom__list_contacts.last_seen_at
    semantic_role: event_timestamp
    description: Timestamp when the contact was last seen.
tags:
  - intercom
  - support
  - contacts
trust_tier: gold
materialization:
  type: table

### intercom\_\_conversation_volume_summary

spec_version: '0.2'
name: intercom__conversation_volume_summary
type: model
description: Conversation counts by state and admin from Intercom.
grain:
  - state
  - admin_assignee_id
source:
  ref: stg_intercom__list_conversations
columns:
  - name: state
    expr: stg_intercom__list_conversations.state
    primary_key: true
    semantic_role: categorical
    description: Conversation state such as open, closed, or snoozed.
  - name: admin_assignee_id
    expr: stg_intercom__list_conversations.admin_assignee_id
    primary_key: true
    semantic_role: entity_id
    description: Admin assigned to the conversations in the group.
  - name: conversation_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of conversations in the state and admin bucket.
group_by:
  - state
  - admin_assignee_id
tags:
  - intercom
  - support
  - conversations
trust_tier: gold
materialization:
  type: table

### intercom\_\_conversations

spec_version: '0.2'
name: intercom__conversations
type: model
description: Conversation detail with admin context from Intercom.
grain: conversation_id
source:
  ref: stg_intercom__list_conversations
joins:
  - ref: stg_intercom__list_admins
    type: left
    on: stg_intercom__list_conversations.admin_assignee_id = stg_intercom__list_admins.list_admin_id
columns:
  - name: conversation_id
    expr: stg_intercom__list_conversations.list_conversation_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Intercom conversation identifier.
  - name: title
    expr: stg_intercom__list_conversations.title
    semantic_role: categorical
    description: Conversation title or subject.
  - name: state
    expr: stg_intercom__list_conversations.state
    semantic_role: categorical
    description: Conversation state such as open, closed, or snoozed.
  - name: admin_assignee_id
    expr: stg_intercom__list_conversations.admin_assignee_id
    semantic_role: entity_id
    description: Admin assigned to the conversation.
  - name: admin_name
    expr: stg_intercom__list_admins.name
    semantic_role: categorical
    description: Name of the admin assigned to the conversation.
  - name: priority
    expr: stg_intercom__list_conversations.priority
    semantic_role: categorical
    description: Whether the conversation is marked as priority.
  - name: created_at
    expr: stg_intercom__list_conversations.created_at
    semantic_role: event_timestamp
    description: Timestamp when the conversation was created.
  - name: updated_at
    expr: stg_intercom__list_conversations.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the conversation was last updated.
tags:
  - intercom
  - support
  - conversations
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: intercom_conversation_count
description: Number of Intercom conversations.
model: intercom__conversations
expression: COUNT({intercom__conversations}.conversation_id)
synonyms: [conversations, support conversations, conversation volume]
tags: [intercom, support, conversations]
spec_version: '0.2'
type: metric
name: intercom_open_conversation_count
description: Number of Intercom conversations in the open state.
model: intercom__conversations
expression: SUM(CASE WHEN {intercom__conversations}.state = 'open' THEN 1 ELSE 0 END)
synonyms: [open conversations, unresolved conversations, open support threads]
tags: [intercom, support, conversations]
spec_version: '0.2'
type: metric
name: intercom_priority_conversation_count
description: Number of Intercom conversations marked as priority.
model: intercom__conversations
expression: SUM(CASE WHEN {intercom__conversations}.priority THEN 1 ELSE 0 END)
synonyms: [priority conversations, urgent conversations, priority support threads]
tags: [intercom, support, conversations]

## Relationships

spec_version: '0.2'
type: relationship
name: intercom_conversations_to_admins
description: Each Intercom conversation can be assigned to one admin.
left_model: intercom__conversations
right_model: intercom__admins
join_columns:
  - left: admin_assignee_id
    right: admin_id
join_type: left
relationship_type: many_to_one
tags: [intercom, conversations, admins]
spec_version: '0.2'
type: relationship
name: intercom_contacts_to_admins
description: Each Intercom contact can belong to one admin owner.
left_model: intercom__contacts
right_model: intercom__admins
join_columns:
  - left: owner_id
    right: admin_id
join_type: left
relationship_type: many_to_one
tags: [intercom, contacts, admins]
