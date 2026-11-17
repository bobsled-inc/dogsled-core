---
name: starter-models-smartlead
description: Curated starter analytics models, metrics, and relationships for
  Smartlead outbound sales. Pairs with the starter-data-models overview; adapt
  the bundle to the user's actually-loaded tables.
---

# Starter data models — Smartlead

Outbound sales models for Smartlead campaigns, lead execution, and sender account capacity.

These are the **gold marts** for Smartlead — the canonical analytics
tables an analyst would build on top of the loaded Smartlead extract. Each
mart references a silver staging model named `stg_smartlead__<resource>`
through `source.ref`; you author those staging models (and their bronze
sources) from the user's loaded raw tables using the recipe in the
**`starter-data-models`** overview skill.

**Adapt before you ship.** Build only the slices for resources that were
actually extracted, prune any mart whose staging dependency is missing,
and trim columns whose staging field is absent. The `starter-data-models`
overview has the full build flow, naming conventions, and the
bronze/silver recipe — read it first.

## Marts

### smartlead\_\_campaign_lead_funnel

spec_version: '0.2'
name: smartlead__campaign_lead_funnel
type: model
description: Lead funnel by status showing volume at each stage.
grain: status
source:
  ref: stg_smartlead__campaign_leads
columns:
  - name: status
    expr: stg_smartlead__campaign_leads.status
    semantic_role: categorical
    description: Lead status in campaign (STARTED, INPROGRESS, COMPLETED, PAUSED, STOPPED).
  - name: lead_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of leads in this status.
group_by:
  - status
tags:
  - smartlead
  - leads
  - funnel
trust_tier: gold
materialization:
  type: table

### smartlead\_\_campaign_leads

spec_version: '0.2'
name: smartlead__campaign_leads
type: model
description: Lead enrollment detail for Smartlead campaigns.
grain: campaign_lead_map_id
source:
  ref: stg_smartlead__campaign_leads
columns:
  - name: campaign_lead_map_id
    expr: stg_smartlead__campaign_leads.campaign_lead_map_id
    primary_key: true
    semantic_role: entity_id
    description: Unique lead-to-campaign mapping identifier.
  - name: lead_id
    expr: stg_smartlead__campaign_leads.lead_id
    semantic_role: entity_id
    description: Lead identifier.
  - name: email
    expr: stg_smartlead__campaign_leads.email
    semantic_role: categorical
    tags:
      - pii
    description: Lead email address.
  - name: status
    expr: stg_smartlead__campaign_leads.status
    semantic_role: categorical
    description: Current campaign status for the lead.
  - name: company_name
    expr: stg_smartlead__campaign_leads.company_name
    semantic_role: categorical
    description: Company name associated with the lead.
  - name: is_unsubscribed
    expr: stg_smartlead__campaign_leads.is_unsubscribed
    semantic_role: categorical
    description: Whether the lead has unsubscribed globally.
  - name: created_at
    expr: stg_smartlead__campaign_leads.created_at
    semantic_role: event_timestamp
    description: Timestamp when the lead was added to the campaign.
tags:
  - smartlead
  - leads
trust_tier: gold
materialization:
  type: table

### smartlead\_\_campaign_statistics

spec_version: '0.2'
name: smartlead__campaign_statistics
type: model
description: Email send and engagement outcomes observed in Smartlead campaign statistics.
grain:
  - campaign_id
  - lead_email
  - sequence_number
source:
  ref: stg_smartlead__campaign_statistics
columns:
  - name: campaign_id
    expr: stg_smartlead__campaign_statistics.campaign_id
    semantic_role: entity_id
    description: Campaign that produced the statistics row.
  - name: lead_email
    expr: stg_smartlead__campaign_statistics.lead_email
    semantic_role: categorical
    tags:
      - pii
    description: Lead email address associated with the send.
  - name: sequence_number
    expr: stg_smartlead__campaign_statistics.sequence_number
    semantic_role: categorical
    description: Sequence position of the outbound email.
  - name: sent_time
    expr: stg_smartlead__campaign_statistics.sent_time
    semantic_role: event_timestamp
    description: Timestamp when the email was sent.
  - name: is_opened
    expr: stg_smartlead__campaign_statistics.is_opened
    semantic_role: categorical
    description: Whether the email was opened.
  - name: is_clicked
    expr: stg_smartlead__campaign_statistics.is_clicked
    semantic_role: categorical
    description: Whether the email recorded a click.
  - name: is_replied
    expr: stg_smartlead__campaign_statistics.is_replied
    semantic_role: categorical
    description: Whether the lead replied to the email.
  - name: is_bounced
    expr: stg_smartlead__campaign_statistics.is_bounced
    semantic_role: categorical
    description: Whether the email bounced.
