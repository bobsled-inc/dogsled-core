---
name: starter-models-freshdesk
description: Curated starter analytics models, metrics, and relationships for
  Freshdesk support operations. Pairs with the starter-data-models overview;
  adapt the bundle to the user's actually-loaded tables.
---

# Starter data models — Freshdesk

Support analytics models for Freshdesk tickets, contacts, agents, companies, and conversation activity.

These are the **gold marts** for Freshdesk — the canonical analytics
tables an analyst would build on top of the loaded Freshdesk extract. Each
mart references a silver staging model named `stg_freshdesk__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### freshdesk\_\_agents

spec_version: '0.2'
name: freshdesk__agents
type: model
description: Freshdesk agents enriched with assigned-ticket counts.
grain: agent_id
source:
  ref: stg_freshdesk__agents
joins:
  - ref: stg_freshdesk__tickets
    type: left
    on: stg_freshdesk__agents.agent_id = stg_freshdesk__tickets.responder_id
    pre_aggregate:
      group_by:
        - responder_id
      columns:
        - name: assigned_ticket_count
          expr: COUNT(*)
        - name: latest_assigned_ticket_at
          expr: MAX(created_at)
columns:
  - name: agent_id
    expr: stg_freshdesk__agents.agent_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Freshdesk agent identifier.
  - name: contact_email
    expr: stg_freshdesk__agents.contact_email
    semantic_role: categorical
    tags:
      - pii
    description: Agent email address.
  - name: available
    expr: stg_freshdesk__agents.available
    semantic_role: categorical
    description: Whether the agent is currently available.
  - name: occasional
    expr: stg_freshdesk__agents.occasional
    semantic_role: categorical
    description: Whether the agent is marked as occasional.
  - name: active
    expr: stg_freshdesk__agents.active
    semantic_role: categorical
    description: Whether the agent is active.
  - name: ticket_scope
    expr: stg_freshdesk__agents.ticket_scope
    semantic_role: categorical
    description: Numeric scope code for ticket visibility.
  - name: assigned_ticket_count
    expr: COALESCE(stg_freshdesk__tickets.assigned_ticket_count, 0)
    semantic_role: measure
    description: Number of tickets assigned to the agent.
  - name: latest_assigned_ticket_at
    expr: stg_freshdesk__tickets.latest_assigned_ticket_at
    semantic_role: event_timestamp
    description: Timestamp of the most recent ticket assigned to the agent.
  - name: created_at
    expr: stg_freshdesk__agents.created_at
    semantic_role: event_timestamp
    description: Timestamp when the agent record was created.
  - name: updated_at
    expr: stg_freshdesk__agents.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the agent record was last updated.
tags:
  - freshdesk
  - agents
  - support
trust_tier: gold
materialization:
  type: table

### freshdesk\_\_companies

spec_version: '0.2'
name: freshdesk__companies
type: model
description: Freshdesk companies enriched with contact counts.
grain: company_id
source:
  ref: stg_freshdesk__companies
joins:
  - ref: stg_freshdesk__contacts
    type: left
    on: stg_freshdesk__companies.company_id = stg_freshdesk__contacts.company_id
    pre_aggregate:
      group_by:
        - company_id
      columns:
        - name: contact_count
          expr: COUNT(*)
        - name: active_contact_count
          expr: countif(active = TRUE)
columns:
  - name: company_id
    expr: stg_freshdesk__companies.company_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Freshdesk company identifier.
  - name: company_name
    expr: stg_freshdesk__companies.name
    semantic_role: categorical
    description: Company name.
  - name: description
    expr: stg_freshdesk__companies.description
    semantic_role: categorical
    description: Company description.
  - name: note
    expr: stg_freshdesk__companies.note
    semantic_role: categorical
    description: Internal note stored on the company.
  - name: domains
    expr: stg_freshdesk__companies.domains
    semantic_role: categorical
    description: Domains associated with the company.
  - name: contact_count
    expr: COALESCE(stg_freshdesk__contacts.contact_count, 0)
    semantic_role: measure
    description: Number of contacts linked to the company.
  - name: active_contact_count
    expr: COALESCE(stg_freshdesk__contacts.active_contact_count, 0)
    semantic_role: measure
    description: Number of active contacts linked to the company.
  - name: created_at
    expr: stg_freshdesk__companies.created_at
    semantic_role: event_timestamp
    description: Timestamp when the company was created.
  - name: updated_at
    expr: stg_freshdesk__companies.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the company was last updated.
tags:
  - freshdesk
  - companies
  - support
trust_tier: gold
materialization:
  type: table

### freshdesk\_\_contacts

spec_version: '0.2'
name: freshdesk__contacts
type: model
description: Freshdesk contacts enriched with company context and ticket counts.
grain: contact_id
source:
  ref: stg_freshdesk__contacts
joins:
  - ref: stg_freshdesk__companies
    type: left
    on: stg_freshdesk__contacts.company_id = stg_freshdesk__companies.company_id
  - ref: stg_freshdesk__tickets
    type: left
    on: stg_freshdesk__contacts.contact_id = stg_freshdesk__tickets.requester_id
    pre_aggregate:
      group_by:
        - requester_id
      columns:
        - name: ticket_count
          expr: COUNT(*)
columns:
  - name: contact_id
    expr: stg_freshdesk__contacts.contact_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Freshdesk contact identifier.
  - name: contact_name
    expr: stg_freshdesk__contacts.name
    semantic_role: categorical
    description: Contact full name.
  - name: email
    expr: stg_freshdesk__contacts.email
    semantic_role: categorical
    tags:
      - pii
    description: Contact email address.
  - name: phone
    expr: stg_freshdesk__contacts.phone
    semantic_role: categorical
    tags:
      - pii
    description: Contact phone number.
  - name: company_id
    expr: stg_freshdesk__contacts.company_id
    semantic_role: entity_id
    references: stg_freshdesk__companies.company_id
    description: Company associated with the contact.
  - name: company_name
    expr: stg_freshdesk__companies.name
    semantic_role: categorical
    description: Name of the associated company.
  - name: active
    expr: stg_freshdesk__contacts.active
    semantic_role: categorical
    description: Whether the contact is active.
  - name: ticket_count
    expr: COALESCE(stg_freshdesk__tickets.ticket_count, 0)
    semantic_role: measure
    description: Number of tickets requested by the contact.
  - name: created_at
    expr: stg_freshdesk__contacts.created_at
    semantic_role: event_timestamp
    description: Timestamp when the contact was created.
  - name: updated_at
    expr: stg_freshdesk__contacts.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the contact was last updated.
tags:
  - freshdesk
  - contacts
  - support
trust_tier: gold
materialization:
  type: table

### freshdesk\_\_conversations

spec_version: '0.2'
name: freshdesk__conversations
type: model
description: Freshdesk conversation activity with channel and attachment counts.
grain: conversation_id
source:
  ref: stg_freshdesk__conversations
columns:
  - name: conversation_id
    expr: stg_freshdesk__conversations.conversation_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Freshdesk conversation identifier.
  - name: incoming
    expr: stg_freshdesk__conversations.incoming
    semantic_role: categorical
    description: Whether the conversation is incoming from the requester.
  - name: private
    expr: stg_freshdesk__conversations.private
    semantic_role: categorical
    description: Whether the conversation is private to agents.
  - name: user_id
    expr: stg_freshdesk__conversations.user_id
    semantic_role: entity_id
    description: Agent or contact identifier that authored the conversation.
  - name: support_email
    expr: stg_freshdesk__conversations.support_email
    semantic_role: categorical
    description: Support mailbox used for the conversation.
  - name: source
    expr: stg_freshdesk__conversations.source
    semantic_role: categorical
    description: Numeric source channel code for the conversation.
  - name: from_email
    expr: stg_freshdesk__conversations.from_email
    semantic_role: categorical
    tags:
      - pii
    description: Sender email address.
  - name: body_text
    expr: stg_freshdesk__conversations.body_text
    semantic_role: categorical
    description: Plain-text body of the conversation.
  - name: recipient_count
    expr: array_size(stg_freshdesk__conversations.to_emails)
    semantic_role: measure
    description: Number of direct recipients on the conversation.
  - name: cc_count
    expr: array_size(stg_freshdesk__conversations.cc_emails)
    semantic_role: measure
    description: Number of CC recipients on the conversation.
  - name: bcc_count
    expr: array_size(stg_freshdesk__conversations.bcc_emails)
    semantic_role: measure
    description: Number of BCC recipients on the conversation.
  - name: attachment_count
    expr: array_size(stg_freshdesk__conversations.attachments)
    semantic_role: measure
    description: Number of attachments on the conversation.
  - name: created_at
    expr: stg_freshdesk__conversations.created_at
    semantic_role: event_timestamp
    description: Timestamp when the conversation was created.
  - name: updated_at
    expr: stg_freshdesk__conversations.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the conversation was last updated.
tags:
  - freshdesk
  - conversations
  - support
trust_tier: gold
materialization:
  type: table

### freshdesk\_\_ticket_volume_summary

spec_version: '0.2'
name: freshdesk__ticket_volume_summary
type: model
description: Freshdesk ticket volume summarized by status and priority code.
grain:
  - status
  - priority
source:
  ref: stg_freshdesk__tickets
columns:
  - name: status
    expr: stg_freshdesk__tickets.status
    semantic_role: categorical
    description: Numeric Freshdesk ticket status code.
  - name: priority
    expr: stg_freshdesk__tickets.priority
    semantic_role: categorical
    description: Numeric Freshdesk ticket priority code.
  - name: ticket_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of tickets in the bucket.
  - name: assigned_ticket_count
    expr: countif(responder_id IS NOT NULL)
    semantic_role: measure
    description: Number of tickets in the bucket with an assigned responder.
group_by:
  - status
  - priority
tags:
  - freshdesk
  - tickets
  - summary
trust_tier: gold
materialization:
  type: table

### freshdesk\_\_tickets

spec_version: '0.2'
name: freshdesk__tickets
type: model
description: Freshdesk tickets enriched with requester, responder, and company context.
grain: ticket_id
source:
  ref: stg_freshdesk__tickets
joins:
  - ref: stg_freshdesk__contacts
    type: left
    on: stg_freshdesk__tickets.requester_id = stg_freshdesk__contacts.contact_id
  - ref: stg_freshdesk__agents
    type: left
    on: stg_freshdesk__tickets.responder_id = stg_freshdesk__agents.agent_id
  - ref: stg_freshdesk__companies
    type: left
    on: stg_freshdesk__contacts.company_id = stg_freshdesk__companies.company_id
columns:
  - name: ticket_id
    expr: stg_freshdesk__tickets.ticket_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Freshdesk ticket identifier.
  - name: subject
    expr: stg_freshdesk__tickets.subject
    semantic_role: categorical
    description: Ticket subject line.
  - name: status
    expr: stg_freshdesk__tickets.status
    semantic_role: categorical
    description: Numeric Freshdesk ticket status code.
  - name: priority
    expr: stg_freshdesk__tickets.priority
    semantic_role: categorical
    description: Numeric Freshdesk ticket priority code.
  - name: requester_id
    expr: stg_freshdesk__tickets.requester_id
    semantic_role: entity_id
    references: stg_freshdesk__contacts.contact_id
    description: Requester contact identifier.
  - name: requester_name
    expr: stg_freshdesk__contacts.name
    semantic_role: categorical
    description: Name of the requester contact.
  - name: requester_email
    expr: stg_freshdesk__contacts.email
    semantic_role: categorical
    tags:
      - pii
    description: Email of the requester contact.
  - name: responder_id
    expr: stg_freshdesk__tickets.responder_id
    semantic_role: entity_id
    references: stg_freshdesk__agents.agent_id
    description: Assigned Freshdesk agent identifier.
  - name: responder_email
    expr: stg_freshdesk__agents.contact_email
    semantic_role: categorical
    tags:
      - pii
    description: Email address of the assigned agent.
  - name: company_id
    expr: stg_freshdesk__contacts.company_id
    semantic_role: entity_id
    references: stg_freshdesk__companies.company_id
    description: Company associated with the requester contact.
  - name: company_name
    expr: stg_freshdesk__companies.name
    semantic_role: categorical
    description: Name of the associated company.
  - name: created_at
    expr: stg_freshdesk__tickets.created_at
    semantic_role: event_timestamp
    description: Timestamp when the ticket was created.
  - name: updated_at
    expr: stg_freshdesk__tickets.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the ticket was last updated.
tags:
  - freshdesk
  - tickets
  - support
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: freshdesk_ticket_count
description: Number of Freshdesk tickets.
model: freshdesk__tickets
expression: COUNT({freshdesk__tickets}.ticket_id)
synonyms: [tickets, ticket volume, number of tickets]
tags: [freshdesk, support, tickets]
spec_version: '0.2'
type: metric
name: freshdesk_conversation_count
description: Number of Freshdesk conversation messages.
model: freshdesk__conversations
expression: COUNT({freshdesk__conversations}.conversation_id)
synonyms: [conversations, replies, conversation messages]
tags: [freshdesk, support, conversations]
spec_version: '0.2'
type: metric
name: freshdesk_active_contact_count
description: Number of active Freshdesk contacts.
model: freshdesk__contacts
expression: SUM(CASE WHEN {freshdesk__contacts}.active THEN 1 ELSE 0 END)
synonyms: [active contacts, enabled contacts, contacts marked active]
tags: [freshdesk, support, contacts]

## Relationships

spec_version: '0.2'
type: relationship
name: freshdesk_contacts_to_companies
description: Each Freshdesk contact can belong to one company.
left_model: freshdesk__contacts
right_model: freshdesk__companies
join_columns:
  - left: company_id
    right: company_id
join_type: left
relationship_type: many_to_one
tags: [freshdesk, contacts, companies]
spec_version: '0.2'
type: relationship
name: freshdesk_tickets_to_companies
description: Each Freshdesk ticket can belong to one company.
left_model: freshdesk__tickets
right_model: freshdesk__companies
join_columns:
  - left: company_id
    right: company_id
join_type: left
relationship_type: many_to_one
tags: [freshdesk, tickets, companies]
