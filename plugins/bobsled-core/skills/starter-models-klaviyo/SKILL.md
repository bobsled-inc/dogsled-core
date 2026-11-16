---
name: starter-models-klaviyo
description: Curated starter analytics models, metrics, and relationships for
  Klaviyo marketing. Pairs with the starter-data-models overview; adapt the
  bundle to the user's actually-loaded tables.
---

# Starter data models — Klaviyo

Email and SMS marketing analytics models for Klaviyo campaigns, flows, profiles, and events.

These are the **gold marts** for Klaviyo — the canonical analytics
tables an analyst would build on top of the loaded Klaviyo extract. Each
mart references a silver staging model named `stg_klaviyo__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### klaviyo\_\_campaign_performance_summary

spec_version: '0.2'
name: klaviyo__campaign_performance_summary
type: model
description: Klaviyo campaign counts summarized by status and type.
grain:
  - status
  - type
source:
  ref: stg_klaviyo__campaigns
columns:
  - name: status
    expr: stg_klaviyo__campaigns.status
    primary_key: true
    semantic_role: categorical
    description: Campaign status.
  - name: type
    expr: stg_klaviyo__campaigns.type
    primary_key: true
    semantic_role: categorical
    description: Campaign type (email or sms).
  - name: campaign_count
    expr: COUNT(*)
    semantic_role: measure
    description: Total campaigns in the status and type bucket.
group_by:
  - status
  - type
tags:
  - klaviyo
  - marketing
  - campaigns
trust_tier: gold
materialization:
  type: table

### klaviyo\_\_campaigns

spec_version: '0.2'
name: klaviyo__campaigns
type: model
description: Klaviyo campaign detail with status and lifecycle timestamps.
grain: campaign_id
source:
  ref: stg_klaviyo__campaigns
columns:
  - name: campaign_id
    expr: stg_klaviyo__campaigns.campaign_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Klaviyo campaign identifier.
  - name: name
    expr: stg_klaviyo__campaigns.name
    semantic_role: categorical
    description: Campaign name.
  - name: status
    expr: stg_klaviyo__campaigns.status
    semantic_role: categorical
    description: Current campaign status.
  - name: type
    expr: stg_klaviyo__campaigns.type
    semantic_role: categorical
    description: Campaign type (email or sms).
  - name: created_at
    expr: stg_klaviyo__campaigns.created_at
    semantic_role: event_timestamp
    description: Timestamp when the campaign was created.
  - name: updated_at
    expr: stg_klaviyo__campaigns.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the campaign was last updated.
tags:
  - klaviyo
  - marketing
  - campaigns
trust_tier: gold
materialization:
  type: table

### klaviyo\_\_events

spec_version: '0.2'
name: klaviyo__events
type: model
description: Klaviyo event detail with profile context.
grain: event_id
source:
  ref: stg_klaviyo__events
joins:
  - ref: stg_klaviyo__profiles
    type: left
    on: stg_klaviyo__events.profile_id = stg_klaviyo__profiles.profile_id
columns:
  - name: event_id
    expr: stg_klaviyo__events.event_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Klaviyo event identifier.
  - name: event_type
    expr: stg_klaviyo__events.type
    semantic_role: categorical
    description: Type of the tracked event.
  - name: metric_id
    expr: stg_klaviyo__events.metric_id
    semantic_role: entity_id
    description: Klaviyo metric associated with the event.
  - name: profile_id
    expr: stg_klaviyo__events.profile_id
    semantic_role: entity_id
    references: stg_klaviyo__profiles.profile_id
    description: Profile that triggered the event.
  - name: profile_email
    expr: stg_klaviyo__profiles.email
    semantic_role: categorical
    tags:
      - pii
    description: Email of the profile that triggered the event.
  - name: profile_first_name
    expr: stg_klaviyo__profiles.first_name
    semantic_role: categorical
    tags:
      - pii
    description: First name of the profile.
  - name: profile_last_name
    expr: stg_klaviyo__profiles.last_name
    semantic_role: categorical
    tags:
      - pii
    description: Last name of the profile.
  - name: occurred_at
    expr: stg_klaviyo__events.time
    semantic_role: event_timestamp
    description: Timestamp when the event occurred.
  - name: value
    expr: stg_klaviyo__events.value
    semantic_role: measure
    description: Numeric value associated with the event.
tags:
  - klaviyo
  - marketing
  - events
trust_tier: gold
materialization:
  type: table

### klaviyo\_\_flows

spec_version: '0.2'
name: klaviyo__flows
type: model
description: Klaviyo flow detail with status and timing.
grain: flow_id
source:
  ref: stg_klaviyo__flows
columns:
  - name: flow_id
    expr: stg_klaviyo__flows.flow_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Klaviyo flow identifier.
  - name: name
    expr: stg_klaviyo__flows.name
    semantic_role: categorical
    description: Flow name.
  - name: status
    expr: stg_klaviyo__flows.status
    semantic_role: categorical
    description: Current flow status (live, draft, or manual).
  - name: type
    expr: stg_klaviyo__flows.type
    semantic_role: categorical
    description: Flow trigger type.
  - name: created_at
    expr: stg_klaviyo__flows.created_at
    semantic_role: event_timestamp
    description: Timestamp when the flow was created.
  - name: updated_at
    expr: stg_klaviyo__flows.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the flow was last updated.
tags:
  - klaviyo
  - marketing
  - flows
trust_tier: gold
materialization:
  type: table

### klaviyo\_\_profiles

spec_version: '0.2'
name: klaviyo__profiles
type: model
description: Klaviyo profile detail.
grain: profile_id
source:
  ref: stg_klaviyo__profiles
columns:
  - name: profile_id
    expr: stg_klaviyo__profiles.profile_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Klaviyo profile identifier.
  - name: email
    expr: stg_klaviyo__profiles.email
    semantic_role: categorical
    tags:
      - pii
    description: Profile email address.
  - name: first_name
    expr: stg_klaviyo__profiles.first_name
    semantic_role: categorical
    tags:
      - pii
    description: Profile first name.
  - name: last_name
    expr: stg_klaviyo__profiles.last_name
    semantic_role: categorical
    tags:
      - pii
    description: Profile last name.
  - name: created_at
    expr: stg_klaviyo__profiles.created_at
    semantic_role: event_timestamp
    description: Timestamp when the profile was created.
  - name: updated_at
    expr: stg_klaviyo__profiles.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the profile was last updated.
tags:
  - klaviyo
  - marketing
  - profiles
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: klaviyo_event_count
description: Number of Klaviyo events.
model: klaviyo__events
expression: COUNT({klaviyo__events}.event_id)
synonyms: [events, event volume, tracked events]
tags: [klaviyo, marketing, events]
spec_version: '0.2'
type: metric
name: klaviyo_campaign_count
description: Number of Klaviyo campaigns.
model: klaviyo__campaigns
expression: COUNT({klaviyo__campaigns}.campaign_id)
synonyms: [campaigns, campaign count, marketing campaigns]
tags: [klaviyo, marketing, campaigns]
spec_version: '0.2'
type: metric
name: klaviyo_profile_count
description: Number of Klaviyo profiles.
model: klaviyo__profiles
expression: COUNT({klaviyo__profiles}.profile_id)
synonyms: [profiles, customer profiles, audience size]
tags: [klaviyo, marketing, profiles]

## Relationships

spec_version: '0.2'
type: relationship
name: klaviyo_events_to_profiles
description: Each Klaviyo event can belong to one profile.
left_model: klaviyo__events
right_model: klaviyo__profiles
join_columns:
  - left: profile_id
    right: profile_id
join_type: left
relationship_type: many_to_one
tags: [klaviyo, events, profiles]