tags:
  - smartlead
  - engagement
trust_tier: gold
materialization:
  type: table

### smartlead\_\_campaigns

spec_version: '0.2'
name: smartlead__campaigns
type: model
description: Campaign configuration detail for Smartlead outbound campaigns.
grain: campaign_id
source:
  ref: stg_smartlead__campaigns
columns:
  - name: campaign_id
    expr: stg_smartlead__campaigns.campaign_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Smartlead campaign identifier.
  - name: name
    expr: stg_smartlead__campaigns.name
    semantic_role: categorical
    description: Campaign name.
  - name: status
    expr: stg_smartlead__campaigns.status
    semantic_role: categorical
    description: Campaign lifecycle status.
  - name: max_leads_per_day
    expr: stg_smartlead__campaigns.max_leads_per_day
    semantic_role: measure
    description: Maximum leads the campaign can contact per day.
  - name: follow_up_percentage
    expr: stg_smartlead__campaigns.follow_up_percentage
    semantic_role: measure
    description: Configured follow-up percentage for the campaign.
  - name: created_at
    expr: stg_smartlead__campaigns.created_at
    semantic_role: event_timestamp
    description: Timestamp when the campaign was created.
tags:
  - smartlead
  - campaigns
trust_tier: gold
materialization:
  type: table

### smartlead\_\_email_account_capacity

spec_version: '0.2'
name: smartlead__email_account_capacity
type: model
description: Sender capacity summary grouped by account type and warmup status.
grain:
  - type
  - warmup_status
source:
  ref: stg_smartlead__email_accounts
columns:
  - name: type
    expr: stg_smartlead__email_accounts.type
    semantic_role: categorical
    description: Account provider type.
  - name: warmup_status
    expr: stg_smartlead__email_accounts.warmup_status
    semantic_role: categorical
    description: Warmup status grouping.
  - name: account_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of email accounts in the bucket.
  - name: total_daily_capacity
    expr: SUM(stg_smartlead__email_accounts.message_per_day)
    semantic_role: measure
    description: Total configured daily send capacity in the bucket.
  - name: total_daily_sent
    expr: SUM(stg_smartlead__email_accounts.daily_sent_count)
    semantic_role: measure
    description: Total emails already sent today in the bucket.
group_by:
  - type
  - warmup_status
tags:
  - smartlead
  - capacity
trust_tier: gold
materialization:
  type: table

### smartlead\_\_email_account_performance

spec_version: '0.2'
name: smartlead__email_account_performance
type: model
description: Email account performance with warmup health and sending capacity.
grain: email_account_id
source:
  ref: stg_smartlead__email_accounts
columns:
  - name: email_account_id
    expr: stg_smartlead__email_accounts.email_account_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Smartlead email account identifier.
  - name: from_email
    expr: stg_smartlead__email_accounts.from_email
    semantic_role: categorical
    tags:
      - pii
    description: Sender email address.
  - name: type
    expr: stg_smartlead__email_accounts.type
    semantic_role: categorical
    description: Account provider type (GMAIL, OUTLOOK, SMTP).
  - name: message_per_day
    expr: stg_smartlead__email_accounts.message_per_day
    semantic_role: measure
    description: Configured daily sending limit.
  - name: daily_sent_count
    expr: stg_smartlead__email_accounts.daily_sent_count
    semantic_role: measure
    description: Emails sent today.
  - name: campaign_count
    expr: stg_smartlead__email_accounts.campaign_count
    semantic_role: measure
    description: Number of campaigns using this account.
  - name: is_smtp_success
    expr: stg_smartlead__email_accounts.is_smtp_success
    semantic_role: categorical
    description: Whether SMTP connection is successful.
  - name: is_imap_success
    expr: stg_smartlead__email_accounts.is_imap_success
    semantic_role: categorical
    description: Whether IMAP connection is successful.
  - name: warmup_status
    expr: stg_smartlead__email_accounts.warmup_status
    semantic_role: categorical
    description: Email warmup status (ACTIVE, INACTIVE).
  - name: warmup_reputation
    expr: stg_smartlead__email_accounts.warmup_reputation
    semantic_role: categorical
    description: Warmup reputation score.
  - name: warmup_total_sent
    expr: stg_smartlead__email_accounts.warmup_total_sent
    semantic_role: measure
    description: Total warmup emails sent.
  - name: warmup_spam_count
    expr: stg_smartlead__email_accounts.warmup_spam_count
    semantic_role: measure
    description: Total warmup emails marked as spam.
  - name: created_at
    expr: stg_smartlead__email_accounts.created_at
    semantic_role: event_timestamp
    description: When the account was created.
tags:
  - smartlead
  - email-accounts
  - performance
