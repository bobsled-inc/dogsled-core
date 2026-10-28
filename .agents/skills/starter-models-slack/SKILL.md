---
name: starter-models-slack
description: Curated starter analytics models, metrics, and relationships for Slack collaboration. Pairs with the starter-data-models overview; adapt the bundle to the user's actually-loaded tables.
exposed: true
triggers:
  - slack starter models
  - prebuilt slack models
  - curated slack analytics models
  - standard slack data models
  - build slack marts
  - Slack analytics shape
  - models for slack
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

{{include: packages/models/marts/slack/slack__channel_activity_summary.yml}}

### slack\_\_channels

{{include: packages/models/marts/slack/slack__channels.yml}}

### slack\_\_messages

{{include: packages/models/marts/slack/slack__messages.yml}}

### slack\_\_users

{{include: packages/models/marts/slack/slack__users.yml}}

## Metrics

{{include: packages/models/marts/slack/metrics/slack_top_level_message_count.yml}}
{{include: packages/models/marts/slack/metrics/slack_reply_count.yml}}
{{include: packages/models/marts/slack/metrics/slack_active_channel_count.yml}}

## Relationships

{{include: packages/models/marts/slack/relationships/slack_messages_to_channels.yml}}
{{include: packages/models/marts/slack/relationships/slack_messages_to_users.yml}}
