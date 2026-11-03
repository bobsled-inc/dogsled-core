---
name: starter-models-gong
description: Curated starter analytics models, metrics, and relationships for
  Gong revenue intelligence. Pairs with the starter-data-models overview; adapt
  the bundle to the user's actually-loaded tables.
---

# Starter data models — Gong

Revenue intelligence analytics models for Gong calls, meetings, and users.

These are the **gold marts** for Gong — the canonical analytics
tables an analyst would build on top of the loaded Gong extract. Each
mart references a silver staging model named `stg_gong__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### gong\_\_call_activity_summary

spec_version: '0.2'
name: gong__call_activity_summary
type: model
description: Call counts and average duration summarized by user and direction.
grain:
  - user_id
  - direction
source:
  ref: stg_gong__calls
columns:
  - name: user_id
    expr: stg_gong__calls.primary_user_id
    primary_key: true
    semantic_role: entity_id
    description: User associated with the calls.
  - name: direction
    expr: stg_gong__calls.direction
    primary_key: true
    semantic_role: categorical
    description: Call direction (inbound or outbound).
  - name: call_count
    expr: COUNT(*)
    semantic_role: measure
    description: Total calls in the user and direction bucket.
  - name: avg_duration
    expr: AVG(stg_gong__calls.duration)
    semantic_role: measure
    description: Average call duration in seconds for the bucket.
group_by:
  - user_id
  - direction
tags:
  - gong
  - calls
  - activity
trust_tier: gold
materialization:
  type: table

### gong\_\_calls

spec_version: '0.2'
name: gong__calls
type: model
description: Enriched Gong calls with user context.
grain: call_id
source:
  ref: stg_gong__calls
joins:
  - ref: stg_gong__users
    type: left
    on: stg_gong__calls.primary_user_id = stg_gong__users.user_id
columns:
  - name: call_id
    expr: stg_gong__calls.call_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Gong call identifier.
  - name: title
    expr: stg_gong__calls.title
    semantic_role: categorical
    description: Title of the call.
  - name: started_at
    expr: stg_gong__calls.started_at
    semantic_role: event_timestamp
    description: Timestamp when the call started.
  - name: duration
    expr: stg_gong__calls.duration
    semantic_role: measure
    description: Call duration in seconds.
  - name: direction
    expr: stg_gong__calls.direction
    semantic_role: categorical
    description: Call direction (inbound or outbound).
  - name: user_id
    expr: stg_gong__calls.primary_user_id
    semantic_role: entity_id
    references: stg_gong__users.user_id
    description: User associated with the call.
  - name: user_name
    expr: CONCAT(stg_gong__users.first_name, ' ', stg_gong__users.last_name)
    semantic_role: categorical
    tags:
      - pii
    description: Name of the user on the call.
  - name: user_email
    expr: stg_gong__users.email
    semantic_role: categorical
    tags:
      - pii
    description: Email of the user on the call.
tags:
  - gong
  - calls
trust_tier: gold
materialization:
  type: table

### gong\_\_meetings

spec_version: '0.2'
name: gong__meetings
type: model
description: Enriched Gong meetings with organizer context.
grain: meeting_id
source:
  ref: stg_gong__meetings
joins:
  - ref: stg_gong__users
    type: left
    on: stg_gong__meetings.organizer_id = stg_gong__users.user_id
columns:
  - name: meeting_id
    expr: stg_gong__meetings.meeting_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Gong meeting identifier.
  - name: title
    expr: stg_gong__meetings.title
    semantic_role: categorical
    description: Title of the meeting.
  - name: start_time
    expr: stg_gong__meetings.start_time
    semantic_role: event_timestamp
    description: Timestamp when the meeting starts.
  - name: end_time
    expr: stg_gong__meetings.end_time
    semantic_role: event_timestamp
    description: Timestamp when the meeting ends.
  - name: organizer_user_id
    expr: stg_gong__meetings.organizer_id
    semantic_role: entity_id
    references: stg_gong__users.user_id
    description: User ID of the meeting organizer.
  - name: organizer_name
    expr: CONCAT(stg_gong__users.first_name, ' ', stg_gong__users.last_name)
    semantic_role: categorical
    tags:
      - pii
    description: Name of the meeting organizer.
  - name: organizer_email
    expr: stg_gong__users.email
    semantic_role: categorical
    tags:
      - pii
    description: Email of the meeting organizer.
  - name: source
    expr: stg_gong__meetings.source
    semantic_role: categorical
    description: Source system for the meeting.
tags:
  - gong
  - meetings
trust_tier: gold
materialization:
  type: table

### gong\_\_users

spec_version: '0.2'
name: gong__users
type: model
description: User detail with call and meeting rollups.
grain: user_id
source:
  ref: stg_gong__users
joins:
  - ref: stg_gong__calls
    type: left
    on: stg_gong__users.user_id = stg_gong__calls.primary_user_id
    pre_aggregate:
      group_by:
        - primary_user_id
      columns:
        - name: call_count
          expr: COUNT(*)
        - name: avg_call_duration
          expr: AVG(duration)
  - ref: stg_gong__meetings
    type: left
    on: stg_gong__users.user_id = stg_gong__meetings.organizer_id
    pre_aggregate:
      group_by:
        - organizer_id
      columns:
        - name: meeting_count
          expr: COUNT(*)
columns:
  - name: user_id
    expr: stg_gong__users.user_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Gong user identifier.
  - name: name
    expr: CONCAT(stg_gong__users.first_name, ' ', stg_gong__users.last_name)
    semantic_role: categorical
    tags:
      - pii
    description: User display name.
  - name: email
    expr: stg_gong__users.email
    semantic_role: categorical
    tags:
      - pii
    description: User email address.
  - name: title
    expr: stg_gong__users.title
    semantic_role: categorical
    description: User job title.
  - name: call_count
    expr: COALESCE(stg_gong__calls.call_count, 0)
    semantic_role: measure
    description: Number of calls associated with the user.
  - name: avg_call_duration
    expr: stg_gong__calls.avg_call_duration
    semantic_role: measure
    description: Average call duration in seconds.
  - name: meeting_count
    expr: COALESCE(stg_gong__meetings.meeting_count, 0)
    semantic_role: measure
    description: Number of meetings organized by the user.
tags:
  - gong
  - users
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: gong_call_count
description: Number of Gong calls.
model: gong__calls
expression: COUNT({gong__calls}.call_id)
synonyms: [calls, recorded calls, call volume]
tags: [gong, revenue, calls]
spec_version: '0.2'
type: metric
name: gong_total_call_duration
description: Total duration of Gong calls in seconds.
model: gong__calls
expression: SUM({gong__calls}.duration)
synonyms: [call duration, talk time, total call time]
tags: [gong, revenue, calls]
spec_version: '0.2'
type: metric
name: gong_meeting_count
description: Number of Gong meetings.
model: gong__meetings
expression: COUNT({gong__meetings}.meeting_id)
synonyms: [meetings, meeting count, number of meetings]
tags: [gong, revenue, meetings]

## Relationships

spec_version: '0.2'
type: relationship
name: gong_calls_to_users
description: Each Gong call belongs to one primary user.
left_model: gong__calls
right_model: gong__users
join_columns:
  - left: user_id
    right: user_id
join_type: left
relationship_type: many_to_one
tags: [gong, calls, users]
spec_version: '0.2'
type: relationship
name: gong_meetings_to_users
description: Each Gong meeting belongs to one organizer.
left_model: gong__meetings
right_model: gong__users
join_columns:
  - left: organizer_user_id
    right: user_id
join_type: left
relationship_type: many_to_one
tags: [gong, meetings, users]