trust_tier: gold
materialization:
  type: table

### smartlead\_\_email_accounts

spec_version: '0.2'
name: smartlead__email_accounts
type: model
description: Sender account detail for Smartlead email accounts.
grain: email_account_id
source:
  ref: stg_smartlead__email_accounts
columns:
  - name: email_account_id
    expr: stg_smartlead__email_accounts.email_account_id
    primary_key: true
    semantic_role: entity_id
    description: Unique Smartlead email account identifier.
  - name: from_name
    expr: stg_smartlead__email_accounts.from_name
    semantic_role: categorical
    description: Sender display name.
  - name: from_email
    expr: stg_smartlead__email_accounts.from_email
    semantic_role: categorical
    tags:
      - pii
    description: Sender email address.
  - name: type
    expr: stg_smartlead__email_accounts.type
    semantic_role: categorical
    description: Account provider type.
  - name: campaign_count
    expr: stg_smartlead__email_accounts.campaign_count
    semantic_role: measure
    description: Number of campaigns using the account.
  - name: message_per_day
    expr: stg_smartlead__email_accounts.message_per_day
    semantic_role: measure
    description: Configured daily sending limit.
  - name: daily_sent_count
    expr: stg_smartlead__email_accounts.daily_sent_count
    semantic_role: measure
    description: Emails already sent today by the account.
  - name: warmup_status
    expr: stg_smartlead__email_accounts.warmup_status
    semantic_role: categorical
    description: Warmup status for the sender account.
  - name: warmup_total_sent
    expr: stg_smartlead__email_accounts.warmup_total_sent
    semantic_role: measure
    description: Total warmup emails sent by the account.
tags:
  - smartlead
  - email-accounts
trust_tier: gold
materialization:
  type: table

### smartlead\_\_lead_status_summary

spec_version: '0.2'
name: smartlead__lead_status_summary
type: model
description: Lead count summary grouped by campaign lead status and unsubscribe state.
grain:
  - status
  - is_unsubscribed
source:
  ref: stg_smartlead__campaign_leads
columns:
  - name: status
    expr: stg_smartlead__campaign_leads.status
    primary_key: true
    semantic_role: categorical
    description: Campaign lead status bucket.
  - name: is_unsubscribed
    expr: stg_smartlead__campaign_leads.is_unsubscribed
    primary_key: true
    semantic_role: categorical
    description: Whether leads in the bucket have unsubscribed.
  - name: lead_count
    expr: COUNT(*)
    semantic_role: measure
    description: Number of campaign leads in the bucket.
group_by:
  - status
  - is_unsubscribed
tags:
  - smartlead
  - leads
  - summary
trust_tier: gold
materialization:
  type: table

## Metrics

spec_version: '0.2'
type: metric
name: smartlead_campaign_lead_count
description: Number of Smartlead campaign lead mappings.
model: smartlead__campaign_leads
expression: COUNT({smartlead__campaign_leads}.campaign_lead_map_id)
synonyms: [campaign leads, enrolled leads, lead count]
tags: [smartlead, outbound, leads]
spec_version: '0.2'
type: metric
name: smartlead_opened_sequence_count
description: Number of Smartlead campaign sequence records marked as opened.
model: smartlead__campaign_statistics
expression: SUM(CASE WHEN {smartlead__campaign_statistics}.is_opened THEN 1 ELSE 0 END)
synonyms: [email opens, opened emails, opened sequences]
tags: [smartlead, outbound, engagement]
spec_version: '0.2'
type: metric
name: smartlead_replied_sequence_count
description: Number of Smartlead campaign sequence records marked as replied.
model: smartlead__campaign_statistics
expression: SUM(CASE WHEN {smartlead__campaign_statistics}.is_replied THEN 1 ELSE 0 END)
synonyms: [email replies, replied emails, reply count]
tags: [smartlead, outbound, engagement]

## Relationships

spec_version: '0.2'
type: relationship
name: smartlead_email_account_performance_to_accounts
description: Each Smartlead email account performance row summarizes one email account.
left_model: smartlead__email_account_performance
right_model: smartlead__email_accounts
join_columns:
  - left: email_account_id
    right: email_account_id
join_type: left
relationship_type: one_to_one
tags: [smartlead, email-accounts, performance]
spec_version: '0.2'
type: relationship
name: smartlead_campaign_leads_to_status_summary
description: Each Smartlead campaign lead contributes to one status and unsubscribe summary row.
left_model: smartlead__campaign_leads
right_model: smartlead__lead_status_summary
join_columns:
  - left: status
    right: status
  - left: is_unsubscribed
    right: is_unsubscribed
join_type: left
relationship_type: many_to_one
tags: [smartlead, leads, status]
