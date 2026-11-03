---
name: starter-models-pipedrive
description: Curated starter analytics models, metrics, and relationships for
  Pipedrive CRM. Pairs with the starter-data-models overview; adapt the bundle
  to the user's actually-loaded tables.
---

# Starter data models — Pipedrive

SMB CRM analytics models for Pipedrive deals, contacts, organizations, activities, and pipeline flow.

These are the **gold marts** for Pipedrive — the canonical analytics
tables an analyst would build on top of the loaded Pipedrive extract. Each
mart references a silver staging model named `stg_pipedrive__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### pipedrive\_\_activities

spec_version: '0.2'
name: pipedrive__activities
type: model
description: Pipedrive activities enriched with related deal, person, organization, and owner metadata.
grain: activity_id
source:
  ref: stg_pipedrive__get_activities
joins:
  - ref: stg_pipedrive__get_deals
    type: left
    on: stg_pipedrive__get_activities.deal_id = stg_pipedrive__get_deals.get_deal_id
  - ref: stg_pipedrive__get_persons
    type: left
    on: stg_pipedrive__get_activities.person_id = stg_pipedrive__get_persons.get_person_id
  - ref: stg_pipedrive__get_organizations
    type: left
    on: stg_pipedrive__get_activities.org_id = stg_pipedrive__get_organizations.get_organization_id
  - ref: stg_pipedrive__get_users
    type: left
    on: stg_pipedrive__get_activities.user_id = stg_pipedrive__get_users.get_user_id
columns:
  - name: activity_id
    expr: stg_pipedrive__get_activities.get_activity_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Pipedrive activity identifier.
  - name: subject
    expr: stg_pipedrive__get_activities.subject
    semantic_role: categorical
    description: Activity subject.
  - name: activity_type
    expr: stg_pipedrive__get_activities.type
    semantic_role: categorical
    description: Activity type.
  - name: done
    expr: stg_pipedrive__get_activities.done
    semantic_role: categorical
    description: Whether the activity is complete.
  - name: due_date
    expr: CAST(stg_pipedrive__get_activities.due_date AS DATE)
    semantic_role: time_dimension
    description: Due date for the activity.
  - name: deal_id
    expr: stg_pipedrive__get_activities.deal_id
    semantic_role: entity_id
    references: stg_pipedrive__get_deals.get_deal_id
    description: Related deal identifier.
  - name: deal_title
    expr: stg_pipedrive__get_deals.title
    semantic_role: categorical
    description: Title of the related deal.
  - name: person_id
    expr: stg_pipedrive__get_activities.person_id
    semantic_role: entity_id
    references: stg_pipedrive__get_persons.get_person_id
    description: Related person identifier.
  - name: person_name
    expr: stg_pipedrive__get_persons.name
    semantic_role: categorical
    description: Name of the related person.
  - name: organization_id
    expr: stg_pipedrive__get_activities.org_id
    semantic_role: entity_id
    references: stg_pipedrive__get_organizations.get_organization_id
    description: Related organization identifier.
  - name: organization_name
    expr: stg_pipedrive__get_organizations.name
    semantic_role: categorical
    description: Name of the related organization.
  - name: owner_user_id
    expr: stg_pipedrive__get_activities.user_id
    semantic_role: entity_id
    references: stg_pipedrive__get_users.get_user_id
    description: Owning user identifier.
  - name: owner_name
    expr: stg_pipedrive__get_users.name
    semantic_role: categorical
    description: Name of the owning user.
  - name: created_at
    expr: stg_pipedrive__get_activities.add_time
    semantic_role: event_timestamp
    description: Timestamp when the activity was created.
  - name: updated_at
    expr: stg_pipedrive__get_activities.update_time
    semantic_role: event_timestamp
    description: Timestamp when the activity was last updated.
tags:
  - pipedrive
  - activities
  - crm
trust_tier: gold
materialization:
  type: table

### pipedrive\_\_deals

spec_version: '0.2'
name: pipedrive__deals
type: model
description: Pipedrive deals enriched with stage, pipeline, contact, organization, and activity rollups.
grain: deal_id
source:
  ref: stg_pipedrive__get_deals
joins:
  - ref: stg_pipedrive__get_stages
    type: left
    on: stg_pipedrive__get_deals.stage_id = stg_pipedrive__get_stages.get_stage_id
  - ref: stg_pipedrive__get_pipelines
    type: left
    on: stg_pipedrive__get_deals.pipeline_id = stg_pipedrive__get_pipelines.get_pipeline_id
  - ref: stg_pipedrive__get_persons
    type: left
    on: stg_pipedrive__get_deals.person_id = stg_pipedrive__get_persons.get_person_id
  - ref: stg_pipedrive__get_organizations
    type: left
    on: stg_pipedrive__get_deals.org_id = stg_pipedrive__get_organizations.get_organization_id
  - ref: stg_pipedrive__get_activities
    type: left
    on: stg_pipedrive__get_deals.get_deal_id = stg_pipedrive__get_activities.deal_id
    pre_aggregate:
      group_by:
        - deal_id
      columns:
        - name: activity_count
          expr: COUNT(*)
        - name: completed_activity_count
          expr: countif(done = TRUE)
        - name: upcoming_activity_count
          expr: countif(done = FALSE)
  - ref: stg_pipedrive__get_notes
    type: left
    on: stg_pipedrive__get_deals.get_deal_id = stg_pipedrive__get_notes.deal_id
    pre_aggregate:
      group_by:
        - deal_id
      columns:
        - name: note_count
          expr: COUNT(*)
columns:
  - name: deal_id
    expr: stg_pipedrive__get_deals.get_deal_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Pipedrive deal identifier.
  - name: deal_title
    expr: stg_pipedrive__get_deals.title
    semantic_role: categorical
    description: Deal title.
  - name: status
    expr: stg_pipedrive__get_deals.status
    semantic_role: categorical
    description: Current deal status.
  - name: value
    expr: stg_pipedrive__get_deals.value
    semantic_role: measure
    tags:
      - financial
    description: Deal value in the default currency.
  - name: currency
    expr: stg_pipedrive__get_deals.currency
    semantic_role: categorical
    description: Currency used for the deal value.
  - name: stage_id
    expr: stg_pipedrive__get_deals.stage_id
    semantic_role: entity_id
    references: stg_pipedrive__get_stages.get_stage_id
    description: Stage the deal currently occupies.
  - name: stage_name
    expr: stg_pipedrive__get_stages.name
    semantic_role: categorical
    description: Pipeline stage name.
  - name: stage_probability
    expr: stg_pipedrive__get_stages.deal_probability
    semantic_role: measure
    description: Default win probability for the stage.
  - name: pipeline_id
    expr: stg_pipedrive__get_deals.pipeline_id
    semantic_role: entity_id
    references: stg_pipedrive__get_pipelines.get_pipeline_id
    description: Pipeline the deal belongs to.
  - name: pipeline_name
    expr: stg_pipedrive__get_pipelines.name
    semantic_role: categorical
    description: Pipeline name.
  - name: person_id
    expr: stg_pipedrive__get_deals.person_id
    semantic_role: entity_id
    references: stg_pipedrive__get_persons.get_person_id
    description: Related Pipedrive person.
  - name: person_name
    expr: stg_pipedrive__get_persons.name
    semantic_role: categorical
    description: Name of the related person.
  - name: organization_id
    expr: stg_pipedrive__get_deals.org_id
    semantic_role: entity_id
    references: stg_pipedrive__get_organizations.get_organization_id
    description: Related Pipedrive organization.
  - name: organization_name
    expr: stg_pipedrive__get_organizations.name
    semantic_role: categorical
    description: Name of the related organization.
  - name: activity_count
    expr: COALESCE(stg_pipedrive__get_activities.activity_count, 0)
    semantic_role: measure
    description: Number of activities linked to the deal.
  - name: completed_activity_count
    expr: COALESCE(stg_pipedrive__get_activities.completed_activity_count, 0)
    semantic_role: measure
    description: Number of completed activities linked to the deal.
  - name: upcoming_activity_count
    expr: COALESCE(stg_pipedrive__get_activities.upcoming_activity_count, 0)
    semantic_role: measure
    description: Number of incomplete activities linked to the deal.
  - name: note_count
    expr: COALESCE(stg_pipedrive__get_notes.note_count, 0)
    semantic_role: measure
    description: Number of notes linked to the deal.
  - name: created_at
    expr: stg_pipedrive__get_deals.add_time
    semantic_role: event_timestamp
    description: Timestamp when the deal was created.
  - name: updated_at
    expr: stg_pipedrive__get_deals.update_time
    semantic_role: event_timestamp
    description: Timestamp when the deal was last updated.
tags:
  - pipedrive
  - deals
  - crm
trust_tier: gold
materialization:
  type: table

### pipedrive\_\_organizations

spec_version: '0.2'
name: pipedrive__organizations
type: model
description: Pipedrive organizations enriched with contact, deal, and activity rollups.
grain: organization_id
source:
  ref: stg_pipedrive__get_organizations
joins:
  - ref: stg_pipedrive__get_users
    type: left
    on: stg_pipedrive__get_organizations.owner_id = stg_pipedrive__get_users.get_user_id
  - ref: stg_pipedrive__get_deals
    type: left
    on: stg_pipedrive__get_organizations.get_organization_id = stg_pipedrive__get_deals.org_id
    pre_aggregate:
      group_by:
        - org_id
      columns:
        - name: deal_count
          expr: COUNT(*)
        - name: open_deal_count
          expr: countif(status = 'open')
        - name: won_deal_count
          expr: countif(status = 'won')
        - name: lost_deal_count
          expr: countif(status = 'lost')
        - name: total_value
          expr: SUM(value)
  - ref: stg_pipedrive__get_persons
    type: left
    on: stg_pipedrive__get_organizations.get_organization_id = stg_pipedrive__get_persons.org_id
    pre_aggregate:
      group_by:
        - org_id
      columns:
        - name: contact_count
          expr: COUNT(*)
  - ref: stg_pipedrive__get_activities
    type: left
    on: stg_pipedrive__get_organizations.get_organization_id = stg_pipedrive__get_activities.org_id
    pre_aggregate:
      group_by:
        - org_id
      columns:
        - name: activity_count
          expr: COUNT(*)
        - name: completed_activity_count
          expr: countif(done = TRUE)
columns:
  - name: organization_id
    expr: stg_pipedrive__get_organizations.get_organization_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Pipedrive organization identifier.
  - name: organization_name
    expr: stg_pipedrive__get_organizations.name
    semantic_role: categorical
    description: Organization name.
  - name: owner_id
    expr: stg_pipedrive__get_organizations.owner_id
    semantic_role: entity_id
    references: stg_pipedrive__get_users.get_user_id
    description: Owning Pipedrive user identifier.
  - name: owner_name
    expr: stg_pipedrive__get_users.name
    semantic_role: categorical
    description: Name of the owning user.
  - name: owner_email
    expr: stg_pipedrive__get_users.email
    semantic_role: categorical
    tags:
      - pii
    description: Email of the owning user.
  - name: address
    expr: stg_pipedrive__get_organizations.address
    semantic_role: categorical
    description: Organization address.
  - name: visible_to
    expr: stg_pipedrive__get_organizations.visible_to
    semantic_role: categorical
    description: Visibility setting for the organization.
  - name: contact_count
    expr: COALESCE(stg_pipedrive__get_persons.contact_count, 0)
    semantic_role: measure
    description: Number of contacts linked to the organization.
  - name: deal_count
    expr: COALESCE(stg_pipedrive__get_deals.deal_count, 0)
    semantic_role: measure
    description: Number of deals linked to the organization.
  - name: open_deal_count
    expr: COALESCE(stg_pipedrive__get_deals.open_deal_count, 0)
    semantic_role: measure
    description: Number of open deals linked to the organization.
  - name: won_deal_count
    expr: COALESCE(stg_pipedrive__get_deals.won_deal_count, 0)
    semantic_role: measure
    description: Number of won deals linked to the organization.
  - name: lost_deal_count
    expr: COALESCE(stg_pipedrive__get_deals.lost_deal_count, 0)
    semantic_role: measure
    description: Number of lost deals linked to the organization.
  - name: total_value
    expr: COALESCE(stg_pipedrive__get_deals.total_value, 0)
    semantic_role: measure
    tags:
      - financial
    description: Total value of deals linked to the organization.
  - name: activity_count
    expr: COALESCE(stg_pipedrive__get_activities.activity_count, 0)
    semantic_role: measure
    description: Number of activities linked to the organization.
  - name: completed_activity_count
    expr: COALESCE(stg_pipedrive__get_activities.completed_activity_count, 0)
    semantic_role: measure
    description: Number of completed activities linked to the organization.
  - name: created_at
    expr: stg_pipedrive__get_organizations.add_time
    semantic_role: event_timestamp
    description: Timestamp when the organization was created.
  - name: updated_at
    expr: stg_pipedrive__get_organizations.update_time
    semantic_role: event_timestamp
    description: Timestamp when the organization was last updated.
tags:
  - pipedrive
  - organizations
  - crm
trust_tier: gold
materialization:
  type: table

### pipedrive\_\_persons

spec_version: '0.2'
name: pipedrive__persons
type: model
description: Pipedrive persons enriched with organization, owner, and activity context.
grain: person_id
source:
  ref: stg_pipedrive__get_persons
joins:
  - ref: stg_pipedrive__get_users
    type: left
    on: stg_pipedrive__get_persons.owner_id = stg_pipedrive__get_users.get_user_id
  - ref: stg_pipedrive__get_organizations
    type: left
    on: stg_pipedrive__get_persons.org_id = stg_pipedrive__get_organizations.get_organization_id
  - ref: stg_pipedrive__get_deals
    type: left
    on: stg_pipedrive__get_persons.get_person_id = stg_pipedrive__get_deals.person_id
    pre_aggregate:
      group_by:
        - person_id
      columns:
        - name: deal_count
          expr: COUNT(*)
        - name: open_deal_count
          expr: countif(status = 'open')
        - name: total_value
          expr: SUM(value)
  - ref: stg_pipedrive__get_activities
    type: left
    on: stg_pipedrive__get_persons.get_person_id = stg_pipedrive__get_activities.person_id
    pre_aggregate:
      group_by:
        - person_id
      columns:
        - name: activity_count
          expr: COUNT(*)
        - name: completed_activity_count
          expr: countif(done = TRUE)
  - ref: stg_pipedrive__get_notes
    type: left
    on: stg_pipedrive__get_persons.get_person_id = stg_pipedrive__get_notes.person_id
    pre_aggregate:
      group_by:
        - person_id
      columns:
        - name: note_count
          expr: COUNT(*)
columns:
  - name: person_id
    expr: stg_pipedrive__get_persons.get_person_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Pipedrive person identifier.
  - name: person_name
    expr: stg_pipedrive__get_persons.name
    semantic_role: categorical
    description: Person full name.
  - name: owner_id
    expr: stg_pipedrive__get_persons.owner_id
    semantic_role: entity_id
    references: stg_pipedrive__get_users.get_user_id
    description: Owning Pipedrive user identifier.
  - name: owner_name
    expr: stg_pipedrive__get_users.name
    semantic_role: categorical
    description: Name of the owning user.
  - name: owner_email
    expr: stg_pipedrive__get_users.email
    semantic_role: categorical
    tags:
      - pii
    description: Email of the owning user.
  - name: organization_id
    expr: stg_pipedrive__get_persons.org_id
    semantic_role: entity_id
    references: stg_pipedrive__get_organizations.get_organization_id
    description: Related organization identifier.
  - name: organization_name
    expr: stg_pipedrive__get_organizations.name
    semantic_role: categorical
    description: Name of the related organization.
  - name: phone
    expr: stg_pipedrive__get_persons.phone
    semantic_role: categorical
    tags:
      - pii
    description: Phone values attached to the person.
  - name: email
    expr: stg_pipedrive__get_persons.email
    semantic_role: categorical
    tags:
      - pii
    description: Email values attached to the person.
  - name: deal_count
    expr: COALESCE(stg_pipedrive__get_deals.deal_count, 0)
    semantic_role: measure
    description: Number of deals linked to the person.
  - name: open_deal_count
    expr: COALESCE(stg_pipedrive__get_deals.open_deal_count, 0)
    semantic_role: measure
    description: Number of open deals linked to the person.
  - name: total_value
    expr: COALESCE(stg_pipedrive__get_deals.total_value, 0)
    semantic_role: measure
    tags:
      - financial
    description: Total value of deals linked to the person.
  - name: activity_count
    expr: COALESCE(stg_pipedrive__get_activities.activity_count, 0)
    semantic_role: measure
    description: Number of activities linked to the person.
  - name: completed_activity_count
    expr: COALESCE(stg_pipedrive__get_activities.completed_activity_count, 0)
    semantic_role: measure
    description: Number of completed activities linked to the person.
  - name: note_count
    expr: COALESCE(stg_pipedrive__get_notes.note_count, 0)
    semantic_role: measure
    description: Number of notes linked to the person.
  - name: created_at
    expr: stg_pipedrive__get_persons.add_time
    semantic_role: event_timestamp
    description: Timestamp when the person was created.
  - name: updated_at
    expr: stg_pipedrive__get_persons.update_time
    semantic_role: event_timestamp
    description: Timestamp when the person was last updated.
tags:
  - pipedrive
  - persons
  - crm
trust_tier: gold
materialization:
  type: table

### pipedrive\_\_pipeline_summary

spec_version: '0.2'
name: pipedrive__pipeline_summary
type: model
description: Pipedrive deal summary by pipeline and stage.
grain:
  - pipeline_id
  - stage_id
source:
  ref: stg_pipedrive__get_deals
joins:
  - ref: stg_pipedrive__get_pipelines
    type: left
    on: stg_pipedrive__get_deals.pipeline_id = stg_pipedrive__get_pipelines.get_pipeline_id
  - ref: stg_pipedrive__get_stages
    type: left
    on: stg_pipedrive__get_deals.stage_id = stg_pipedrive__get_stages.get_stage_id
columns:
  - name: pipeline_id
    expr: stg_pipedrive__get_deals.pipeline_id
    semantic_role: entity_id
    references: stg_pipedrive__get_pipelines.get_pipeline_id
    description: Stable pipeline identifier.
  - name: pipeline_name
    expr: stg_pipedrive__get_pipelines.name
    semantic_role: categorical
    description: Pipeline name.
  - name: stage_id
    expr: stg_pipedrive__get_deals.stage_id
    semantic_role: entity_id
    references: stg_pipedrive__get_stages.get_stage_id
    description: Stable stage identifier.
  - name: stage_name
    expr: stg_pipedrive__get_stages.name
    semantic_role: categorical
    description: Stage name.
  - name: stage_order
    expr: stg_pipedrive__get_stages.order_nr
    semantic_role: categorical
    description: Display order of the stage within the pipeline.
  - name: deal_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of deals in the pipeline-stage bucket.
  - name: open_deal_count
    expr: countif(stg_pipedrive__get_deals.status = 'open')
    semantic_role: measure
    description: Number of open deals in the bucket.
  - name: won_deal_count
    expr: countif(stg_pipedrive__get_deals.status = 'won')
    semantic_role: measure
    description: Number of won deals in the bucket.
  - name: lost_deal_count
    expr: countif(stg_pipedrive__get_deals.status = 'lost')
    semantic_role: measure
    description: Number of lost deals in the bucket.
  - name: total_value
    expr: SUM(stg_pipedrive__get_deals.value)
    semantic_role: measure
    tags:
      - financial
    description: Total deal value in the bucket.
group_by:
  - pipeline_id
  - pipeline_name
  - stage_id
  - stage_name
  - stage_order
tags:
  - pipedrive
  - pipeline
  - summary
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: pipedrive_deal_count
description: Number of Pipedrive deals.
model: pipedrive__deals
expression: COUNT({pipedrive__deals}.deal_id)
synonyms: [deals, deal count, opportunities]
tags: [pipedrive, crm, pipeline]
spec_version: '0.2'
type: metric
name: pipedrive_total_deal_value
description: Total Pipedrive deal value. Group results by currency before comparing or combining values.
model: pipedrive__deals
expression: SUM({pipedrive__deals}.value)
synonyms: [pipeline value, deal value, total deal value]
tags: [pipedrive, crm, finance]
spec_version: '0.2'
type: metric
name: pipedrive_completed_activity_count
description: Number of completed Pipedrive activities.
model: pipedrive__activities
expression: SUM(CASE WHEN {pipedrive__activities}.done THEN 1 ELSE 0 END)
synonyms: [completed activities, finished activities, activities done]
tags: [pipedrive, crm, activity]

## Relationships

spec_version: '0.2'
type: relationship
name: pipedrive_activities_to_deals
description: Each Pipedrive activity can belong to one deal.
left_model: pipedrive__activities
right_model: pipedrive__deals
join_columns:
  - left: deal_id
    right: deal_id
join_type: left
relationship_type: many_to_one
tags: [pipedrive, activities, deals]
spec_version: '0.2'
type: relationship
name: pipedrive_deals_to_organizations
description: Each Pipedrive deal can belong to one organization.
left_model: pipedrive__deals
right_model: pipedrive__organizations
join_columns:
  - left: organization_id
    right: organization_id
join_type: left
relationship_type: many_to_one
tags: [pipedrive, deals, organizations]
