---
name: starter-models-pylon
description: Curated starter analytics models, metrics, and relationships for
  Pylon support and product feedback. Pairs with the starter-data-models
  overview; adapt the bundle to the user's actually-loaded tables.
---

# Starter data models — Pylon

Customer support and product feedback models for Pylon issues, feature requests, contacts, and tasks.

These are the **gold marts** for Pylon — the canonical analytics
tables an analyst would build on top of the loaded Pylon extract. Each
mart references a silver staging model named `stg_pylon__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### pylon\_\_contacts

spec_version: '0.2'
name: pylon__contacts
type: model
description: Customer contacts with account association.
grain: contact_id
source:
  ref: stg_pylon__contacts
columns:
  - name: contact_id
    expr: stg_pylon__contacts.contact_id
    primary_key: true
    semantic_role: entity_id
    description: Unique contact identifier.
  - name: name
    expr: stg_pylon__contacts.name
    semantic_role: categorical
    tags:
      - pii
    description: Contact display name.
  - name: email
    expr: stg_pylon__contacts.email
    semantic_role: categorical
    tags:
      - pii
    description: Contact email address.
  - name: account_id
    expr: stg_pylon__contacts.account_id
    semantic_role: entity_id
    description: Account ID the contact belongs to.
  - name: created_at
    expr: stg_pylon__contacts.created_at
    semantic_role: event_timestamp
    description: Timestamp when the contact was created.
  - name: updated_at
    expr: stg_pylon__contacts.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the contact was last updated.
tags:
  - pylon
  - contacts
trust_tier: gold
materialization:
  type: table

### pylon\_\_feature_request_pipeline

spec_version: '0.2'
name: pylon__feature_request_pipeline
type: model
description: Feature request pipeline health by status.
grain: request_status
source:
  ref: stg_pylon__feature_requests
columns:
  - name: request_status
    expr: stg_pylon__feature_requests.request_status
    semantic_role: categorical
    description: Feature request status (new, in_progress, closed, archived).
  - name: request_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of feature requests in this status.
  - name: total_evidence
    expr: SUM(stg_pylon__feature_requests.evidence_count)
    semantic_role: measure
    description: Total evidence items across requests in this status.
group_by:
  - request_status
tags:
  - pylon
  - feedback
  - summary
trust_tier: gold
materialization:
  type: table

### pylon\_\_feature_requests

spec_version: '0.2'
name: pylon__feature_requests
type: model
description: Customer feature requests with status and evidence tracking.
grain: feature_request_id
source:
  ref: stg_pylon__feature_requests
columns:
  - name: feature_request_id
    expr: stg_pylon__feature_requests.feature_request_id
    primary_key: true
    semantic_role: entity_id
    description: Unique feature request identifier.
  - name: title
    expr: stg_pylon__feature_requests.title
    semantic_role: categorical
    description: Feature request title.
  - name: description
    expr: stg_pylon__feature_requests.description
    semantic_role: categorical
    description: Feature request description.
  - name: request_status
    expr: stg_pylon__feature_requests.request_status
    semantic_role: categorical
    description: Status (new, in_progress, closed, archived, or custom slug).
  - name: evidence_count
    expr: stg_pylon__feature_requests.evidence_count
    semantic_role: measure
    description: Number of evidence items supporting the request.
  - name: created_at
    expr: stg_pylon__feature_requests.created_at
    semantic_role: event_timestamp
    description: Timestamp when the feature request was created.
  - name: updated_at
    expr: stg_pylon__feature_requests.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the feature request was last updated.
tags:
  - pylon
  - feedback
trust_tier: gold
materialization:
  type: table

### pylon\_\_issues

spec_version: '0.2'
name: pylon__issues
type: model
description: Support issues with state, priority, source, and account metadata.
grain: issue_id
source:
  ref: stg_pylon__issues
columns:
  - name: issue_id
    expr: stg_pylon__issues.issue_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Pylon issue identifier.
  - name: issue_number
    expr: stg_pylon__issues.issue_number
    semantic_role: categorical
    description: Human-readable issue number.
  - name: title
    expr: stg_pylon__issues.title
    semantic_role: categorical
    description: Issue title.
  - name: state
    expr: stg_pylon__issues.state
    semantic_role: categorical
    description: Issue state (new, waiting_on_you, waiting_on_customer, on_hold, closed).
  - name: priority
    expr: stg_pylon__issues.priority
    semantic_role: categorical
    description: Issue priority (urgent, high, medium, low).
  - name: type
    expr: stg_pylon__issues.type
    semantic_role: categorical
    description: Issue type (conversation or ticket).
  - name: source
    expr: stg_pylon__issues.source
    semantic_role: categorical
    description: Issue source channel (slack, email, chat_widget, api, etc.).
  - name: assignee_id
    expr: stg_pylon__issues.assignee_id
    semantic_role: entity_id
    description: User ID of the assignee.
  - name: team_id
    expr: stg_pylon__issues.team_id
    semantic_role: entity_id
    description: Team ID the issue belongs to.
  - name: account_id
    expr: stg_pylon__issues.account_id
    semantic_role: entity_id
    description: Account ID of the customer.
  - name: requester_id
    expr: stg_pylon__issues.requester_id
    semantic_role: entity_id
    description: Contact ID of the requester.
  - name: tags
    expr: stg_pylon__issues.tags
    semantic_role: categorical
    description: Tags assigned to the issue.
  - name: ticket_form_id
    expr: stg_pylon__issues.ticket_form_id
    semantic_role: entity_id
    description: Ticket form used to create the issue.
  - name: closed_at
    expr: stg_pylon__issues.closed_at
    semantic_role: event_timestamp
    description: Timestamp when the issue was closed.
  - name: created_at
    expr: stg_pylon__issues.created_at
    semantic_role: event_timestamp
    description: Timestamp when the issue was created.
  - name: updated_at
    expr: stg_pylon__issues.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the issue was last updated.
tags:
  - pylon
  - issues
trust_tier: gold
materialization:
  type: table

### pylon\_\_tasks

spec_version: '0.2'
name: pylon__tasks
type: model
description: Internal tasks linked to customer accounts and projects.
grain: task_id
source:
  ref: stg_pylon__tasks
columns:
  - name: task_id
    expr: stg_pylon__tasks.task_id
    primary_key: true
    semantic_role: entity_id
    description: Unique task identifier.
  - name: title
    expr: stg_pylon__tasks.title
    semantic_role: categorical
    description: Task title.
  - name: status
    expr: stg_pylon__tasks.status
    semantic_role: categorical
    description: Task status (not_started, in_progress, completed).
  - name: account_id
    expr: stg_pylon__tasks.account_id
    semantic_role: entity_id
    description: Account ID the task belongs to.
  - name: project_id
    expr: stg_pylon__tasks.project_id
    semantic_role: entity_id
    description: Project ID the task belongs to.
  - name: assignee_id
    expr: stg_pylon__tasks.assignee_id
    semantic_role: entity_id
    description: User ID of the task assignee.
  - name: milestone_id
    expr: stg_pylon__tasks.milestone_id
    semantic_role: entity_id
    description: Milestone ID the task belongs to.
  - name: due_date
    expr: stg_pylon__tasks.due_date
    semantic_role: time_dimension
    description: Task due date.
  - name: created_at
    expr: stg_pylon__tasks.created_at
    semantic_role: event_timestamp
    description: Timestamp when the task was created.
  - name: updated_at
    expr: stg_pylon__tasks.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the task was last updated.
tags:
  - pylon
  - tasks
trust_tier: gold
materialization:
  type: table

### pylon\_\_ticket_volume_summary

spec_version: '0.2'
name: pylon__ticket_volume_summary
type: model
description: Daily support ticket volume grouped by state.
grain:
  - state
  - created_date
source:
  ref: stg_pylon__issues
columns:
  - name: state
    expr: stg_pylon__issues.state
    primary_key: true
    semantic_role: categorical
    description: Issue state (new, waiting_on_you, waiting_on_customer, on_hold, closed).
  - name: created_date
    expr: CAST(stg_pylon__issues.created_at AS DATE)
    primary_key: true
    semantic_role: time_dimension
    description: Date the issue was created.
  - name: issue_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of issues created on this date with this state.
group_by:
  - state
  - created_date
tags:
  - pylon
  - issues
  - summary
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: pylon_issue_count
description: Number of Pylon issues.
model: pylon__issues
expression: COUNT({pylon__issues}.issue_id)
synonyms: [issues, support tickets, issue volume]
tags: [pylon, support, issues]
spec_version: '0.2'
type: metric
name: pylon_feature_request_count
description: Number of Pylon feature requests.
model: pylon__feature_requests
expression: COUNT({pylon__feature_requests}.feature_request_id)
synonyms: [feature requests, product requests, request count]
tags: [pylon, product, feedback]
spec_version: '0.2'
type: metric
name: pylon_feature_request_evidence_count
description: Total evidence attached to Pylon feature requests.
model: pylon__feature_requests
expression: SUM({pylon__feature_requests}.evidence_count)
synonyms: [request evidence, customer evidence, evidence count]
tags: [pylon, product, feedback]

## Relationships

spec_version: '0.2'
type: relationship
name: pylon_feature_requests_to_pipeline
description: Each Pylon feature request contributes to one status pipeline row.
left_model: pylon__feature_requests
right_model: pylon__feature_request_pipeline
join_columns:
  - left: request_status
    right: request_status
join_type: left
relationship_type: many_to_one
tags: [pylon, feature-requests, pipeline]
spec_version: '0.2'
type: relationship
name: pylon_issues_to_contacts
description: Each Pylon issue can belong to one requester contact.
left_model: pylon__issues
right_model: pylon__contacts
join_columns:
  - left: requester_id
    right: contact_id
join_type: left
relationship_type: many_to_one
tags: [pylon, issues, contacts]
