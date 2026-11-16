---
name: starter-models-slack
description: Curated starter analytics models, metrics, and relationships for
  Slack collaboration. Pairs with the starter-data-models overview; adapt the
  bundle to the user's actually-loaded tables.
---

# Starter data models — Slack

Communication analytics models for Slack channels, messages, users, and workspace activity.

These are the **gold marts** for Slack — the canonical analytics
tables an analyst would build on top of the loaded Slack extract. Each
mart references a silver staging model named `stg_slack__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### slack\_\_channel_activity_summary

spec_version: '0.2'
name: slack__channel_activity_summary
type: model
description: Top-level message volume summarized by channel and day for tracking workspace communication patterns.
grain:
  - channel_id
  - message_date
source:
  ref: stg_slack__messages
columns:
  - name: channel_id
    expr: stg_slack__messages.channel_id
    primary_key: true
    semantic_role: entity_id
    references: stg_slack__channels.channel_id
    description: Channel ID the messages belong to.
  - name: message_date
    expr: DATE(stg_slack__messages.ts)
    primary_key: true
    semantic_role: time_dimension
    description: Calendar date of the messages.
  - name: message_count
    expr: COUNT(*)
    semantic_role: measure
    description: Total number of top-level messages in the channel on that date.
  - name: distinct_user_count
    expr: count_distinct(stg_slack__messages.user_id)
    semantic_role: measure
    description: Number of distinct users who posted messages.
  - name: thread_parent_count
    expr: countif(stg_slack__messages.thread_ts = stg_slack__messages.ts)
    semantic_role: measure
    description: Number of thread-parent messages (messages that started a thread).
  - name: avg_text_length
    expr: AVG(LENGTH(stg_slack__messages.text))
    semantic_role: measure
    description: Average message text length in characters.
group_by:
  - channel_id
  - message_date
tags:
  - slack
  - messages
  - summary
trust_tier: gold
materialization:
  type: table

### slack\_\_channels

spec_version: '0.2'
name: slack__channels
type: model
description: Channel detail with membership and metadata for Slack workspace channels.
grain: channel_id
source:
  ref: stg_slack__channels
columns:
  - name: channel_id
    expr: stg_slack__channels.channel_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Slack channel identifier (e.g. C01ABC23DEF).
  - name: name
    expr: stg_slack__channels.name
    semantic_role: categorical
    description: Channel name without the # prefix.
  - name: is_private
    expr: stg_slack__channels.is_private
    semantic_role: categorical
    description: Whether the channel is private.
  - name: is_archived
    expr: stg_slack__channels.is_archived
    semantic_role: categorical
    description: Whether the channel has been archived.
  - name: is_general
    expr: stg_slack__channels.is_general
    semantic_role: categorical
    description: Whether this is the default #general channel.
  - name: is_channel
    expr: stg_slack__channels.is_channel
    semantic_role: categorical
    description: Whether this is a public channel.
  - name: is_group
    expr: stg_slack__channels.is_group
    semantic_role: categorical
    description: Whether this is a private channel (group).
  - name: is_im
    expr: stg_slack__channels.is_im
    semantic_role: categorical
    description: Whether this is a direct message conversation.
  - name: is_mpim
    expr: stg_slack__channels.is_mpim
    semantic_role: categorical
    description: Whether this is a group direct message.
  - name: num_members
    expr: stg_slack__channels.num_members
    semantic_role: measure
    description: Number of members in the channel.
  - name: creator_id
    expr: stg_slack__channels.creator_id
    semantic_role: entity_id
    references: stg_slack__users.user_id
    description: User ID of the channel creator.
  - name: topic
    expr: stg_slack__channels.topic
    semantic_role: categorical
    description: Current channel topic text.
  - name: purpose
    expr: stg_slack__channels.purpose
    semantic_role: categorical
    description: Current channel purpose text.
  - name: created_at
    expr: stg_slack__channels.created_at
    semantic_role: event_timestamp
    description: Timestamp when the channel was created.
  - name: updated_at
    expr: stg_slack__channels.updated_at
    semantic_role: event_timestamp
    description: Timestamp of the most recent channel update.
tags:
  - slack
  - channels
trust_tier: gold
materialization:
  type: table

### slack\_\_messages

spec_version: '0.2'
name: slack__messages
type: model
description: Top-level message detail with user and channel context for Slack workspace messages.
grain:
  - message_ts
  - channel_id
source:
  ref: stg_slack__messages
joins:
  - ref: stg_slack__users
    type: left
    on: stg_slack__messages.user_id = stg_slack__users.user_id
  - ref: stg_slack__channels
    type: left
    on: stg_slack__messages.channel_id = stg_slack__channels.channel_id
columns:
  - name: message_ts
    expr: stg_slack__messages.ts
    primary_key: true
    semantic_role: entity_id
    description: Message timestamp serving as the unique identifier within the channel.
  - name: channel_id
    expr: stg_slack__messages.channel_id
    primary_key: true
    semantic_role: entity_id
    references: stg_slack__channels.channel_id
    description: Channel ID the message belongs to.
  - name: channel_name
    expr: stg_slack__channels.name
    semantic_role: categorical
    description: Channel name from the joined channel record.
  - name: user_id
    expr: stg_slack__messages.user_id
    semantic_role: entity_id
    references: stg_slack__users.user_id
    description: User ID of the message author.
  - name: user_name
    expr: stg_slack__users.name
    semantic_role: categorical
    description: Username of the message author.
  - name: user_display_name
    expr: stg_slack__users.display_name
    semantic_role: categorical
    description: Display name of the message author.
  - name: subtype
    expr: stg_slack__messages.subtype
    semantic_role: categorical
    description: Message subtype for special messages like channel_join or bot_message.
  - name: text_length
    expr: LENGTH(stg_slack__messages.text)
    semantic_role: measure
    description: Character count of the message text.
  - name: is_thread_parent
    expr: stg_slack__messages.thread_ts = stg_slack__messages.ts
    semantic_role: categorical
    description: Whether this message is the parent of a thread.
  - name: reply_count
    expr: stg_slack__messages.reply_count
    semantic_role: measure
    description: Number of replies in the thread if this is a parent message.
  - name: reply_users_count
    expr: stg_slack__messages.reply_users_count
    semantic_role: measure
    description: Number of unique users who replied in the thread.
  - name: reactions_count
    expr: stg_slack__messages.reactions_count
    semantic_role: measure
    description: Number of distinct emoji reactions on this message.
  - name: attachments_count
    expr: stg_slack__messages.attachments_count
    semantic_role: measure
    description: Number of rich attachments on the message.
  - name: files_count
    expr: stg_slack__messages.files_count
    semantic_role: measure
    description: Number of files uploaded with this message.
  - name: bot_id
    expr: stg_slack__messages.bot_id
    semantic_role: entity_id
    description: Bot ID if the message was sent by a bot integration.
  - name: app_id
    expr: stg_slack__messages.app_id
    semantic_role: entity_id
    description: App ID if the message was sent by a Slack app.
tags:
  - slack
  - messages
trust_tier: gold
materialization:
  type: table

### slack\_\_users

spec_version: '0.2'
name: slack__users
type: model
description: User detail with profile information and role flags for Slack workspace members.
grain: user_id
source:
  ref: stg_slack__users
columns:
  - name: user_id
    expr: stg_slack__users.user_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Slack user identifier (e.g. U01ABC23DEF).
  - name: name
    expr: stg_slack__users.name
    semantic_role: categorical
    description: Username (handle) without the @ prefix.
  - name: display_name
    expr: stg_slack__users.display_name
    semantic_role: categorical
    description: Display name chosen by the user.
  - name: real_name
    expr: stg_slack__users.real_name
    semantic_role: categorical
    description: Full real name from the user profile.
  - name: email
    expr: stg_slack__users.email
    semantic_role: categorical
    tags:
      - pii
    description: Email address from the user profile.
  - name: title
    expr: stg_slack__users.title
    semantic_role: categorical
    description: Job title from the user profile.
  - name: is_bot
    expr: stg_slack__users.is_bot
    semantic_role: categorical
    description: Whether this is a bot user.
  - name: is_admin
    expr: stg_slack__users.is_admin
    semantic_role: categorical
    description: Whether the user has workspace admin privileges.
  - name: is_owner
    expr: stg_slack__users.is_owner
    semantic_role: categorical
    description: Whether the user is a workspace owner.
  - name: is_restricted
    expr: stg_slack__users.is_restricted
    semantic_role: categorical
    description: Whether the user is a multi-channel guest.
  - name: is_ultra_restricted
    expr: stg_slack__users.is_ultra_restricted
    semantic_role: categorical
    description: Whether the user is a single-channel guest.
  - name: is_deleted
    expr: stg_slack__users.deleted_at
    semantic_role: categorical
    description: Whether the user has been deactivated.
  - name: team_id
    expr: stg_slack__users.team_id
    semantic_role: entity_id
    description: Workspace team ID this user belongs to.
  - name: tz
    expr: stg_slack__users.tz
    semantic_role: categorical
    description: IANA timezone identifier for the user.
  - name: updated_at
    expr: stg_slack__users.updated_at
    semantic_role: event_timestamp
    description: Timestamp when the user profile was last updated.
tags:
  - slack
  - users
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: slack_top_level_message_count
description: Number of top-level Slack messages returned by conversation history. Thread replies are excluded.
model: slack__messages
expression: COUNT({slack__messages}.message_ts)
synonyms: [top-level messages, channel posts, Slack conversation history messages]
tags: [slack, collaboration, messages]
spec_version: '0.2'
type: metric
name: slack_reply_count
description: Total replies recorded on Slack messages.
model: slack__messages
expression: SUM({slack__messages}.reply_count)
synonyms: [replies, thread replies, reply volume]
tags: [slack, collaboration, threads]
spec_version: '0.2'
type: metric
name: slack_active_channel_count
description: Number of Slack channels that are not archived.
model: slack__channels
expression: SUM(CASE WHEN {slack__channels}.is_archived THEN 0 ELSE 1 END)
synonyms: [active channels, open channels, current channels]
tags: [slack, collaboration, channels]

## Relationships

spec_version: '0.2'
type: relationship
name: slack_messages_to_channels
description: Each Slack message belongs to one channel.
left_model: slack__messages
right_model: slack__channels
join_columns:
  - left: channel_id
    right: channel_id
join_type: left
relationship_type: many_to_one
tags: [slack, messages, channels]
spec_version: '0.2'
type: relationship
name: slack_messages_to_users
description: Each Slack message can belong to one user.
left_model: slack__messages
right_model: slack__users
join_columns:
  - left: user_id
    right: user_id
join_type: left
relationship_type: many_to_one
tags: [slack, messages, users]
